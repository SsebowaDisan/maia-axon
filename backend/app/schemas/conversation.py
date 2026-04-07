from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class ConversationCreate(BaseModel):
    group_id: UUID


class ConversationResponse(BaseModel):
    id: UUID
    user_id: UUID
    group_id: UUID
    title: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class MessageResponse(BaseModel):
    id: UUID
    conversation_id: UUID
    role: str
    content: str
    citations: dict | None
    mindmap: dict | None
    search_mode: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ConversationDetailResponse(BaseModel):
    id: UUID
    user_id: UUID
    group_id: UUID
    title: str | None
    created_at: datetime
    updated_at: datetime
    messages: list[MessageResponse]

    model_config = {"from_attributes": True}


class ChatRequest(BaseModel):
    conversation_id: UUID | None = None
    group_id: UUID
    document_ids: list[UUID] | None = None
    mode: str = "library"  # "library" or "deep_search"
    message: str
