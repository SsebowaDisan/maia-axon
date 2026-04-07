from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_admin
from app.core.config import settings
from app.core.database import get_db
from app.core.storage import delete_document_files, upload_pdf
from app.models.document import Document, Page
from app.models.group import Group, GroupAssignment
from app.models.user import User
from app.schemas.document import DocumentResponse, DocumentStatusResponse, PageResponse
from app.tasks.ingestion import process_document

router = APIRouter(tags=["documents"])


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
    return result.scalars().all()


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

    # Validate file
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    content = await file.read()
    size_mb = len(content) / (1024 * 1024)
    if size_mb > settings.max_upload_size_mb:
        raise HTTPException(
            status_code=400,
            detail=f"File too large. Max size: {settings.max_upload_size_mb} MB",
        )

    # Create document record
    doc = Document(
        group_id=group_id,
        filename=file.filename,
        file_url="",  # will be set after upload
        file_size_bytes=len(content),
        status="uploading",
        uploaded_by=admin.id,
    )
    db.add(doc)
    await db.flush()

    # Upload to S3
    file_url = upload_pdf(doc.id, content)
    doc.file_url = file_url
    doc.status = "splitting"
    await db.flush()

    # Trigger async ingestion pipeline
    process_document.delay(str(doc.id))

    return doc


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
    return doc


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
        select(Page).where(Page.document_id == document_id, Page.page_number == page_number)
    )
    page = result.scalar_one_or_none()
    if page is None:
        raise HTTPException(status_code=404, detail="Page not found")
    return page
