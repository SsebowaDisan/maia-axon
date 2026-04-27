import fitz
from uuid import UUID
from functools import lru_cache
import re
from collections import Counter

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from fastapi.responses import Response
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
from app.models.group import Group
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


@lru_cache(maxsize=64)
def _get_document_page_dimensions(document_id: str) -> tuple[tuple[float, float], ...]:
    try:
        pdf_key = f"documents/{document_id}/original.pdf"
        pdf_bytes = download_file(pdf_key)
        pdf_doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        try:
            return tuple(
                (float(pdf_page.rect.width), float(pdf_page.rect.height))
                for pdf_page in pdf_doc
            )
        finally:
            pdf_doc.close()
    except Exception:
        return ()


def _get_pdf_page_dimensions(document_id: UUID, page_number: int) -> tuple[float | None, float | None]:
    dimensions = _get_document_page_dimensions(str(document_id))
    if 0 < page_number <= len(dimensions):
        return dimensions[page_number - 1]
    return None, None


def _score_page_label_match(text: str | None, page_label: int) -> int:
    if not text:
        return 0

    label = str(page_label)
    lines = [line.strip() for line in re.split(r"\r?\n", text) if line.strip()]
    if not lines:
        return 0

    best_score = 0
    for index, line in enumerate(lines):
        lowered = line.lower()
        near_edge_bonus = 12 if index < 6 or index >= max(len(lines) - 8, 0) else 0

        if line == label:
            best_score = max(best_score, 100 + near_edge_bonus)
            continue

        if len(line) <= 40 and re.search(rf"\b{re.escape(label)}\b$", line):
            best_score = max(best_score, 72 + near_edge_bonus)

        if re.search(rf"\bpage\s+{re.escape(label)}\b", lowered):
            best_score = max(best_score, 56 + near_edge_bonus)

        if re.search(rf"^\W*{re.escape(label)}\W*$", line):
            best_score = max(best_score, 92 + near_edge_bonus)

    return best_score


def _normalize_page_text(text: str | None) -> str:
    if not text:
        return ""
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def _normalize_section_title(title: str | None) -> str:
    normalized = _normalize_page_text(title)
    if not normalized:
        return ""
    return re.sub(r"^\d+\s+", "", normalized).strip()


def _section_title_score(page_text: str, section_title: str) -> int:
    if not page_text or not section_title:
        return 0

    if section_title == page_text:
        return 160
    if page_text.startswith(section_title):
        return 140
    if section_title in page_text:
        return 110

    title_tokens = [token for token in section_title.split() if len(token) > 2]
    if not title_tokens:
        return 0

    overlap = sum(1 for token in title_tokens if token in page_text)
    if overlap < max(2, len(title_tokens) // 2):
        return 0
    return 70 + overlap * 6


def _extract_printed_page_labels(text: str | None) -> list[int]:
    if not text:
        return []

    lines = [line.strip() for line in re.split(r"\r?\n", text) if line.strip()]
    if not lines:
        return []

    candidates: list[int] = []
    edge_lines = lines[:6] + lines[-8:]
    for line in edge_lines:
        if len(line) > 14:
            continue
        match = re.fullmatch(r"\D{0,2}(\d{1,4})\D{0,2}", line)
        if not match:
            continue
        label = int(match.group(1))
        if label <= 0:
            continue
        candidates.append(label)

    return candidates


def _extract_primary_printed_page_label(markdown: str | None, ocr_text: str | None) -> int | None:
    labels = _extract_printed_page_labels(markdown) + _extract_printed_page_labels(ocr_text)
    if not labels:
        return None

    counts = Counter(labels)
    return max(counts.items(), key=lambda item: (item[1], item[0]))[0]


async def _resolve_printed_page_number(
    document_id: UUID,
    page_label: int,
    title: str | None,
    db: AsyncSession,
) -> int:
    if page_label <= 0:
        return page_label

    result = await db.execute(
        select(Page.page_number, Page.markdown, Page.ocr_text)
        .where(Page.document_id == document_id)
        .order_by(Page.page_number.asc())
    )
    rows = result.all()
    if not rows:
        return page_label

    max_page = max(int(row.page_number) for row in rows)

    offset_counter: Counter[int] = Counter()
    for row in rows:
        page_number = int(row.page_number)
        labels = set(_extract_printed_page_labels(row.markdown)) | set(_extract_printed_page_labels(row.ocr_text))
        for label in labels:
            offset = page_number - label
            if -2 <= offset <= max_page:
                offset_counter[offset] += 1

    dominant_offset = 0
    if offset_counter:
        dominant_offset = max(
            offset_counter.items(),
            key=lambda item: (item[1], -abs(item[0]), item[0]),
        )[0]

    guessed_page = min(max(page_label + dominant_offset, 1), max_page)

    best_page = guessed_page
    best_score = 0
    for row in rows:
        score = max(
            _score_page_label_match(row.markdown, page_label),
            _score_page_label_match(row.ocr_text, page_label),
        )
        if score > best_score:
            best_score = score
            best_page = int(row.page_number)

    if best_score >= 56:
        return best_page

    normalized_title = _normalize_page_text(title)
    if normalized_title:
        title_matches: list[int] = []
        for row in rows:
            combined = " ".join(
                part for part in (_normalize_page_text(row.markdown), _normalize_page_text(row.ocr_text)) if part
            )
            if normalized_title and normalized_title in combined:
                title_matches.append(int(row.page_number))

        if title_matches:
            return min(title_matches, key=lambda page_number: abs(page_number - guessed_page))

    return guessed_page


async def _resolve_section_title(
    document_id: UUID,
    title: str,
    from_page: int | None,
    db: AsyncSession,
) -> int | None:
    normalized_title = _normalize_section_title(title)
    if not normalized_title:
        return None

    result = await db.execute(
        select(Page.page_number, Page.markdown, Page.ocr_text)
        .where(Page.document_id == document_id)
        .order_by(Page.page_number.asc())
    )
    rows = result.all()
    if not rows:
        return None

    min_page = max((from_page or 1) + 1, 1)
    best_page: int | None = None
    best_score = 0

    for row in rows:
        page_number = int(row.page_number)
        if page_number < min_page:
            continue

        page_text = " ".join(
            part
            for part in (_normalize_page_text(row.markdown), _normalize_page_text(row.ocr_text))
            if part
        )
        score = _section_title_score(page_text, normalized_title)
        if score > best_score:
            best_score = score
            best_page = page_number

    return best_page if best_score >= 88 else None


async def _check_group_access(group_id: UUID, user: User, db: AsyncSession) -> Group:
    result = await db.execute(select(Group).where(Group.id == group_id))
    group = result.scalar_one_or_none()
    if group is None:
        raise HTTPException(status_code=404, detail="Group not found")
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
        current_stage="uploading",
        progress_current=0,
        progress_total=None,
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
    doc.current_stage = "splitting"
    doc.progress_current = 0
    doc.progress_total = None
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
    doc.current_stage = "splitting"
    doc.progress_current = 0
    doc.progress_total = None
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
        id=doc.id,
        status=doc.status,
        current_stage=doc.current_stage,
        progress_current=doc.progress_current,
        progress_total=doc.progress_total,
        page_count=doc.page_count,
        error_detail=doc.error_detail,
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
    doc.current_stage = "splitting"
    doc.progress_current = 0
    doc.progress_total = None
    doc.error_detail = None
    await db.flush()

    process_document.delay(str(doc.id))

    return DocumentStatusResponse(
        id=doc.id,
        status=doc.status,
        current_stage=doc.current_stage,
        progress_current=doc.progress_current,
        progress_total=doc.progress_total,
        page_count=doc.page_count,
        error_detail=None,
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
        printed_page_label=_extract_primary_printed_page_label(public_page.markdown, public_page.ocr_text),
        image_url=public_page.image_url,
        page_width=page_width,
        page_height=page_height,
        markdown=public_page.markdown,
        ocr_text=public_page.ocr_text,
        ocr_confidence=public_page.ocr_confidence,
        regions=public_page.regions,
    )


@router.get("/documents/{document_id}/pages/{page_number}/image")
async def get_page_image(
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
        select(Page.id)
        .where(Page.document_id == document_id, Page.page_number == page_number)
        .order_by(Page.created_at.desc(), Page.id.desc())
    )
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Page not found")

    key = f"documents/{document_id}/pages/{page_number}.png"
    try:
        image_bytes = download_file(key)
    except Exception as exc:
        raise HTTPException(status_code=404, detail="Page image not found") from exc

    return Response(
        content=image_bytes,
        media_type="image/png",
        headers={"Cache-Control": "private, max-age=3600"},
    )


@router.get("/documents/{document_id}/resolve-page/{page_label}")
async def resolve_document_page(
    document_id: UUID,
    page_label: int,
    title: str | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Document).where(Document.id == document_id))
    doc = result.scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    await _check_group_access(doc.group_id, user, db)

    resolved_page = await _resolve_printed_page_number(document_id, page_label, title, db)
    return {
        "page_label": page_label,
        "resolved_page": resolved_page,
    }


@router.get("/documents/{document_id}/resolve-section")
async def resolve_document_section(
    document_id: UUID,
    title: str,
    from_page: int | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Document).where(Document.id == document_id))
    doc = result.scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    await _check_group_access(doc.group_id, user, db)

    resolved_page = await _resolve_section_title(document_id, title, from_page, db)
    if resolved_page is None:
        raise HTTPException(status_code=404, detail="Section not found")

    return {
        "title": title,
        "resolved_page": resolved_page,
    }
