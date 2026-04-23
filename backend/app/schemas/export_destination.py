from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class ExportDestinationCreate(BaseModel):
    company_id: UUID | None = None
    type: str = Field(min_length=1, max_length=32)
    title: str | None = Field(default=None, max_length=255)
    url: str = Field(min_length=1)


class ExportDestinationInfoResponse(BaseModel):
    service_account_email: str


class ExportWriteRequest(BaseModel):
    destination_id: UUID
    title: str = Field(min_length=1, max_length=255)
    content: str = Field(min_length=1)
    search_mode: str | None = Field(default=None, max_length=32)
    company_name: str | None = Field(default=None, max_length=255)
    visualizations: list[dict] = Field(default_factory=list)


class ExportWriteResponse(BaseModel):
    destination_id: UUID
    destination_type: str
    title: str
    status: str
    written_at: datetime


class ExportDestinationResponse(BaseModel):
    id: UUID
    user_id: UUID
    company_id: UUID | None
    type: str
    title: str
    url: str
    file_id: str
    status: str
    last_verified_at: datetime | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
