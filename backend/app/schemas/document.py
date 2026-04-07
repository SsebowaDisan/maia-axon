from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class DocumentResponse(BaseModel):
    id: UUID
    group_id: UUID
    filename: str
    file_url: str
    file_size_bytes: int | None
    page_count: int | None
    status: str
    error_detail: str | None
    uploaded_by: UUID
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class DocumentStatusResponse(BaseModel):
    id: UUID
    status: str
    page_count: int | None
    error_detail: str | None


class PageResponse(BaseModel):
    id: UUID
    document_id: UUID
    page_number: int
    image_url: str
    markdown: str | None
    ocr_text: str | None
    ocr_confidence: float | None
    regions: dict | None

    model_config = {"from_attributes": True}
