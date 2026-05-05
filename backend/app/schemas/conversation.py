from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel


class ConversationCreate(BaseModel):
    project_id: UUID | None = None
    group_id: UUID | None = None


class ConversationResponse(BaseModel):
    id: UUID
    user_id: UUID
    project_id: UUID | None
    group_id: UUID | None
    title: str | None
    title_icon: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class CitationResponse(BaseModel):
    id: str
    source_type: Literal["pdf", "web"]
    document_id: str | None = None
    document_name: str = ""
    page: int = 0
    boxes: list[list[float]] | None = None
    snippet: str | None = None
    url: str | None = None
    title: str | None = None

    # Older persisted citations may carry retired keys (e.g. "bbox").
    # Tolerate them silently so historical conversations keep loading.
    model_config = {"extra": "ignore"}


class MessageCitations(BaseModel):
    citations: list[CitationResponse] = []

    model_config = {"extra": "ignore"}


class MessageResponse(BaseModel):
    id: UUID
    conversation_id: UUID
    role: str
    content: str
    citations: MessageCitations | None
    visualizations: list[dict] | None
    mindmap: dict | None
    suggested_questions: list[str] | None = None
    search_mode: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class ConversationDetailResponse(BaseModel):
    id: UUID
    user_id: UUID
    project_id: UUID | None
    group_id: UUID | None
    title: str | None
    title_icon: str | None
    created_at: datetime
    updated_at: datetime
    messages: list[MessageResponse]

    model_config = {"from_attributes": True}


class ChatRequest(BaseModel):
    conversation_id: UUID | None = None
    project_id: UUID | None = None
    group_id: UUID | None = None
    company_id: UUID | None = None
    document_ids: list[UUID] | None = None
    attachment_ids: list[str] | None = None
    mode: str = "library"  # "standard", "library", "deep_search", "google_analytics", or "google_ads"
    message: str


class WelcomeResponse(BaseModel):
    intro_markdown: str
    suggested_questions: list[str]


class PromptAttachmentResponse(BaseModel):
    id: str
    filename: str
    media_type: str
    size_bytes: int
