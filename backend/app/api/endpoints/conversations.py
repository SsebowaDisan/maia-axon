from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.conversation import Conversation, Message
from app.models.group import GroupAssignment
from app.models.project import Project
from app.models.user import User
from app.schemas.conversation import (
    ConversationCreate,
    ConversationDetailResponse,
    ConversationResponse,
    MessageResponse,
)

router = APIRouter(prefix="/conversations", tags=["conversations"])


async def _check_conversation_access(
    conversation_id: UUID, user: User, db: AsyncSession
) -> Conversation:
    result = await db.execute(
        select(Conversation)
        .options(selectinload(Conversation.messages))
        .where(Conversation.id == conversation_id)
    )
    conv = result.scalar_one_or_none()
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if conv.user_id != user.id and not user.is_admin:
        raise HTTPException(status_code=403, detail="Not your conversation")
    return conv


@router.get("", response_model=list[ConversationResponse])
async def list_conversations(
    project_id: UUID | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List user's conversations, optionally filtered by project."""
    query = select(Conversation).where(Conversation.user_id == user.id)
    if project_id:
        query = query.where(Conversation.project_id == project_id)
    else:
        query = query.where(Conversation.project_id.is_not(None))
    query = query.order_by(Conversation.updated_at.desc())
    result = await db.execute(query)
    return result.scalars().all()


@router.post("", response_model=ConversationResponse, status_code=status.HTTP_201_CREATED)
async def create_conversation(
    body: ConversationCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a new conversation under a required project and optional group context."""
    if body.project_id is None:
        raise HTTPException(status_code=400, detail="Project is required")

    project = await db.scalar(
        select(Project).where(Project.id == body.project_id, Project.user_id == user.id)
    )
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    if body.group_id and not user.is_admin:
        result = await db.execute(
            select(GroupAssignment).where(
                GroupAssignment.group_id == body.group_id,
                GroupAssignment.user_id == user.id,
            )
        )
        if result.scalar_one_or_none() is None:
            raise HTTPException(status_code=403, detail="No access to this group")

    conv = Conversation(user_id=user.id, project_id=body.project_id, group_id=body.group_id)
    db.add(conv)
    await db.flush()
    return conv


@router.get("/{conversation_id}", response_model=ConversationDetailResponse)
async def get_conversation(
    conversation_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    conv = await _check_conversation_access(conversation_id, user, db)
    return conv


@router.delete("/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_conversation(
    conversation_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    conv = await _check_conversation_access(conversation_id, user, db)
    await db.delete(conv)
