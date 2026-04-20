from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)


class ProjectResponse(BaseModel):
    id: UUID
    user_id: UUID
    name: str
    created_at: datetime
    updated_at: datetime
    conversation_count: int = 0

    model_config = {"from_attributes": True}
