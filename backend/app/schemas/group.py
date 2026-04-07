from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class GroupCreate(BaseModel):
    name: str
    description: str | None = None


class GroupUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


class GroupResponse(BaseModel):
    id: UUID
    name: str
    description: str | None
    created_by: UUID
    created_at: datetime
    document_count: int = 0
    user_count: int = 0

    model_config = {"from_attributes": True}


class GroupAssignmentCreate(BaseModel):
    user_id: UUID


class GroupAssignmentResponse(BaseModel):
    group_id: UUID
    user_id: UUID
    assigned_by: UUID
    assigned_at: datetime

    model_config = {"from_attributes": True}
