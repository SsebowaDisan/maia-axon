from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


MessageRating = Literal["up", "down"]
FeaturePriority = Literal["nice_to_have", "important", "blocking"]
FeatureStatus = Literal["new", "reviewed", "planned", "done"]


class MessageFeedbackCreate(BaseModel):
    message_id: UUID
    rating: MessageRating
    tags: list[str] = Field(default_factory=list, max_length=8)
    comment: str | None = Field(default=None, max_length=2000)


class MessageFeedbackResponse(BaseModel):
    id: UUID
    message_id: UUID
    conversation_id: UUID
    user_id: UUID
    rating: str
    tags: list[str] | None
    comment: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class FeatureIdeaCreate(BaseModel):
    category: str = Field(min_length=2, max_length=64)
    title: str | None = Field(default=None, max_length=200)
    description: str = Field(min_length=3, max_length=4000)
    priority: FeaturePriority = "nice_to_have"


class FeatureIdeaStatusUpdate(BaseModel):
    status: FeatureStatus


class FeatureIdeaResponse(BaseModel):
    id: UUID
    user_id: UUID
    category: str
    title: str | None
    description: str
    priority: str
    status: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class AdminMessageFeedbackResponse(MessageFeedbackResponse):
    user_name: str
    user_email: str
    message_content: str
    conversation_title: str | None


class AdminFeatureIdeaResponse(FeatureIdeaResponse):
    user_name: str
    user_email: str
