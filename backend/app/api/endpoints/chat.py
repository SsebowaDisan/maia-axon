"""
Chat endpoint: REST fallback for non-streaming chat.
WebSocket streaming is handled in ws.py.
"""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.conversation import Conversation, Message
from app.models.group import GroupAssignment
from app.models.user import User
from app.schemas.conversation import ChatRequest, MessageResponse
from app.services.answer_engine import AnswerResponse, generate_answer
from app.services.retrieval import deep_search, library_search

router = APIRouter(prefix="/chat", tags=["chat"])


def _serialize_answer(answer: AnswerResponse) -> dict:
    """Convert AnswerResponse dataclass to JSON-serializable dict."""
    citations = []
    for c in answer.citations:
        citations.append({
            "id": c.id,
            "source_type": c.source_type,
            "document_id": str(c.document_id) if c.document_id else None,
            "document_name": c.document_name,
            "page": c.page,
            "bbox": c.bbox,
            "snippet": c.snippet,
            "url": c.url,
            "title": c.title,
        })

    mindmap = None
    if answer.mindmap:
        mindmap = _serialize_mindmap_node(answer.mindmap)

    return {
        "text": answer.text,
        "citations": citations,
        "mindmap": mindmap,
        "warnings": answer.warnings,
        "needs_clarification": answer.needs_clarification,
        "clarification_question": answer.clarification_question,
    }


def _serialize_mindmap_node(node) -> dict:
    result = {
        "id": node.id,
        "label": node.label,
        "node_type": node.node_type,
        "children": [_serialize_mindmap_node(c) for c in node.children],
    }
    if node.source:
        result["source"] = {
            "id": node.source.id,
            "source_type": node.source.source_type,
            "document_id": str(node.source.document_id) if node.source.document_id else None,
            "document_name": node.source.document_name,
            "page": node.source.page,
            "bbox": node.source.bbox,
            "url": node.source.url,
        }
    return result


@router.post("", response_model=MessageResponse)
async def chat(
    body: ChatRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Non-streaming chat endpoint. For streaming, use the WebSocket endpoint."""
    # Verify group access
    if not user.is_admin:
        result = await db.execute(
            select(GroupAssignment).where(
                GroupAssignment.group_id == body.group_id,
                GroupAssignment.user_id == user.id,
            )
        )
        if result.scalar_one_or_none() is None:
            raise HTTPException(status_code=403, detail="No access to this group")

    # Get or create conversation
    if body.conversation_id:
        result = await db.execute(
            select(Conversation)
            .options(selectinload(Conversation.messages))
            .where(Conversation.id == body.conversation_id, Conversation.user_id == user.id)
        )
        conversation = result.scalar_one_or_none()
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
    else:
        conversation = Conversation(user_id=user.id, group_id=body.group_id)
        db.add(conversation)
        await db.flush()

    # Save user message
    user_msg = Message(
        conversation_id=conversation.id,
        role="user",
        content=body.message,
        search_mode=body.mode,
    )
    db.add(user_msg)
    await db.flush()

    # Build conversation history
    result = await db.execute(
        select(Message)
        .where(Message.conversation_id == conversation.id)
        .order_by(Message.created_at)
    )
    history = [{"role": m.role, "content": m.content} for m in result.scalars().all()]

    # Retrieve sources
    if body.mode == "deep_search":
        retrieval = await deep_search(db, body.message, body.group_id, body.document_ids)
    else:
        retrieval = await library_search(db, body.message, body.group_id, body.document_ids)

    # Generate answer
    answer = await generate_answer(
        query=body.message,
        sources=retrieval.results,
        conversation_history=history,
        search_mode=body.mode,
    )

    serialized = _serialize_answer(answer)

    # Determine response content
    content = answer.clarification_question if answer.needs_clarification else answer.text

    # Auto-generate conversation title from first message
    if not conversation.title:
        conversation.title = body.message[:100]

    # Save assistant message
    assistant_msg = Message(
        conversation_id=conversation.id,
        role="assistant",
        content=content,
        citations={"citations": serialized["citations"]},
        mindmap=serialized["mindmap"],
        search_mode=body.mode,
    )
    db.add(assistant_msg)
    await db.flush()

    return assistant_msg
