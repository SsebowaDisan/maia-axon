"""
WebSocket endpoint for streaming chat responses.

Protocol:
  Client → Server: { type: "query", group_id, document_ids?, mode, message }
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
from app.models.conversation import Conversation, Message
from app.models.group import GroupAssignment
from app.models.user import User
from app.services.answer_engine import (
    _build_citations,
    _build_mindmap,
    _format_sources_for_prompt,
    classify_intent,
    calculation_agent,
    clarification_agent,
)
from app.services.retrieval import deep_search, library_search

logger = logging.getLogger(__name__)

router = APIRouter()


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
        "snippet": cite.snippet,
        "url": cite.url,
        "title": cite.title,
    }


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

            group_id = UUID(data["group_id"])
            document_ids = [UUID(d) for d in data.get("document_ids", [])] or None
            mode = data.get("mode", "library")
            message = data["message"]
            conversation_id = UUID(data["conversation_id"]) if data.get("conversation_id") else None

            async with async_session() as db:
                # Verify group access
                if not user.is_admin:
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

                # Get or create conversation
                if conversation_id:
                    result = await db.execute(
                        select(Conversation)
                        .options(selectinload(Conversation.messages))
                        .where(Conversation.id == conversation_id)
                    )
                    conversation = result.scalar_one_or_none()
                else:
                    conversation = Conversation(user_id=user.id, group_id=group_id, title=message[:100])
                    db.add(conversation)
                    await db.flush()

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

                # --- Stage 1: Retrieval ---
                await websocket.send_json({"type": "status", "status": "retrieving"})

                if mode == "deep_search":
                    retrieval = await deep_search(db, message, group_id, document_ids)
                else:
                    retrieval = await library_search(db, message, group_id, document_ids)

                sources = retrieval.results

                if not sources:
                    await websocket.send_json({
                        "type": "token",
                        "content": "I couldn't find relevant information in the selected group's documents.",
                    })
                    await websocket.send_json({"type": "done", "conversation_id": str(conversation.id)})
                    continue

                # --- Stage 2: Intent Classification ---
                await websocket.send_json({"type": "status", "status": "reasoning"})
                intent = classify_intent(message, sources)

                # --- Stage 3: Handle non-streaming agents (calc, clarification) ---
                if intent == "ambiguous":
                    answer = clarification_agent(message, sources)
                    await websocket.send_json({
                        "type": "token",
                        "content": answer.clarification_question,
                    })
                    await websocket.send_json({"type": "done", "conversation_id": str(conversation.id)})

                    # Save
                    assistant_msg = Message(
                        conversation_id=conversation.id,
                        role="assistant",
                        content=answer.clarification_question,
                        search_mode=mode,
                    )
                    db.add(assistant_msg)
                    await db.commit()
                    continue

                if intent == "calculation":
                    await websocket.send_json({"type": "status", "status": "calculating"})
                    answer = calculation_agent(message, sources, history)

                    if answer.needs_clarification:
                        await websocket.send_json({
                            "type": "token",
                            "content": answer.clarification_question,
                        })
                        await websocket.send_json({"type": "done", "conversation_id": str(conversation.id)})

                        assistant_msg = Message(
                            conversation_id=conversation.id,
                            role="assistant",
                            content=answer.clarification_question,
                            search_mode=mode,
                        )
                        db.add(assistant_msg)
                        await db.commit()
                        continue

                    # Send full calculation answer
                    await websocket.send_json({"type": "token", "content": answer.text})

                    citations = [_serialize_citation(c) for c in answer.citations]
                    await websocket.send_json({"type": "citations", "data": citations})

                    if answer.mindmap:
                        await websocket.send_json({
                            "type": "mindmap",
                            "data": _serialize_mindmap(answer.mindmap),
                        })

                    if answer.warnings:
                        await websocket.send_json({"type": "warnings", "data": answer.warnings})

                    await websocket.send_json({"type": "done", "conversation_id": str(conversation.id)})

                    # Save
                    assistant_msg = Message(
                        conversation_id=conversation.id,
                        role="assistant",
                        content=answer.text,
                        citations={"citations": citations},
                        mindmap=_serialize_mindmap(answer.mindmap) if answer.mindmap else None,
                        search_mode=mode,
                    )
                    db.add(assistant_msg)
                    await db.commit()
                    continue

                # --- Stage 4: Streaming Q&A ---
                citations_list = _build_citations(sources)
                sources_text = _format_sources_for_prompt(sources)

                messages = history[-10:] + [{
                    "role": "user",
                    "content": (
                        f"Answer the following question using the provided sources.\n\n"
                        f"SOURCES:\n{sources_text}\n\n"
                        f"QUESTION: {message}\n\n"
                        "RULES:\n"
                        "1. Ground your answer in the sources. Cite sources as [Source N].\n"
                        "2. If you use knowledge not from the sources, clearly mark it.\n"
                        "3. If multiple sources differ, present both.\n"
                        "4. If a source has LOW OCR CONFIDENCE, warn the user.\n"
                        "5. Be concise but thorough."
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
                        "uploaded PDFs as primary source. Always cite with [Source N]."
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

                # Send citations
                citations = [_serialize_citation(c) for c in citations_list]
                await websocket.send_json({"type": "citations", "data": citations})

                # Build and send mindmap
                from app.services.answer_engine import AnswerResponse, AnswerSection
                answer = AnswerResponse(
                    text=full_text,
                    sections=[AnswerSection(type="explanation", content=full_text, grounded=True)],
                    citations=citations_list,
                )
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

                await websocket.send_json({"type": "done", "conversation_id": str(conversation.id)})

                # Save assistant message
                assistant_msg = Message(
                    conversation_id=conversation.id,
                    role="assistant",
                    content=full_text,
                    citations={"citations": citations},
                    mindmap=_serialize_mindmap(mindmap),
                    search_mode=mode,
                )
                db.add(assistant_msg)
                await db.commit()

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for user {user.id}")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass
