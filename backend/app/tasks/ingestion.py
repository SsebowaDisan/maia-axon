"""
Resumable ingestion pipeline: PDF -> pages -> OCR -> figure captioning -> chunking -> embedding.

Large documents are processed as separate Celery stages so retries can resume from
persisted database state instead of restarting the whole document.
"""
import base64
import json
import logging
import re
import uuid

import fitz  # PyMuPDF
import openai
from sqlalchemy import create_engine, delete
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings
from app.core.storage import download_file, upload_page_image
from app.models.chunk import Chunk, ChunkEmbedding
from app.models.document import Document, Page
from app.tasks.worker import celery_app

logger = logging.getLogger(__name__)

# Celery tasks use sync SQLAlchemy (not async) since Celery workers are sync
_sync_url = settings.database_url.replace("+asyncpg", "+psycopg2")
if "asyncpg" in _sync_url:
    _sync_url = _sync_url.replace("asyncpg", "psycopg2")

sync_engine = create_engine(_sync_url)
SyncSession = sessionmaker(sync_engine)

_UNSET = object()
_PROGRESS_LOG_INTERVAL = 10


def _get_openai_client() -> openai.OpenAI:
    return openai.OpenAI(api_key=settings.openai_api_key)


_MATH_TOKEN_RE = re.compile(
    r"(?i)(\b[a-z]{1,4}\s*=|Î”|Î±|Î²|Î³|Î»|Î¼|Î·|Ï|Ï€|Î£|âˆš|\bm/s\b|\bpa\b|\bmbar\b|\bbar\b|\bkw\b|\bw\b|\bkg/s\b|\bmÂ³/h\b|\bm3/h\b|\d+\s*(pa|mbar|bar|kw|w|kg/s|m/s|mm|cm|mÂ³/h|m3/h))"
)
_TOC_LINE_RE = re.compile(r"\.{2,}\s*\d{1,3}$")


def _get_document(db: Session, doc_id: str) -> Document:
    doc = db.query(Document).filter(Document.id == uuid.UUID(doc_id)).first()
    if not doc:
        raise ValueError(f"Document {doc_id} not found")
    return doc


def _set_document_state(
    db: Session,
    doc_id: str,
    *,
    status: str | None = None,
    current_stage: str | None | object = _UNSET,
    progress_current: int | None | object = _UNSET,
    progress_total: int | None | object = _UNSET,
    error_detail: str | None | object = _UNSET,
):
    doc = _get_document(db, doc_id)
    if status is not None:
        doc.status = status
    if current_stage is not _UNSET:
        doc.current_stage = current_stage
    if progress_current is not _UNSET:
        doc.progress_current = progress_current
    if progress_total is not _UNSET:
        doc.progress_total = progress_total
    if error_detail is not _UNSET:
        doc.error_detail = error_detail
    db.commit()
    return doc


def _start_stage(db: Session, doc_id: str, stage: str, total: int | None = None, current: int = 0):
    _set_document_state(
        db,
        doc_id,
        status=stage,
        current_stage=stage,
        progress_current=current,
        progress_total=total,
        error_detail=None,
    )


def _update_progress(db: Session, doc_id: str, current: int, total: int | None = None):
    _set_document_state(
        db,
        doc_id,
        progress_current=current,
        progress_total=total if total is not None else _UNSET,
    )


def _mark_ready(db: Session, doc_id: str):
    _set_document_state(
        db,
        doc_id,
        status="ready",
        current_stage=None,
        progress_current=None,
        progress_total=None,
        error_detail=None,
    )


def _mark_failed(db: Session, doc_id: str, error: str):
    _set_document_state(
        db,
        doc_id,
        status="failed",
        current_stage=None,
        error_detail=error,
    )


def _page_image_key(document_id: str, page_number: int) -> str:
    return f"documents/{document_id}/pages/{page_number}.png"


def _download_page_image(document_id: str, page_number: int) -> bytes:
    return download_file(_page_image_key(document_id, page_number))


def _is_page_split_complete(page: Page) -> bool:
    return bool(page.image_url)


def _is_page_ocr_complete(page: Page) -> bool:
    return bool(page.markdown and page.ocr_text and page.regions)


def _is_page_caption_complete(page: Page) -> bool:
    regions = page.regions or []
    for region in regions:
        if region.get("type") == "figure" and not region.get("description"):
            return False
    return True


def _document_page_rows(db: Session, doc_id: str) -> list[Page]:
    return (
        db.query(Page)
        .filter(Page.document_id == uuid.UUID(doc_id))
        .order_by(Page.page_number.asc())
        .all()
    )


def _progress_log(doc_id: str, stage: str, current: int, total: int):
    logger.info("[%s] %s progress %s/%s", doc_id, stage, current, total)


def _parse_glm_regions(result) -> list[dict]:
    """Parse GLM-OCR output into our standardized region format."""
    regions = []

    if hasattr(result, "layout") and result.layout:
        for region in result.layout:
            region_type = _map_glm_label(getattr(region, "label", "text"))
            bbox = getattr(region, "bbox", None)
            if bbox is None:
                bbox = getattr(region, "box", [0, 0, 0, 0])

            parsed = {
                "type": region_type,
                "glm_label": getattr(region, "label", "text"),
                "bbox": list(bbox) if bbox else [0, 0, 0, 0],
                "content": getattr(region, "text", ""),
            }

            if region_type == "equation":
                parsed["latex"] = getattr(region, "latex", getattr(region, "text", ""))

            if region_type == "table":
                parsed["content_markdown"] = getattr(region, "text", "")

            regions.append(parsed)
    elif hasattr(result, "json_data") and result.json_data:
        for item in result.json_data:
            region_type = _map_glm_label(item.get("label", "text"))
            regions.append({
                "type": region_type,
                "glm_label": item.get("label", "text"),
                "bbox": item.get("bbox", item.get("box", [0, 0, 0, 0])),
                "content": item.get("text", ""),
                "latex": item.get("latex", "") if region_type == "equation" else None,
                "content_markdown": item.get("text", "") if region_type == "table" else None,
            })

    return regions


_LABEL_MAP = {
    "text": "text",
    "paragraph_title": "text",
    "doc_title": "text",
    "abstract": "text",
    "content": "text",
    "reference": "text",
    "reference_content": "text",
    "aside_text": "text",
    "vertical_text": "text",
    "footnote": "text",
    "display_formula": "equation",
    "inline_formula": "equation",
    "formula_number": "equation",
    "algorithm": "equation",
    "table": "table",
    "image": "figure",
    "chart": "figure",
    "figure_title": "figure",
    "header": "skip",
    "footer": "skip",
    "header_image": "skip",
    "footer_image": "skip",
    "number": "skip",
    "seal": "skip",
    "vision_footnote": "skip",
}


def _map_glm_label(label: str) -> str:
    return _LABEL_MAP.get(label, "text")


def _clean_line(text: str) -> str:
    return " ".join(text.replace("\u00ad", "").split())


def _line_looks_like_equation(text: str) -> bool:
    if len(text) < 3:
        return False
    if _MATH_TOKEN_RE.search(text):
        return True
    if "=" in text and any(ch.isalpha() for ch in text):
        return True
    if "/" in text and any(ch.isalpha() for ch in text) and any(ch.isdigit() for ch in text):
        return True
    return False


def _line_looks_like_toc_entry(text: str) -> bool:
    return _TOC_LINE_RE.search(text) is not None


def _page_is_searchable(text: str) -> bool:
    if len(text.strip()) >= 80:
        return True
    alpha_chars = sum(1 for ch in text if ch.isalpha())
    return alpha_chars >= 40


def _merge_bboxes(bboxes: list[list[float]]) -> list[float]:
    return [
        round(min(b[0] for b in bboxes), 2),
        round(min(b[1] for b in bboxes), 2),
        round(max(b[2] for b in bboxes), 2),
        round(max(b[3] for b in bboxes), 2),
    ]


def _extract_searchable_page(embedded_text: str, text_dict: dict) -> dict:
    markdown = (embedded_text or "").strip()
    regions = []

    for block in text_dict.get("blocks", []):
        if block.get("type") != 0:
            continue
        block_bbox = [round(v, 2) for v in block.get("bbox", [0, 0, 0, 0])]
        block_lines = []
        block_line_bboxes = []
        equation_buffer = []
        equation_bboxes = []
        previous_text_bbox = None

        def flush_text_buffer():
            if not block_lines:
                return
            regions.append({
                "type": "text",
                "glm_label": "text",
                "bbox": _merge_bboxes(block_line_bboxes) if block_line_bboxes else block_bbox,
                "content": "\n".join(block_lines),
            })
            block_lines.clear()
            block_line_bboxes.clear()

        def flush_equation_buffer():
            if not equation_buffer:
                return
            equation_text = "\n".join(equation_buffer)
            regions.append({
                "type": "equation",
                "glm_label": "equation",
                "bbox": _merge_bboxes(equation_bboxes),
                "content": equation_text,
                "latex": equation_text,
            })
            equation_buffer.clear()
            equation_bboxes.clear()

        for line in block.get("lines", []):
            spans = line.get("spans", [])
            line_text = _clean_line("".join(span.get("text", "") for span in spans))
            if not line_text:
                continue
            line_bbox = [round(v, 2) for v in line.get("bbox", block_bbox)]
            if _line_looks_like_equation(line_text):
                flush_text_buffer()
                if equation_bboxes:
                    previous_bbox = equation_bboxes[-1]
                    vertical_gap = line_bbox[1] - previous_bbox[3]
                    left_delta = abs(line_bbox[0] - previous_bbox[0])
                    if vertical_gap > 10 or left_delta > 40:
                        flush_equation_buffer()
                equation_buffer.append(line_text)
                equation_bboxes.append(line_bbox)
            else:
                flush_equation_buffer()
                if previous_text_bbox and block_lines:
                    vertical_gap = line_bbox[1] - previous_text_bbox[3]
                    indent_delta = abs(line_bbox[0] - previous_text_bbox[0])
                    if vertical_gap > 12 or indent_delta > 24 or _line_looks_like_toc_entry(block_lines[-1]):
                        flush_text_buffer()
                block_lines.append(line_text)
                block_line_bboxes.append(line_bbox)
                previous_text_bbox = line_bbox
                if _line_looks_like_toc_entry(line_text):
                    flush_text_buffer()
        flush_equation_buffer()
        flush_text_buffer()

    if not regions and markdown:
        regions.append({
            "type": "text",
            "glm_label": "text",
            "bbox": [0, 0, 0, 0],
            "content": markdown,
        })

    return {
        "markdown": markdown,
        "ocr_text": markdown,
        "regions": regions,
        "ocr_confidence": 1.0,
    }


def _run_openai_page_ocr(image_bytes: bytes) -> dict:
    client = _get_openai_client()
    img_b64 = base64.b64encode(image_bytes).decode()
    response = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=1800,
        response_format={"type": "json_object"},
        messages=[
            {
                "role": "system",
                "content": (
                    "Extract readable engineering-document text from the page image. "
                    "Return JSON with keys markdown, equations, and figures. "
                    "equations must be an array of visible formulas or variable assignments. "
                    "figures must be an array of short technical descriptions for diagrams or drawings."
                ),
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{img_b64}"},
                    },
                    {
                        "type": "text",
                        "text": "Extract the page text and identify formulas and engineering drawings.",
                    },
                ],
            },
        ],
    )
    payload = json.loads(response.choices[0].message.content or "{}")
    markdown = (payload.get("markdown") or "").strip()
    equations = [str(eq).strip() for eq in payload.get("equations", []) if str(eq).strip()]
    figures = [str(fig).strip() for fig in payload.get("figures", []) if str(fig).strip()]
    regions = []

    if markdown:
        regions.append({
            "type": "text",
            "glm_label": "vision_text",
            "bbox": [0, 0, 0, 0],
            "content": markdown,
        })
    for equation in equations:
        regions.append({
            "type": "equation",
            "glm_label": "vision_equation",
            "bbox": [0, 0, 0, 0],
            "content": equation,
            "latex": equation,
        })
    for figure in figures:
        regions.append({
            "type": "figure",
            "glm_label": "vision_figure",
            "bbox": [0, 0, 0, 0],
            "content": figure,
            "description": figure,
        })

    return {
        "markdown": markdown,
        "ocr_text": markdown,
        "regions": regions,
        "ocr_confidence": 0.8,
    }


def _caption_page_regions(regions: list[dict], image_bytes: bytes, client: openai.OpenAI) -> bool:
    updated = False
    img_b64 = None

    for region in regions:
        if region.get("type") != "figure" or region.get("description"):
            continue

        if img_b64 is None:
            img_b64 = base64.b64encode(image_bytes).decode()

        response = client.chat.completions.create(
            model="gpt-4o",
            max_tokens=300,
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{img_b64}"},
                    },
                    {
                        "type": "text",
                        "text": (
                            f"Describe the figure/chart/diagram in the region at bbox {region['bbox']} "
                            "on this page. Be concise and technical. Focus on what data or "
                            "relationships the figure shows."
                        ),
                    },
                ],
            }],
        )
        region["description"] = response.choices[0].message.content
        updated = True

    return updated


def _extract_variables_for_page(regions: list[dict], text_context: str, client: openai.OpenAI) -> bool:
    updated = False
    equations = [r for r in regions if r.get("type") == "equation" and r.get("latex")]
    if not equations or not text_context:
        return False

    for equation in equations:
        if equation.get("variables"):
            continue
        response = client.chat.completions.create(
            model="gpt-4o",
            max_tokens=500,
            messages=[{
                "role": "user",
                "content": (
                    f"Given this equation in LaTeX: {equation['latex']}\n\n"
                    f"And this surrounding text context:\n{text_context[:2000]}\n\n"
                    "Extract the variable definitions as a JSON object where keys are "
                    "variable names and values are their descriptions with units. "
                    "Return ONLY the JSON object, no other text."
                ),
            }],
        )
        text = (response.choices[0].message.content or "").strip()
        if text.startswith("{"):
            equation["variables"] = json.loads(text)
            updated = True
        elif "{" in text and "}" in text:
            json_str = text[text.index("{"):text.rindex("}") + 1]
            equation["variables"] = json.loads(json_str)
            updated = True

    return updated


def _page_to_chunk_payload(page: Page) -> dict:
    return {
        "page_id": str(page.id),
        "page_number": page.page_number,
        "ocr_text": page.ocr_text,
        "markdown": page.markdown,
        "regions": page.regions or [],
    }


def _create_chunks(pages: list[dict], doc_id: str, db: Session) -> list[Chunk]:
    chunks = []

    for page_data in pages:
        regions = page_data.get("regions", [])
        page_id = page_data["page_id"]
        page_number = page_data["page_number"]

        recent_text_context: list[str] = []

        for region in regions:
            if region.get("type") == "skip":
                continue

            if region.get("type") == "text":
                content = (region.get("content") or "").strip()
                if not content:
                    continue
                chunk = Chunk(
                    document_id=uuid.UUID(doc_id),
                    page_id=uuid.UUID(page_id),
                    chunk_type="section",
                    content_text=content,
                    bbox_references=[region.get("bbox", [0, 0, 0, 0])],
                    metadata_={"page_number": page_number},
                )
                db.add(chunk)
                chunks.append(chunk)
                recent_text_context.append(content)
                recent_text_context = recent_text_context[-2:]
                continue

            if region.get("type") == "equation":
                context_before = "\n".join(recent_text_context[-2:]) if recent_text_context else ""
                content = region.get("latex", region.get("content", ""))
                if context_before:
                    content = f"{context_before}\n\n{content}"

                chunk = Chunk(
                    document_id=uuid.UUID(doc_id),
                    page_id=uuid.UUID(page_id),
                    chunk_type="equation",
                    content_text=content,
                    latex=region.get("latex"),
                    variables=region.get("variables"),
                    bbox_references=[region.get("bbox", [0, 0, 0, 0])],
                    metadata_={"page_number": page_number},
                )
                db.add(chunk)
                chunks.append(chunk)
                continue

            if region.get("type") == "table":
                content = region.get("content_markdown", region.get("content", ""))
                chunk = Chunk(
                    document_id=uuid.UUID(doc_id),
                    page_id=uuid.UUID(page_id),
                    chunk_type="table",
                    content_text=content,
                    bbox_references=[region.get("bbox", [0, 0, 0, 0])],
                    metadata_={"page_number": page_number},
                )
                db.add(chunk)
                chunks.append(chunk)
                continue

            if region.get("type") == "figure":
                content = region.get("description", region.get("content", ""))
                caption = region.get("caption", "")
                if caption:
                    content = f"{caption}\n{content}"
                if content.strip():
                    chunk = Chunk(
                        document_id=uuid.UUID(doc_id),
                        page_id=uuid.UUID(page_id),
                        chunk_type="figure",
                        content_text=content,
                        bbox_references=[region.get("bbox", [0, 0, 0, 0])],
                        metadata_={"page_number": page_number},
                    )
                    db.add(chunk)
                    chunks.append(chunk)

        page_text = page_data.get("ocr_text", page_data.get("markdown", ""))
        if page_text and page_text.strip():
            all_bboxes = [r.get("bbox", [0, 0, 0, 0]) for r in regions if r.get("type") != "skip"]
            chunk = Chunk(
                document_id=uuid.UUID(doc_id),
                page_id=uuid.UUID(page_id),
                chunk_type="page",
                content_text=page_text,
                bbox_references=all_bboxes,
                metadata_={"page_number": page_number},
            )
            db.add(chunk)
            chunks.append(chunk)

    db.commit()
    return chunks


def _reset_embeddings_and_chunks(doc_id: str, db: Session):
    document_uuid = uuid.UUID(doc_id)
    db.execute(delete(ChunkEmbedding).where(ChunkEmbedding.chunk_id.in_(
        db.query(Chunk.id).filter(Chunk.document_id == document_uuid).subquery()
    )))
    db.execute(delete(Chunk).where(Chunk.document_id == document_uuid))
    db.commit()


def _generate_embeddings(chunks: list[Chunk], db: Session, doc_id: str):
    client = _get_openai_client()
    total = len(chunks)
    _update_progress(db, doc_id, 0, total)

    batch_size = 100
    completed = 0
    for i in range(0, len(chunks), batch_size):
        batch = chunks[i : i + batch_size]
        texts = [c.content_text[:8000] for c in batch]
        response = client.embeddings.create(
            model=settings.embedding_model,
            input=texts,
            dimensions=settings.embedding_dimensions,
        )

        for j, embedding_data in enumerate(response.data):
            emb = ChunkEmbedding(
                chunk_id=batch[j].id,
                embedding=embedding_data.embedding,
            )
            db.add(emb)
        db.commit()

        completed += len(batch)
        _update_progress(db, doc_id, completed, total)
        if completed == total or completed % _PROGRESS_LOG_INTERVAL == 0:
            _progress_log(doc_id, "embedding", completed, total)


@celery_app.task
def process_document(doc_id: str):
    """Entry-point task kept for compatibility with the API."""
    split_document.delay(doc_id)


@celery_app.task(bind=True, max_retries=2, default_retry_delay=60)
def split_document(self, doc_id: str):
    db = SyncSession()
    pdf_doc = None
    try:
        logger.info("[%s] Stage 1: Splitting PDF into pages", doc_id)
        doc = _get_document(db, doc_id)
        key = f"documents/{doc_id}/original.pdf"
        pdf_bytes = download_file(key)

        pdf_doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        page_count = len(pdf_doc)
        doc.page_count = page_count
        db.commit()

        existing_pages = {page.page_number: page for page in _document_page_rows(db, doc_id)}
        completed = sum(1 for page in existing_pages.values() if _is_page_split_complete(page))
        _start_stage(db, doc_id, "splitting", total=page_count, current=completed)

        for index in range(page_count):
            page_number = index + 1
            page_record = existing_pages.get(page_number)
            if page_record and _is_page_split_complete(page_record):
                continue

            page = pdf_doc[index]
            mat = fitz.Matrix(300 / 72, 300 / 72)
            pix = page.get_pixmap(matrix=mat)
            img_bytes = pix.tobytes("png")
            image_url = upload_page_image(uuid.UUID(doc_id), page_number, img_bytes)

            if page_record is None:
                page_record = Page(
                    document_id=uuid.UUID(doc_id),
                    page_number=page_number,
                    image_url=image_url,
                )
                db.add(page_record)
                existing_pages[page_number] = page_record
            else:
                page_record.image_url = image_url
            db.commit()

            completed += 1
            _update_progress(db, doc_id, completed, page_count)
            if completed == page_count or completed % _PROGRESS_LOG_INTERVAL == 0:
                _progress_log(doc_id, "splitting", completed, page_count)

        logger.info("[%s] Split complete: %s pages", doc_id, page_count)
        run_ocr_stage.delay(doc_id)
    except Exception as exc:
        logger.error("[%s] Split failed: %s", doc_id, exc)
        _mark_failed(db, doc_id, str(exc))
        raise self.retry(exc=exc)
    finally:
        if pdf_doc is not None:
            pdf_doc.close()
        db.close()


@celery_app.task(bind=True, max_retries=2, default_retry_delay=60)
def run_ocr_stage(self, doc_id: str):
    db = SyncSession()
    pdf_doc = None
    try:
        logger.info("[%s] Stage 2: Extracting text with OCR fallback", doc_id)
        pages = _document_page_rows(db, doc_id)
        total = len(pages)
        if total == 0:
            split_document.delay(doc_id)
            return

        completed = sum(1 for page in pages if _is_page_ocr_complete(page))
        _start_stage(db, doc_id, "glm_ocr", total=total, current=completed)

        pdf_bytes = download_file(f"documents/{doc_id}/original.pdf")
        pdf_doc = fitz.open(stream=pdf_bytes, filetype="pdf")

        for page in pages:
            if _is_page_ocr_complete(page):
                continue

            pdf_page = pdf_doc[page.page_number - 1]
            text_page = pdf_page.get_textpage()
            embedded_text = pdf_page.get_text("text", textpage=text_page)
            text_dict = pdf_page.get_text("dict", textpage=text_page)
            image_bytes = _download_page_image(doc_id, page.page_number)

            if _page_is_searchable((embedded_text or "").strip()):
                extracted = _extract_searchable_page(embedded_text, text_dict)
            else:
                logger.info(
                    "[%s] Page %s has weak embedded text, using OpenAI vision fallback",
                    doc_id,
                    page.page_number,
                )
                extracted = _run_openai_page_ocr(image_bytes)

            page.markdown = extracted["markdown"]
            page.ocr_text = extracted["ocr_text"]
            page.regions = extracted["regions"]
            page.ocr_confidence = extracted["ocr_confidence"]
            db.commit()

            completed += 1
            _update_progress(db, doc_id, completed, total)
            if completed == total or completed % _PROGRESS_LOG_INTERVAL == 0:
                _progress_log(doc_id, "glm_ocr", completed, total)

        logger.info("[%s] OCR complete", doc_id)
        caption_document.delay(doc_id)
    except Exception as exc:
        logger.error("[%s] OCR failed: %s", doc_id, exc)
        _mark_failed(db, doc_id, str(exc))
        raise self.retry(exc=exc)
    finally:
        if pdf_doc is not None:
            pdf_doc.close()
        db.close()


@celery_app.task(bind=True, max_retries=2, default_retry_delay=60)
def caption_document(self, doc_id: str):
    db = SyncSession()
    try:
        logger.info("[%s] Stage 3: Captioning figures and extracting variables", doc_id)
        pages = _document_page_rows(db, doc_id)
        total = len(pages)
        completed = sum(1 for page in pages if _is_page_caption_complete(page))
        _start_stage(db, doc_id, "captioning", total=total, current=completed)

        client = _get_openai_client()
        for page in pages:
            if _is_page_caption_complete(page):
                continue

            regions = list(page.regions or [])
            needs_image = any(region.get("type") == "figure" and not region.get("description") for region in regions)
            image_bytes = _download_page_image(doc_id, page.page_number) if needs_image else b""

            updated = False
            if needs_image:
                updated = _caption_page_regions(regions, image_bytes, client) or updated
            updated = _extract_variables_for_page(regions, page.ocr_text or page.markdown or "", client) or updated

            if updated:
                page.regions = regions
                db.commit()

            completed += 1
            _update_progress(db, doc_id, completed, total)
            if completed == total or completed % _PROGRESS_LOG_INTERVAL == 0:
                _progress_log(doc_id, "captioning", completed, total)

        logger.info("[%s] Captioning complete", doc_id)
        embed_document.delay(doc_id)
    except Exception as exc:
        logger.error("[%s] Captioning failed: %s", doc_id, exc)
        _mark_failed(db, doc_id, str(exc))
        raise self.retry(exc=exc)
    finally:
        db.close()


@celery_app.task(bind=True, max_retries=2, default_retry_delay=60)
def embed_document(self, doc_id: str):
    db = SyncSession()
    try:
        logger.info("[%s] Stage 4: Creating chunks and generating embeddings", doc_id)
        pages = _document_page_rows(db, doc_id)
        if not pages:
            split_document.delay(doc_id)
            return

        _start_stage(db, doc_id, "embedding", total=len(pages), current=0)
        _reset_embeddings_and_chunks(doc_id, db)

        page_payloads = []
        for index, page in enumerate(pages, start=1):
            page_payloads.append(_page_to_chunk_payload(page))
            _update_progress(db, doc_id, index, len(pages))
            if index == len(pages) or index % _PROGRESS_LOG_INTERVAL == 0:
                _progress_log(doc_id, "embedding", index, len(pages))

        chunks = _create_chunks(page_payloads, doc_id, db)
        logger.info("[%s] Created %s chunks", doc_id, len(chunks))
        _generate_embeddings(chunks, db, doc_id)

        _mark_ready(db, doc_id)
        logger.info("[%s] Ingestion complete: %s pages, %s chunks", doc_id, len(pages), len(chunks))
    except Exception as exc:
        logger.error("[%s] Embedding failed: %s", doc_id, exc)
        _mark_failed(db, doc_id, str(exc))
        raise self.retry(exc=exc)
    finally:
        db.close()
