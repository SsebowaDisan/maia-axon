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
import asyncio
import json
import logging
from uuid import UUID

import openai
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import case, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.database import SyncSessionLocal, async_session
from app.core.security import decode_access_token
from app.models.company import Company
from app.models.conversation import Conversation, Message
from app.models.group import Group
from app.models.project import Project
from app.models.user import User
from app.services.answer_engine import (
    AnswerResponse,
    AnswerSection,
    _build_citations,
    _build_mindmap,
    _format_sources_for_prompt,
    _style_answer_response,
    assess_grounding_fit,
    axon_group_agent,
    ava_agent,
    classify_ava_question,
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
    not_in_document_agent,
    structural_listing_agent,
)
from app.services.concept_neighbors import find_neighbor_concepts
from app.services.google_marketing import generate_ga4_answer, generate_google_ads_answer
from app.services.learn_chat import (
    build_learn_system_prompt,
    build_open_learn_system_prompt,
    get_learn_chat_context,
)
from app.services.projects import ensure_default_project
from app.services.prompt_attachments import build_attachment_context, load_prompt_attachment
from app.services.retrieval import deep_search, library_search

logger = logging.getLogger(__name__)
GOOGLE_MODES = {"google_analytics", "google_ads"}
DOCUMENT_MODES = {"library", "deep_search", "learn"}

router = APIRouter()

STRUCTURED_RESPONSE_GUIDANCE = (
    "Always answer in the same natural language the user used in the current question, unless the user explicitly asks for translation or another language. "
    "Write polished Markdown with the voice of a mathematician, scientist, and engineer. "
    "Use sentence-style capitalization for Markdown headings and titles: capitalize only the first word and proper nouns, company names, product names, or acronyms. "
    "For example, write 'Core concept', 'How it works', and 'Data collection', not 'Core Concept', 'How It Works', or 'Data Collection'. "
    "Be precise, analytical, technically disciplined, and professionally explanatory. "
    "Make assumptions explicit, respect units and definitions, and prefer defensible reasoning over casual phrasing. "
    "Default to depth unless the user explicitly asks for brevity. "
    "Start with a short direct answer. "
    "Then use clear sections when helpful, such as ## Answer, ## Key points, "
    "## Explanation, ## Example, ## Calculation, ## Notes, or ## Next step. "
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


def _local_suggested_questions(local_scope: dict) -> list[str]:
    """Pull ``answer.suggested_questions`` from the calling frame if available.

    The WebSocket handler has many branches; some have an ``answer``
    AnswerResponse in scope, some don't (e.g. streaming-error fallbacks).
    Rather than thread an explicit argument through every ``done`` frame,
    each path lets us inspect its locals and return the suggestions when
    present, an empty list otherwise.
    """
    answer = local_scope.get("answer")
    if answer is None:
        return []
    raw = getattr(answer, "suggested_questions", None)
    if not raw:
        return []
    return [str(item) for item in raw if str(item).strip()][:5]


async def _persist_assistant_message(
    db: AsyncSession,
    conversation: Conversation,
    query: str,
    mode: str,
    content: str,
    citations: list[dict] | None = None,
    visualizations: list[dict] | None = None,
    mindmap: dict | None = None,
    suggested_questions: list[str] | None = None,
) -> None:
    assistant_msg = Message(
        conversation_id=conversation.id,
        role="assistant",
        content=content,
        citations={"citations": citations or []},
        visualizations=visualizations or [],
        mindmap=mindmap,
        suggested_questions=suggested_questions or None,
        search_mode=mode,
    )
    _ensure_conversation_metadata(conversation, query, mode)
    db.add(assistant_msg)
    await db.commit()


def _build_user_content(text: str, image_parts: list[dict]) -> str | list[dict]:
    if not image_parts:
        return text
    return [{"type": "text", "text": text}, *image_parts]


async def _send_pivot_and_done(
    websocket: WebSocket,
    db: AsyncSession,
    conversation: Conversation,
    query: str,
    mode: str,
    answer: AnswerResponse,
) -> None:
    """Stream a not-in-document pivot response over the WS in one
    shot and persist it. The pivot doesn't need streaming — it's
    short and produced by a single non-streaming call — so we send
    the whole text in one token frame for snappier perceived UX.

    The frontend reads ``needs_general_knowledge_optin`` from the
    done frame to render the "Answer anyway from general knowledge"
    pill below the message.
    """
    await websocket.send_json({"type": "token", "content": answer.text})
    await websocket.send_json({"type": "citations", "data": []})
    await websocket.send_json({"type": "visualizations", "data": []})
    await websocket.send_json({"type": "mindmap", "data": None})
    await _persist_assistant_message(
        db,
        conversation,
        query,
        mode,
        answer.text,
        [],
        [],
        None,
    )
    await websocket.send_json(
        {
            "type": "done",
            "conversation_id": str(conversation.id),
            "suggested_questions": [],
            "needs_general_knowledge_optin": True,
        }
    )


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
            include_dashboard = bool(data.get("include_dashboard"))
            conversation_id = UUID(data["conversation_id"]) if data.get("conversation_id") else None

            async with async_session() as db:
                if project_id is None:
                    project = await ensure_default_project(db, user)
                    project_id = project.id
                else:
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
                if mode == "learn" and not document_ids:
                    await websocket.send_json(
                        {"type": "error", "message": "Learn mode requires a document_id"}
                    )
                    continue
                if mode in GOOGLE_MODES and company_id is None:
                    await websocket.send_json(
                        {"type": "error", "message": "Company is required for Google data chat"}
                    )
                    continue

                if group_id:
                    group = await db.scalar(select(Group).where(Group.id == group_id))
                    if group is None:
                        await websocket.send_json(
                            {"type": "error", "message": "Group not found"}
                        )
                        continue

                company = None
                if mode in GOOGLE_MODES:
                    company = await db.scalar(select(Company).where(Company.id == company_id))
                    if company is None:
                        await websocket.send_json(
                            {"type": "error", "message": "Company not found"}
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
                    .order_by(
                        Message.created_at,
                        case(
                            (Message.role == "user", 0),
                            (Message.role == "assistant", 1),
                            else_=2,
                        ),
                        Message.id,
                    )
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

                if classify_ava_question(message, history):
                    await websocket.send_json({"type": "status", "status": "reasoning"})
                    answer = ava_agent(message, history)
                    answer = _style_answer_response(answer)
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
                        suggested_questions=getattr(answer, "suggested_questions", None) or None,
                    )
                    await websocket.send_json({"type": "done", "conversation_id": str(conversation.id), "suggested_questions": list(_local_suggested_questions(locals()))})
                    continue

                if classify_axon_group_question(message):
                    await websocket.send_json({"type": "status", "status": "reasoning"})
                    answer = axon_group_agent(message, history)
                    answer = _style_answer_response(answer)
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
                        suggested_questions=getattr(answer, "suggested_questions", None) or None,
                    )
                    await websocket.send_json({"type": "done", "conversation_id": str(conversation.id), "suggested_questions": list(_local_suggested_questions(locals()))})
                    continue

                if classify_identity_question(message):
                    await websocket.send_json({"type": "status", "status": "reasoning"})
                    answer = identity_agent(message, history)
                    answer = _style_answer_response(answer)
                    answer.mindmap = _build_mindmap(answer)

                    await websocket.send_json({"type": "token", "content": answer.text})
                    await websocket.send_json({"type": "citations", "data": []})
                    await websocket.send_json({"type": "visualizations", "data": answer.visualizations})
                    if answer.warnings:
                        await websocket.send_json({"type": "warnings", "data": answer.warnings})
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
                        suggested_questions=getattr(answer, "suggested_questions", None) or None,
                    )
                    await websocket.send_json({"type": "done", "conversation_id": str(conversation.id), "suggested_questions": list(_local_suggested_questions(locals()))})
                    continue

                if mode in GOOGLE_MODES:
                    await websocket.send_json({"type": "status", "status": "reasoning"})
                    if mode == "google_analytics":
                        answer = generate_ga4_answer(effective_message, company)
                    else:
                        answer = generate_google_ads_answer(effective_message, company)
                    answer = _style_answer_response(answer)
                    if not include_dashboard:
                        answer.visualizations = []
                    answer.mindmap = _build_mindmap(answer)

                    await websocket.send_json({"type": "token", "content": answer.text})
                    await websocket.send_json({"type": "citations", "data": []})
                    await websocket.send_json({"type": "visualizations", "data": answer.visualizations})
                    if answer.warnings:
                        await websocket.send_json({"type": "warnings", "data": answer.warnings})
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
                        suggested_questions=getattr(answer, "suggested_questions", None) or None,
                    )
                    await websocket.send_json({"type": "done", "conversation_id": str(conversation.id), "suggested_questions": list(_local_suggested_questions(locals()))})
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
                            "Use sentence-style capitalization for Markdown headings and short bold labels: write 'Core concept', 'How it works', and 'Data collection', not title case. "
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

                    answer = _style_answer_response(
                        AnswerResponse(
                            text=full_text,
                            sections=[AnswerSection(type="explanation", content=full_text, grounded=False)],
                            citations=[],
                        )
                    )
                    full_text = answer.text
                    await websocket.send_json({"type": "token", "content": full_text})
                    mindmap = _build_mindmap(answer)

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
                    await websocket.send_json({"type": "done", "conversation_id": str(conversation.id), "suggested_questions": list(_local_suggested_questions(locals()))})
                    continue

                # Learn mode: load the active path + section context if
                # one exists. When the user hasn't generated a path yet
                # we fall through with a generic tutor prompt instead of
                # forcing the diagnostic popup — the popup remains
                # available as an opt-in via the Learn dialog, but
                # everyday learn-mode questions don't require it.
                learn_ctx = None
                if mode == "learn":
                    def _load_learn_ctx():
                        sync_db = SyncSessionLocal()
                        try:
                            return get_learn_chat_context(
                                sync_db,
                                user_id=user.id,
                                document_id=document_ids[0],
                            )
                        finally:
                            sync_db.close()

                    learn_ctx = await asyncio.to_thread(_load_learn_ctx)
                    if learn_ctx is not None:
                        # Scope learn-mode retrieval to the path's document.
                        document_ids = [learn_ctx.document_id]

                # --- Stage 1: Retrieval ---
                await websocket.send_json({"type": "status", "status": "retrieving"})

                if mode == "deep_search":
                    retrieval = await deep_search(db, effective_message, group_id, document_ids)
                else:
                    retrieval = await library_search(db, effective_message, group_id, document_ids)

                sources = retrieval.results

                if not sources:
                    # Empty retrieval → not-in-document pivot. We try
                    # to surface the closest concepts the doc DOES
                    # cover so the user gets a useful next step
                    # instead of a dead end. ``document_ids`` is set
                    # for library/learn modes (the user picked which
                    # docs the chat is scoped to); when unset we fall
                    # back to a plain pivot with no neighbours.
                    neighbors = []
                    if document_ids:
                        try:
                            neighbors = await find_neighbor_concepts(
                                db,
                                query=message,
                                document_ids=document_ids,
                                limit=4,
                            )
                        except Exception as exc:  # noqa: BLE001
                            logger.warning("neighbor_concepts_failed: %s", exc)
                    primary_doc = None
                    if document_ids:
                        primary_doc = await db.scalar(
                            select(Document).where(Document.id == document_ids[0])
                        )
                    pivot = await asyncio.to_thread(
                        not_in_document_agent,
                        query=message,
                        document_title=(primary_doc.filename if primary_doc else None),
                        document_summary=None,
                        neighbor_concepts=neighbors,
                        fit=None,
                        related_sources=None,
                    )
                    pivot = _style_answer_response(pivot)
                    await _send_pivot_and_done(
                        websocket, db, conversation, message, mode, pivot
                    )
                    continue

                if is_structural_listing_sources(sources):
                    answer = structural_listing_agent(sources)
                    answer = _style_answer_response(answer)
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
                        suggested_questions=getattr(answer, "suggested_questions", None) or None,
                    )
                    await websocket.send_json({"type": "done", "conversation_id": str(conversation.id), "suggested_questions": list(_local_suggested_questions(locals()))})
                    continue

                # --- Stage 1.5: Subject-match check ---
                # Before we let the LLM answer, classify whether the
                # retrieved sources actually match the user's question
                # subject. This catches the "user asked about water
                # nozzles, retrieval returned paint nozzles" failure:
                # without this step the LLM happily blends them.
                #
                # The assessor itself never raises — on any failure
                # it falls back to ``well_covered`` so we preserve
                # today's grounded-answer path.
                fit = await asyncio.to_thread(
                    assess_grounding_fit, message, sources
                )
                if fit.verdict in ("not_in_doc", "subject_mismatch"):
                    related_sources_for_pivot = (
                        [
                            sources[s.index - 1]
                            for s in fit.sources
                            if s.classification == "RELATED"
                            and 1 <= s.index <= len(sources)
                        ]
                        if fit.verdict == "subject_mismatch"
                        else None
                    )
                    neighbors = []
                    if fit.verdict == "not_in_doc" and document_ids:
                        try:
                            neighbors = await find_neighbor_concepts(
                                db,
                                query=message,
                                document_ids=document_ids,
                                limit=4,
                            )
                        except Exception as exc:  # noqa: BLE001
                            logger.warning("neighbor_concepts_failed: %s", exc)
                    primary_doc = None
                    if document_ids:
                        primary_doc = await db.scalar(
                            select(Document).where(Document.id == document_ids[0])
                        )
                    pivot = await asyncio.to_thread(
                        not_in_document_agent,
                        query=message,
                        document_title=(primary_doc.filename if primary_doc else None),
                        document_summary=None,
                        neighbor_concepts=neighbors,
                        fit=fit,
                        related_sources=related_sources_for_pivot,
                    )
                    pivot = _style_answer_response(pivot)
                    await _send_pivot_and_done(
                        websocket, db, conversation, message, mode, pivot
                    )
                    continue

                # --- Stage 2: Intent Classification ---
                await websocket.send_json({"type": "status", "status": "reasoning"})
                intent = classify_intent(effective_message, sources)

                # --- Stage 3: Handle non-streaming agents (calc, clarification) ---
                if intent == "ambiguous":
                    answer = clarification_agent(effective_message, sources)
                    answer = _style_answer_response(answer)
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
                        suggested_questions=getattr(answer, "suggested_questions", None) or None,
                    )
                    await websocket.send_json({"type": "done", "conversation_id": str(conversation.id), "suggested_questions": list(_local_suggested_questions(locals()))})
                    continue

                if intent == "calculation":
                    await websocket.send_json({"type": "status", "status": "calculating"})
                    answer = calculation_agent(effective_message, sources, history)
                    answer = _style_answer_response(answer)

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
                        suggested_questions=getattr(answer, "suggested_questions", None) or None,
                    )
                    await websocket.send_json({"type": "done", "conversation_id": str(conversation.id), "suggested_questions": list(_local_suggested_questions(locals()))})
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

                system_content = (
                    "You are Maia Axon, a technical document assistant. Answer using "
                    "uploaded PDFs as primary source. Always cite with inline [N]. "
                    f"{language_instruction} "
                    "Always sound like a mathematician, scientist, and engineer: precise, rigorous, and technically grounded. "
                    "Look for chances to make the answer more useful with a compact example, quick calculation, "
                    "or engineering sanity check when the material supports it. "
                    f"{STRUCTURED_RESPONSE_GUIDANCE}"
                )
                if mode == "learn":
                    if learn_ctx is not None:
                        # Path-aware tutor prompt (knows the goal, current
                        # step, prerequisite vs target, etc.).
                        system_content = (
                            build_learn_system_prompt(learn_ctx)
                            + "\n\n"
                            + system_content
                        )
                    else:
                        # No path yet — open tutor mode, document-scoped.
                        doc_name = None
                        if document_ids:
                            doc_obj = await db.scalar(
                                select(Document).where(Document.id == document_ids[0])
                            )
                            doc_name = doc_obj.filename if doc_obj else None
                        system_content = (
                            build_open_learn_system_prompt(doc_name)
                            + "\n\n"
                            + system_content
                        )

                # Prepend system message
                messages.insert(0, {
                    "role": "system",
                    "content": system_content,
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

                final_text = ensure_inline_citation_references(full_text, citations_list)
                answer = _style_answer_response(
                    AnswerResponse(
                        text=final_text,
                        sections=[AnswerSection(type="explanation", content=final_text, grounded=True)],
                        citations=citations_list,
                    )
                )
                full_text = answer.text
                await websocket.send_json({"type": "token", "content": full_text})

                # Send citations
                citations = [_serialize_citation(c) for c in citations_list]
                await websocket.send_json({"type": "citations", "data": citations})

                # Build and send mindmap
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
                await websocket.send_json({"type": "done", "conversation_id": str(conversation.id), "suggested_questions": list(_local_suggested_questions(locals()))})

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for user {user.id}")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
