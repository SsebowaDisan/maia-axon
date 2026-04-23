"""
WebSocket endpoint for streaming chat responses.

Protocol:
  Client → Server: { type: "query", project_id?, group_id?, document_ids?, mode, message }
  Server → Client: { type: "status", status: "retrieving" | "reasoning" | "calculating" }
  Server → Client: { type: "token", content: "..." }
  Server → Client: { type: "citations", data: [...] }
  Server → Client: { type: "mindmap", data: {...} }
  Server → Client: { type: "done" }
  Server → Client: { type: "error", message: "..." }
"""
import json
import logging
from uuid import UUID

import openai
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.database import async_session
from app.core.security import decode_access_token
from app.models.company import Company, CompanyUser
from app.models.conversation import Conversation, Message
from app.models.group import GroupAssignment
from app.models.project import Project
from app.models.user import User
from app.services.answer_engine import (
    AnswerResponse,
    AnswerSection,
    _build_citations,
    _build_mindmap,
    _format_sources_for_prompt,
    axon_group_agent,
    classify_axon_group_question,
    classify_intent,
    classify_identity_question,
    calculation_agent,
    clarification_agent,
    ensure_inline_citation_references,
    generate_conversation_metadata,
    identity_agent,
    is_structural_listing_sources,
    language_instruction_for_query,
    structural_listing_agent,
)
from app.services.google_marketing import generate_ga4_answer, generate_google_ads_answer
from app.services.prompt_attachments import build_attachment_context, load_prompt_attachment
from app.services.retrieval import deep_search, library_search

logger = logging.getLogger(__name__)
GOOGLE_MODES = {"google_analytics", "google_ads"}
DOCUMENT_MODES = {"library", "deep_search"}

router = APIRouter()

STRUCTURED_RESPONSE_GUIDANCE = (
    "Always answer in the same natural language the user used in the current question, unless the user explicitly asks for translation or another language. "
    "Write polished Markdown with the voice of a mathematician, scientist, and engineer. "
    "Be precise, analytical, technically disciplined, and professionally explanatory. "
    "Make assumptions explicit, respect units and definitions, and prefer defensible reasoning over casual phrasing. "
    "Default to depth unless the user explicitly asks for brevity. "
    "Start with a short direct answer. "
    "Then use clear sections when helpful, such as ## Answer, ## Key Points, "
    "## Explanation, ## Example, ## Calculation, ## Notes, or ## Next Step. "
    "After the direct answer, explain the idea in enough detail that a serious user understands "
    "what it is, how it works, why it matters, and where it applies. "
    "Do not stop at naming items; explain each item with at least one concrete detail, implication, or example. "
    "Prefer short paragraphs and flat bullet lists over long prose, but keep the content substantive. "
    "Keep the response scannable, similar to a high-quality assistant answer. "
    "When the sources or the question contain formulas, units, numeric values, engineering relationships, "
    "or any quantitative concept, include a short worked example, quick check, sanity check, or mini-calculation "
    "even if the user did not explicitly ask for one. "
    "If exact values are not available, provide a clearly labeled illustrative example and say it is illustrative. "
    "Do not invent document facts or citations. "
    "Attach inline citations as [N] immediately after the factual sentence or clause they support."
)


async def _authenticate_ws(websocket: WebSocket) -> User | None:
    """Authenticate WebSocket connection via token in query params or first message."""
    token = websocket.query_params.get("token")
    if not token:
        return None

    user_id = decode_access_token(token)
    if not user_id:
        return None

    async with async_session() as db:
        result = await db.execute(select(User).where(User.id == UUID(user_id)))
        return result.scalar_one_or_none()


def _serialize_citation(cite) -> dict:
    return {
        "id": cite.id,
        "source_type": cite.source_type,
        "document_id": str(cite.document_id) if cite.document_id else None,
        "document_name": cite.document_name,
        "page": cite.page,
        "bbox": cite.bbox,
        "boxes": cite.boxes,
        "snippet": cite.snippet,
        "url": cite.url,
        "title": cite.title,
    }


def _ensure_conversation_metadata(conversation: Conversation, query: str, mode: str) -> None:
    if conversation.title and conversation.title_icon:
        return

    title, icon = generate_conversation_metadata(query, mode)
    conversation.title = title
    conversation.title_icon = icon


def _serialize_mindmap(node) -> dict:
    result = {
        "id": node.id,
        "label": node.label,
        "node_type": node.node_type,
        "children": [_serialize_mindmap(c) for c in node.children],
    }
    if node.source:
        result["source"] = _serialize_citation(node.source)
    return result


async def _persist_assistant_message(
    db: AsyncSession,
    conversation: Conversation,
    query: str,
    mode: str,
    content: str,
    citations: list[dict] | None = None,
    visualizations: list[dict] | None = None,
    mindmap: dict | None = None,
) -> None:
    assistant_msg = Message(
        conversation_id=conversation.id,
        role="assistant",
        content=content,
        citations={"citations": citations or []},
        visualizations=visualizations or [],
        mindmap=mindmap,
        search_mode=mode,
    )
    _ensure_conversation_metadata(conversation, query, mode)
    db.add(assistant_msg)
    await db.commit()


def _build_user_content(text: str, image_parts: list[dict]) -> str | list[dict]:
    if not image_parts:
        return text
    return [{"type": "text", "text": text}, *image_parts]


@router.websocket("/ws/chat")
async def websocket_chat(websocket: WebSocket):
    await websocket.accept()

    # Authenticate
    user = await _authenticate_ws(websocket)
    if not user:
        await websocket.send_json({"type": "error", "message": "Authentication failed"})
        await websocket.close()
        return

    try:
        while True:
            # Wait for query
            data = await websocket.receive_json()

            if data.get("type") != "query":
                await websocket.send_json({"type": "error", "message": "Expected type: query"})
                continue

            group_id = UUID(data["group_id"]) if data.get("group_id") else None
            company_id = UUID(data["company_id"]) if data.get("company_id") else None
            project_id = UUID(data["project_id"]) if data.get("project_id") else None
            document_ids = [UUID(d) for d in data.get("document_ids", [])] or None
            attachment_ids = data.get("attachment_ids", []) or []
            mode = data.get("mode", "library")
            message = data["message"]
            conversation_id = UUID(data["conversation_id"]) if data.get("conversation_id") else None

            async with async_session() as db:
                if project_id is None:
                    await websocket.send_json(
                        {"type": "error", "message": "Project is required"}
                    )
                    continue

                project = await db.scalar(
                    select(Project).where(Project.id == project_id, Project.user_id == user.id)
                )
                if project is None:
                    await websocket.send_json(
                        {"type": "error", "message": "Project not found"}
                    )
                    continue

                if mode in DOCUMENT_MODES and group_id is None:
                    await websocket.send_json(
                        {"type": "error", "message": "Group is required for grounded chat"}
                    )
                    continue
                if mode in GOOGLE_MODES and company_id is None:
                    await websocket.send_json(
                        {"type": "error", "message": "Company is required for Google data chat"}
                    )
                    continue

                # Verify group access
                if group_id and not user.is_admin:
                    result = await db.execute(
                        select(GroupAssignment).where(
                            GroupAssignment.group_id == group_id,
                            GroupAssignment.user_id == user.id,
                        )
                    )
                    if result.scalar_one_or_none() is None:
                        await websocket.send_json(
                            {"type": "error", "message": "No access to this group"}
                        )
                        continue

                company = None
                if mode in GOOGLE_MODES:
                    if user.is_admin:
                        company = await db.scalar(select(Company).where(Company.id == company_id))
                    else:
                        company = await db.scalar(
                            select(Company)
                            .join(CompanyUser, CompanyUser.company_id == Company.id)
                            .where(Company.id == company_id, CompanyUser.user_id == user.id)
                        )
                    if company is None:
                        await websocket.send_json(
                            {"type": "error", "message": "No access to this company"}
                        )
                        continue

                # Get or create conversation
                if conversation_id:
                    result = await db.execute(
                        select(Conversation)
                        .options(selectinload(Conversation.messages))
                        .where(
                            Conversation.id == conversation_id,
                            Conversation.user_id == user.id,
                        )
                    )
                    conversation = result.scalar_one_or_none()
                else:
                    conversation = None

                if conversation is None:
                    conversation = Conversation(
                        user_id=user.id,
                        project_id=project_id,
                        group_id=group_id,
                    )
                    db.add(conversation)
                    await db.flush()

                conversation.project_id = project_id
                conversation.group_id = group_id

                # Save user message
                user_msg = Message(
                    conversation_id=conversation.id,
                    role="user",
                    content=message,
                    search_mode=mode,
                )
                db.add(user_msg)
                await db.flush()

                # Get conversation history
                result = await db.execute(
                    select(Message)
                    .where(Message.conversation_id == conversation.id)
                    .order_by(Message.created_at)
                )
                history = [{"role": m.role, "content": m.content} for m in result.scalars().all()]
                attachments = [
                    load_prompt_attachment(attachment_id, user.id)
                    for attachment_id in attachment_ids
                ]
                attachment_context, attachment_image_parts, _ = build_attachment_context(attachments)
                effective_message = message
                if attachment_context:
                    effective_message = (
                        f"{message}\n\n"
                        "The user attached files for direct analysis. Treat the attached material as first-class input.\n\n"
                        f"{attachment_context}"
                    )

                if classify_axon_group_question(message):
                    await websocket.send_json({"type": "status", "status": "reasoning"})
                    answer = axon_group_agent(message, history)
                    answer.mindmap = _build_mindmap(answer)

                    await websocket.send_json({"type": "token", "content": answer.text})
                    citations = [_serialize_citation(c) for c in answer.citations]
                    await websocket.send_json({"type": "citations", "data": citations})
                    await websocket.send_json({"type": "visualizations", "data": answer.visualizations})
                    await websocket.send_json({
                        "type": "mindmap",
                        "data": _serialize_mindmap(answer.mindmap),
                    })
                    await _persist_assistant_message(
                        db,
                        conversation,
                        message,
                        mode,
                        answer.text,
                        citations,
                        answer.visualizations,
                        _serialize_mindmap(answer.mindmap),
                    )
                    await websocket.send_json({"type": "done", "conversation_id": str(conversation.id)})
                    continue

                if classify_identity_question(message):
                    await websocket.send_json({"type": "status", "status": "reasoning"})
                    answer = identity_agent(message, history)
                    answer.mindmap = _build_mindmap(answer)

                    await websocket.send_json({"type": "token", "content": answer.text})
                    await websocket.send_json({"type": "citations", "data": []})
                    await websocket.send_json({"type": "visualizations", "data": answer.visualizations})
                    await websocket.send_json({
                        "type": "mindmap",
                        "data": _serialize_mindmap(answer.mindmap),
                    })
                    await _persist_assistant_message(
                        db,
                        conversation,
                        message,
                        mode,
                        answer.text,
                        [],
                        answer.visualizations,
                        _serialize_mindmap(answer.mindmap),
                    )
                    await websocket.send_json({"type": "done", "conversation_id": str(conversation.id)})
                    continue

                if mode in GOOGLE_MODES:
                    await websocket.send_json({"type": "status", "status": "reasoning"})
                    if mode == "google_analytics":
                        answer = generate_ga4_answer(effective_message, company)
                    else:
                        answer = generate_google_ads_answer(effective_message, company)
                    answer.mindmap = _build_mindmap(answer)

                    await websocket.send_json({"type": "token", "content": answer.text})
                    await websocket.send_json({"type": "citations", "data": []})
                    await websocket.send_json({"type": "visualizations", "data": answer.visualizations})
                    await websocket.send_json({
                        "type": "mindmap",
                        "data": _serialize_mindmap(answer.mindmap),
                    })
                    await _persist_assistant_message(
                        db,
                        conversation,
                        message,
                        mode,
                        answer.text,
                        [],
                        answer.visualizations,
                        _serialize_mindmap(answer.mindmap),
                    )
                    await websocket.send_json({"type": "done", "conversation_id": str(conversation.id)})
                    continue

                if mode == "standard":
                    await websocket.send_json({"type": "status", "status": "reasoning"})

                    client = openai.OpenAI(api_key=settings.openai_api_key)
                    full_text = ""
                    language_instruction = language_instruction_for_query(message)

                    messages = history[-10:]
                    messages.insert(0, {
                        "role": "system",
                        "content": (
                            "You are Maia Axon, a precise technical assistant. Respond directly "
                            "with the voice of a mathematician, scientist, and engineer. "
                            f"{language_instruction} "
                            "to the user. This mode does not use retrieval, so do not invent citations. "
                            "Use polished Markdown. Default to detailed explanations unless the user asks for brevity. "
                            "Start with a direct answer, then explain the concept in depth: what it is, how it works, "
                            "why it matters, common applications, limitations, and practical implications when relevant. "
                            "Do not give shallow label-only bullet lists. "
                            "Use sections or bullets when they improve clarity. "
                            "When the topic supports it, include a short worked example, mini-calculation, "
                            "or practical numeric illustration even if the user did not explicitly request one. "
                            "If the example is illustrative rather than derived from user-provided values, label it clearly."
                        ),
                    })
                    if not history or history[-1]["role"] != "user" or history[-1]["content"] != message:
                        messages.append({"role": "user", "content": _build_user_content(effective_message, attachment_image_parts)})
                    elif attachment_context or attachment_image_parts:
                        messages[-1] = {"role": "user", "content": _build_user_content(effective_message, attachment_image_parts)}

                    stream = client.chat.completions.create(
                        model="gpt-4o",
                        max_tokens=4096,
                        messages=messages,
                        stream=True,
                    )
                    for chunk in stream:
                        delta = chunk.choices[0].delta if chunk.choices else None
                        if delta and delta.content:
                            full_text += delta.content
                            await websocket.send_json({"type": "token", "content": delta.content})

                    mindmap = _build_mindmap(
                        AnswerResponse(
                            text=full_text,
                            sections=[
                                AnswerSection(type="explanation", content=full_text, grounded=False)
                            ],
                            citations=[],
                        )
                    )

                    await websocket.send_json({"type": "citations", "data": []})
                    await websocket.send_json({"type": "visualizations", "data": []})
                    await websocket.send_json({"type": "mindmap", "data": _serialize_mindmap(mindmap)})
                    await _persist_assistant_message(
                        db,
                        conversation,
                        message,
                        mode,
                        full_text,
                        [],
                        [],
                        _serialize_mindmap(mindmap),
                    )
                    await websocket.send_json({"type": "done", "conversation_id": str(conversation.id)})
                    continue

                # --- Stage 1: Retrieval ---
                await websocket.send_json({"type": "status", "status": "retrieving"})

                if mode == "deep_search":
                    retrieval = await deep_search(db, effective_message, group_id, document_ids)
                else:
                    retrieval = await library_search(db, effective_message, group_id, document_ids)

                sources = retrieval.results

                if not sources:
                    no_sources_text = "I couldn't find relevant information in the selected group's documents."
                    await websocket.send_json({
                        "type": "token",
                        "content": no_sources_text,
                    })
                    await websocket.send_json({"type": "visualizations", "data": []})
                    await _persist_assistant_message(
                        db,
                        conversation,
                        message,
                        mode,
                        no_sources_text,
                        [],
                        [],
                        None,
                    )
                    await websocket.send_json({"type": "done", "conversation_id": str(conversation.id)})
                    continue

                if is_structural_listing_sources(sources):
                    answer = structural_listing_agent(sources)
                    citations = [_serialize_citation(c) for c in answer.citations]
                    answer.mindmap = _build_mindmap(answer)

                    await websocket.send_json({"type": "status", "status": "reasoning"})
                    await websocket.send_json({"type": "token", "content": answer.text})
                    await websocket.send_json({"type": "citations", "data": citations})
                    await websocket.send_json({"type": "visualizations", "data": answer.visualizations})
                    await websocket.send_json({
                        "type": "mindmap",
                        "data": _serialize_mindmap(answer.mindmap),
                    })
                    await _persist_assistant_message(
                        db,
                        conversation,
                        message,
                        mode,
                        answer.text,
                        citations,
                        answer.visualizations,
                        _serialize_mindmap(answer.mindmap),
                    )
                    await websocket.send_json({"type": "done", "conversation_id": str(conversation.id)})
                    continue

                # --- Stage 2: Intent Classification ---
                await websocket.send_json({"type": "status", "status": "reasoning"})
                intent = classify_intent(effective_message, sources)

                # --- Stage 3: Handle non-streaming agents (calc, clarification) ---
                if intent == "ambiguous":
                    answer = clarification_agent(effective_message, sources)
                    citations = [_serialize_citation(c) for c in answer.citations]
                    await websocket.send_json({
                        "type": "token",
                        "content": answer.text,
                    })
                    await websocket.send_json({"type": "citations", "data": citations})
                    await websocket.send_json({"type": "visualizations", "data": answer.visualizations})
                    answer.mindmap = _build_mindmap(answer)
                    await websocket.send_json({
                        "type": "mindmap",
                        "data": _serialize_mindmap(answer.mindmap),
                    })
                    await _persist_assistant_message(
                        db,
                        conversation,
                        message,
                        mode,
                        answer.text,
                        citations,
                        answer.visualizations,
                        _serialize_mindmap(answer.mindmap),
                    )
                    await websocket.send_json({"type": "done", "conversation_id": str(conversation.id)})
                    continue

                if intent == "calculation":
                    await websocket.send_json({"type": "status", "status": "calculating"})
                    answer = calculation_agent(effective_message, sources, history)

                    # Send full calculation answer
                    await websocket.send_json({"type": "token", "content": answer.text})

                    citations = [_serialize_citation(c) for c in answer.citations]
                    await websocket.send_json({"type": "citations", "data": citations})
                    await websocket.send_json({"type": "visualizations", "data": answer.visualizations})

                    if answer.mindmap:
                        await websocket.send_json({
                            "type": "mindmap",
                            "data": _serialize_mindmap(answer.mindmap),
                        })

                    if answer.warnings:
                        await websocket.send_json({"type": "warnings", "data": answer.warnings})

                    await _persist_assistant_message(
                        db,
                        conversation,
                        message,
                        mode,
                        answer.text,
                        citations,
                        answer.visualizations,
                        _serialize_mindmap(answer.mindmap) if answer.mindmap else None,
                    )
                    await websocket.send_json({"type": "done", "conversation_id": str(conversation.id)})
                    continue

                # --- Stage 4: Streaming Q&A ---
                citations_list = _build_citations(sources)
                sources_text = _format_sources_for_prompt(sources)
                language_instruction = language_instruction_for_query(message)

                messages = history[-10:] + [{
                    "role": "user",
                    "content": _build_user_content(
                        (
                        f"Answer the following question using the provided sources.\n\n"
                        f"SOURCES:\n{sources_text}\n\n"
                        f"QUESTION: {message}\n\n"
                        f"{attachment_context + chr(10) + chr(10) if attachment_context else ''}"
                        "RULES:\n"
                        f"0. {language_instruction}\n"
                        "1. Ground your answer in the sources. Cite inline as [N].\n"
                        "2. If you use knowledge not from the sources, clearly mark it.\n"
                        "3. If multiple sources differ, present both.\n"
                        "4. If a source has LOW OCR CONFIDENCE, warn the user.\n"
                        "5. Be thorough and practically useful, not minimal.\n"
                        "6. Explain ideas, not just labels. For each major point, add concrete detail, mechanism, implication, or example.\n"
                        "7. If the topic supports it, add a short worked example, quick estimate, unit check, or mini-calculation.\n"
                        "8. Unless the user asks for a short answer, prefer a fuller explanation over a terse list.\n"
                        f"9. {STRUCTURED_RESPONSE_GUIDANCE}"
                        ),
                        attachment_image_parts,
                    ),
                }]

                # Stream with OpenAI
                client = openai.OpenAI(api_key=settings.openai_api_key)
                full_text = ""

                # Prepend system message
                messages.insert(0, {
                    "role": "system",
                    "content": (
                        "You are Maia Axon, a technical document assistant. Answer using "
                        "uploaded PDFs as primary source. Always cite with inline [N]. "
                        f"{language_instruction} "
                        "Always sound like a mathematician, scientist, and engineer: precise, rigorous, and technically grounded. "
                        "Look for chances to make the answer more useful with a compact example, quick calculation, "
                        "or engineering sanity check when the material supports it. "
                        f"{STRUCTURED_RESPONSE_GUIDANCE}"
                    ),
                })

                stream = client.chat.completions.create(
                    model="gpt-4o",
                    max_tokens=4096,
                    messages=messages,
                    stream=True,
                )
                for chunk in stream:
                    delta = chunk.choices[0].delta if chunk.choices else None
                    if delta and delta.content:
                        full_text += delta.content
                        await websocket.send_json({"type": "token", "content": delta.content})

                final_text = ensure_inline_citation_references(full_text, citations_list)
                if final_text != full_text:
                    await websocket.send_json({"type": "token", "content": final_text[len(full_text):]})
                    full_text = final_text

                # Send citations
                citations = [_serialize_citation(c) for c in citations_list]
                await websocket.send_json({"type": "citations", "data": citations})

                # Build and send mindmap
                answer = AnswerResponse(
                    text=full_text,
                    sections=[AnswerSection(type="explanation", content=full_text, grounded=True)],
                    citations=citations_list,
                )
                await websocket.send_json({"type": "visualizations", "data": answer.visualizations})
                mindmap = _build_mindmap(answer)
                await websocket.send_json({"type": "mindmap", "data": _serialize_mindmap(mindmap)})

                # Warnings
                warnings = []
                for r in sources:
                    if r.ocr_confidence and r.ocr_confidence < 0.7:
                        warnings.append(
                            f"Source from {r.document_name} page {r.page_number} "
                            f"has low OCR confidence ({r.ocr_confidence:.0%})"
                        )
                if warnings:
                    await websocket.send_json({"type": "warnings", "data": warnings})

                await _persist_assistant_message(
                    db,
                    conversation,
                    message,
                    mode,
                    full_text,
                    citations,
                    answer.visualizations,
                    _serialize_mindmap(mindmap),
                )
                await websocket.send_json({"type": "done", "conversation_id": str(conversation.id)})

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for user {user.id}")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
