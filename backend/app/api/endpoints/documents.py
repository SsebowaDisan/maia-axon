import fitz
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_admin
from app.core.config import settings
from app.core.database import get_db
from app.core.storage import (
    create_pdf_upload_session,
    delete_document_files,
    download_file,
    get_file_metadata,
    get_file_url,
    to_public_url,
    upload_pdf,
    uses_browser_direct_upload,
)
from app.models.document import Document, Page
from app.models.group import Group, GroupAssignment
from app.models.user import User
from app.schemas.document import (
    DocumentResponse,
    DocumentStatusResponse,
    DocumentUploadCompleteResponse,
    DocumentUploadInitRequest,
    DocumentUploadInitResponse,
    PageResponse,
)
from app.tasks.ingestion import process_document

router = APIRouter(tags=["documents"])


def _with_public_file_url(doc: Document) -> Document:
    doc.file_url = to_public_url(doc.file_url)
    return doc


def _with_public_image_url(page: Page) -> Page:
    page.image_url = to_public_url(page.image_url)
    return page


def _get_pdf_page_dimensions(document_id: UUID, page_number: int) -> tuple[float | None, float | None]:
    try:
        pdf_key = f"documents/{document_id}/original.pdf"
        pdf_bytes = download_file(pdf_key)
        pdf_doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        try:
            pdf_page = pdf_doc[page_number - 1]
            return float(pdf_page.rect.width), float(pdf_page.rect.height)
        finally:
            pdf_doc.close()
    except Exception:
        return None, None


async def _check_group_access(group_id: UUID, user: User, db: AsyncSession) -> Group:
    result = await db.execute(select(Group).where(Group.id == group_id))
    group = result.scalar_one_or_none()
    if group is None:
        raise HTTPException(status_code=404, detail="Group not found")
    if user.is_admin:
        return group
    result = await db.execute(
        select(GroupAssignment).where(
            GroupAssignment.group_id == group_id,
            GroupAssignment.user_id == user.id,
        )
    )
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=403, detail="No access to this group")
    return group


def _validate_pdf_upload(filename: str | None, file_size_bytes: int, content_type: str | None = None):
    if not filename or not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")
    if content_type and content_type not in {"application/pdf", "application/octet-stream"}:
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    size_mb = file_size_bytes / (1024 * 1024)
    if size_mb > settings.max_upload_size_mb:
        raise HTTPException(
            status_code=400,
            detail=f"File too large. Max size: {settings.max_upload_size_mb} MB",
        )


def _create_document_record(group_id: UUID, filename: str, file_size_bytes: int, uploaded_by: UUID) -> Document:
    doc = Document(
        group_id=group_id,
        filename=filename,
        file_url="",
        file_size_bytes=file_size_bytes,
        status="uploading",
        uploaded_by=uploaded_by,
    )
    return doc


# --- @ command: list docs in group ---


@router.get("/groups/{group_id}/documents", response_model=list[DocumentResponse])
async def list_documents(
    group_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Serves the @ command: list documents in a group."""
    await _check_group_access(group_id, user, db)
    result = await db.execute(
        select(Document)
        .where(Document.group_id == group_id)
        .order_by(Document.created_at.desc())
    )
    return [_with_public_file_url(doc) for doc in result.scalars().all()]


@router.post(
    "/groups/{group_id}/documents",
    response_model=DocumentResponse,
    status_code=status.HTTP_201_CREATED,
)
async def upload_document(
    group_id: UUID,
    file: UploadFile = File(...),
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Upload a PDF to a group. Admin only."""
    # Validate group exists
    result = await db.execute(select(Group).where(Group.id == group_id))
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Group not found")

    content = await file.read()
    _validate_pdf_upload(file.filename, len(content), file.content_type)

    # Create document record
    doc = _create_document_record(group_id, file.filename, len(content), admin.id)
    db.add(doc)
    await db.flush()

    # Upload to S3
    file_url = upload_pdf(doc.id, content)
    doc.file_url = file_url
    doc.status = "splitting"
    await db.flush()
    await db.refresh(doc)

    # Trigger async ingestion pipeline
    process_document.delay(str(doc.id))

    return _with_public_file_url(doc)


@router.post(
    "/groups/{group_id}/documents/uploads",
    response_model=DocumentUploadInitResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_document_upload_session(
    group_id: UUID,
    body: DocumentUploadInitRequest,
    request: Request,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Group).where(Group.id == group_id))
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Group not found")

    _validate_pdf_upload(body.filename, body.file_size_bytes, body.content_type)

    if not uses_browser_direct_upload():
        return DocumentUploadInitResponse(strategy="proxy")

    doc = _create_document_record(group_id, body.filename, body.file_size_bytes, admin.id)
    db.add(doc)
    await db.flush()

    doc.file_url = get_file_url(f"documents/{doc.id}/original.pdf")
    await db.flush()
    await db.refresh(doc)

    upload_url = create_pdf_upload_session(
        doc.id,
        content_type=body.content_type,
        size_bytes=body.file_size_bytes,
        origin=request.headers.get("origin"),
    )

    return DocumentUploadInitResponse(
        strategy="direct_gcs",
        document=_with_public_file_url(doc),
        upload_url=upload_url,
    )


@router.post(
    "/documents/{document_id}/complete-upload",
    response_model=DocumentUploadCompleteResponse,
)
async def complete_document_upload(
    document_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Document).where(Document.id == document_id))
    doc = result.scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    metadata = get_file_metadata(f"documents/{document_id}/original.pdf")
    if metadata is None:
        doc.status = "failed"
        doc.error_detail = "Uploaded file not found in storage"
        await db.flush()
        await db.refresh(doc)
        raise HTTPException(status_code=400, detail="Uploaded file not found in storage")

    doc.file_size_bytes = metadata.get("size") or doc.file_size_bytes
    doc.file_url = get_file_url(f"documents/{document_id}/original.pdf")
    doc.status = "splitting"
    doc.error_detail = None
    await db.flush()
    await db.refresh(doc)

    process_document.delay(str(doc.id))

    return DocumentUploadCompleteResponse(document=_with_public_file_url(doc))


@router.get("/documents/{document_id}", response_model=DocumentResponse)
async def get_document(
    document_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Document).where(Document.id == document_id))
    doc = result.scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    await _check_group_access(doc.group_id, user, db)
    return _with_public_file_url(doc)


@router.get("/documents/{document_id}/status", response_model=DocumentStatusResponse)
async def get_document_status(
    document_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Document).where(Document.id == document_id))
    doc = result.scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return DocumentStatusResponse(
        id=doc.id, status=doc.status, page_count=doc.page_count, error_detail=doc.error_detail
    )


@router.delete("/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(
    document_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Document).where(Document.id == document_id))
    doc = result.scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    # Delete from S3
    delete_document_files(doc.id)
    # Cascade deletes pages, chunks, embeddings
    await db.delete(doc)


@router.post("/documents/{document_id}/reindex", response_model=DocumentStatusResponse)
async def reindex_document(
    document_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Re-process a document through the ingestion pipeline."""
    result = await db.execute(select(Document).where(Document.id == document_id))
    doc = result.scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    doc.status = "splitting"
    doc.error_detail = None
    await db.flush()

    process_document.delay(str(doc.id))

    return DocumentStatusResponse(
        id=doc.id, status=doc.status, page_count=doc.page_count, error_detail=None
    )


@router.get("/documents/{document_id}/pages/{page_number}", response_model=PageResponse)
async def get_page(
    document_id: UUID,
    page_number: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Document).where(Document.id == document_id))
    doc = result.scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    await _check_group_access(doc.group_id, user, db)

    result = await db.execute(
        select(Page)
        .where(Page.document_id == document_id, Page.page_number == page_number)
        .order_by(Page.created_at.desc(), Page.id.desc())
    )
    page = result.scalars().first()
    if page is None:
        raise HTTPException(status_code=404, detail="Page not found")

    page_width, page_height = _get_pdf_page_dimensions(document_id, page_number)
    public_page = _with_public_image_url(page)
    return PageResponse(
        id=public_page.id,
        document_id=public_page.document_id,
        page_number=public_page.page_number,
        image_url=public_page.image_url,
        page_width=page_width,
        page_height=page_height,
        markdown=public_page.markdown,
        ocr_text=public_page.ocr_text,
        ocr_confidence=public_page.ocr_confidence,
        regions=public_page.regions,
    )
