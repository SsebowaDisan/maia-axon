from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_admin
from app.core.database import get_db
from app.models.conversation import Conversation, Message
from app.models.feedback import FeatureIdea, MessageFeedback
from app.models.user import User
from app.schemas.feedback import (
    AdminFeatureIdeaResponse,
    AdminMessageFeedbackResponse,
    FeatureIdeaCreate,
    FeatureIdeaResponse,
    FeatureIdeaStatusUpdate,
    MessageFeedbackCreate,
    MessageFeedbackResponse,
)

router = APIRouter(prefix="/feedback", tags=["feedback"])


async def _get_accessible_assistant_message(
    db: AsyncSession,
    *,
    message_id: UUID,
    user: User,
) -> Message:
    result = await db.execute(
        select(Message)
        .join(Conversation, Conversation.id == Message.conversation_id)
        .where(
            Message.id == message_id,
            Message.role == "assistant",
            (Conversation.user_id == user.id) if not user.is_admin else True,
        )
    )
    message = result.scalar_one_or_none()
    if message is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Assistant message not found",
        )
    return message


@router.post("/messages", response_model=MessageFeedbackResponse)
async def submit_message_feedback(
    body: MessageFeedbackCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    message = await _get_accessible_assistant_message(db, message_id=body.message_id, user=user)

    existing = await db.scalar(
        select(MessageFeedback).where(
            MessageFeedback.message_id == body.message_id,
            MessageFeedback.user_id == user.id,
        )
    )
    feedback = existing or MessageFeedback(
        message_id=message.id,
        conversation_id=message.conversation_id,
        user_id=user.id,
    )
    feedback.rating = body.rating
    feedback.tags = body.tags
    feedback.comment = body.comment.strip() if body.comment else None

    db.add(feedback)
    await db.flush()
    await db.refresh(feedback)
    return feedback


@router.post("/ideas", response_model=FeatureIdeaResponse)
async def submit_feature_idea(
    body: FeatureIdeaCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    idea = FeatureIdea(
        user_id=user.id,
        category=body.category.strip(),
        title=body.title.strip() if body.title else None,
        description=body.description.strip(),
        priority=body.priority,
    )
    db.add(idea)
    await db.flush()
    await db.refresh(idea)
    return idea


@router.get("/admin/messages", response_model=list[AdminMessageFeedbackResponse])
async def list_message_feedback(
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    rows = await db.execute(
        select(MessageFeedback, User, Message, Conversation)
        .join(User, User.id == MessageFeedback.user_id)
        .join(Message, Message.id == MessageFeedback.message_id)
        .join(Conversation, Conversation.id == MessageFeedback.conversation_id)
        .order_by(desc(MessageFeedback.updated_at))
        .limit(200)
    )

    return [
        AdminMessageFeedbackResponse(
            id=feedback.id,
            message_id=feedback.message_id,
            conversation_id=feedback.conversation_id,
            user_id=feedback.user_id,
            rating=feedback.rating,
            tags=feedback.tags,
            comment=feedback.comment,
            created_at=feedback.created_at,
            updated_at=feedback.updated_at,
            user_name=user.name,
            user_email=user.email,
            message_content=message.content,
            conversation_title=conversation.title,
        )
        for feedback, user, message, conversation in rows.all()
    ]


@router.get("/admin/ideas", response_model=list[AdminFeatureIdeaResponse])
async def list_feature_ideas(
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    rows = await db.execute(
        select(FeatureIdea, User)
        .join(User, User.id == FeatureIdea.user_id)
        .order_by(desc(FeatureIdea.created_at))
        .limit(200)
    )
    return [
        AdminFeatureIdeaResponse(
            id=idea.id,
            user_id=idea.user_id,
            category=idea.category,
            title=idea.title,
            description=idea.description,
            priority=idea.priority,
            status=idea.status,
            created_at=idea.created_at,
            updated_at=idea.updated_at,
            user_name=user.name,
            user_email=user.email,
        )
        for idea, user in rows.all()
    ]


@router.patch("/admin/ideas/{idea_id}", response_model=FeatureIdeaResponse)
async def update_feature_idea_status(
    idea_id: UUID,
    body: FeatureIdeaStatusUpdate,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    idea = await db.scalar(select(FeatureIdea).where(FeatureIdea.id == idea_id))
    if idea is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Feature idea not found")
    idea.status = body.status
    db.add(idea)
    await db.flush()
    await db.refresh(idea)
    return idea
