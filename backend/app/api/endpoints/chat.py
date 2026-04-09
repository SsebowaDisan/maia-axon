"""
Chat endpoint: REST fallback for non-streaming chat.
WebSocket streaming is handled in ws.py.
"""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.conversation import Conversation, Message
from app.models.document import Document
from app.models.group import GroupAssignment
from app.models.user import User
from app.api.endpoints.groups import _check_group_access
from app.schemas.conversation import (
    ChatRequest,
    MessageResponse,
    PromptAttachmentResponse,
    WelcomeResponse,
)
from app.services.prompt_attachments import (
    build_attachment_context,
    load_prompt_attachment,
    save_prompt_attachment,
)
from app.services.answer_engine import (
    AnswerResponse,
    generate_answer,
    generate_conversation_metadata,
    generate_welcome_payload,
)
from app.services.retrieval import deep_search, library_search

router = APIRouter(prefix="/chat", tags=["chat"])


@router.get("/welcome", response_model=WelcomeResponse)
async def welcome(
    group_id: UUID | None = Query(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    document_query = (
        select(
            Document.filename,
            Document.page_count,
            Document.status,
            Document.group_id,
        )
        .order_by(Document.updated_at.desc(), Document.created_at.desc())
    )

    group_name = None
    if group_id:
        group = await _check_group_access(group_id, user, db)
        group_name = group.name
        document_query = document_query.where(Document.group_id == group_id, Document.status == "ready")
    elif not user.is_admin:
        document_query = (
            document_query
            .join(GroupAssignment, GroupAssignment.group_id == Document.group_id)
            .where(GroupAssignment.user_id == user.id, Document.status == "ready")
        )
    else:
        document_query = document_query.where(Document.status == "ready")

    result = await db.execute(document_query.limit(8))
    documents = [
        {
            "filename": row.filename,
            "page_count": row.page_count,
            "status": row.status,
            "group_id": str(row.group_id),
        }
        for row in result.all()
    ]

    payload = generate_welcome_payload(group_name=group_name, documents=documents)
    return WelcomeResponse(**payload)


@router.post("/attachments", response_model=PromptAttachmentResponse, status_code=201)
async def upload_prompt_attachment(
    file: UploadFile,
    user: User = Depends(get_current_user),
):
    attachment = await save_prompt_attachment(file, user.id)
    return PromptAttachmentResponse(
        id=attachment.id,
        filename=attachment.filename,
        media_type=attachment.media_type,
        size_bytes=attachment.size_bytes,
    )


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
            "boxes": c.boxes,
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
            "boxes": node.source.boxes,
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

    attachments = [
        load_prompt_attachment(attachment_id, user.id)
        for attachment_id in (body.attachment_ids or [])
    ]
    attachment_context, _, _ = build_attachment_context(attachments)
    effective_message = body.message
    if attachment_context:
        effective_message = (
            f"{body.message}\n\n"
            "The user attached files for direct analysis. Use them as first-class input.\n\n"
            f"{attachment_context}"
        )

    # Retrieve sources unless the user requested direct LLM mode
    if body.mode == "standard":
        sources = []
    elif body.mode == "deep_search":
        retrieval = await deep_search(db, effective_message, body.group_id, body.document_ids)
        sources = retrieval.results
    else:
        retrieval = await library_search(db, effective_message, body.group_id, body.document_ids)
        sources = retrieval.results

    # Generate answer
    answer = await generate_answer(
        query=effective_message,
        sources=sources,
        conversation_history=history,
        search_mode=body.mode,
    )

    serialized = _serialize_answer(answer)

    # Determine response content
    content = answer.clarification_question if answer.needs_clarification else answer.text

    # Auto-generate conversation title and icon from first message
    if not conversation.title or not conversation.title_icon:
        title, icon = generate_conversation_metadata(body.message, body.mode)
        conversation.title = title
        conversation.title_icon = icon

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
