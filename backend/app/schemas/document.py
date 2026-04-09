from datetime import datetime
from typing import Literal
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


class DocumentUploadInitRequest(BaseModel):
    filename: str
    file_size_bytes: int
    content_type: str = "application/pdf"


class DocumentUploadInitResponse(BaseModel):
    strategy: Literal["direct_gcs", "proxy"]
    document: DocumentResponse | None = None
    upload_url: str | None = None


class DocumentUploadCompleteResponse(BaseModel):
    document: DocumentResponse


class PageResponse(BaseModel):
    id: UUID
    document_id: UUID
    page_number: int
    image_url: str
    page_width: float | None = None
    page_height: float | None = None
    markdown: str | None
    ocr_text: str | None
    ocr_confidence: float | None
    regions: list[dict] | dict | None

    model_config = {"from_attributes": True}
