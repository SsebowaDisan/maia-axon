"""
Ingestion pipeline: PDF → pages → GLM-OCR → figure captioning → chunking → embedding.

This is the most critical system. Each stage updates the document status so the
frontend can show progress: splitting → glm_ocr → captioning → embedding → ready.
"""
import base64
import json
import logging
import uuid

import fitz  # PyMuPDF
import openai
from sqlalchemy import create_engine
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


def _get_openai_client() -> openai.OpenAI:
    return openai.OpenAI(api_key=settings.openai_api_key)


def _update_status(db: Session, doc_id: str, status: str, error: str | None = None):
    doc = db.query(Document).filter(Document.id == uuid.UUID(doc_id)).first()
    if doc:
        doc.status = status
        if error:
            doc.error_detail = error
        db.commit()


# ---- Stage 1: Split PDF into page images ----


def _split_pdf(doc_id: str, db: Session) -> list[dict]:
    """Split PDF into page images, store in S3, create Page records."""
    doc = db.query(Document).filter(Document.id == uuid.UUID(doc_id)).first()
    if not doc:
        raise ValueError(f"Document {doc_id} not found")

    key = f"documents/{doc_id}/original.pdf"
    pdf_bytes = download_file(key)

    pdf_doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    page_count = len(pdf_doc)
    doc.page_count = page_count
    db.commit()

    pages = []
    for page_num in range(page_count):
        page = pdf_doc[page_num]
        # Render at 300 DPI for high-quality OCR
        mat = fitz.Matrix(300 / 72, 300 / 72)
        pix = page.get_pixmap(matrix=mat)
        img_bytes = pix.tobytes("png")

        image_url = upload_page_image(uuid.UUID(doc_id), page_num + 1, img_bytes)

        page_record = Page(
            document_id=uuid.UUID(doc_id),
            page_number=page_num + 1,
            image_url=image_url,
        )
        db.add(page_record)
        db.flush()

        pages.append({
            "page_id": str(page_record.id),
            "page_number": page_num + 1,
            "image_url": image_url,
            "image_bytes": img_bytes,
        })

    db.commit()
    pdf_doc.close()
    return pages


# ---- Stage 2: GLM-OCR processing ----


def _run_glm_ocr(pages: list[dict], doc_id: str, db: Session) -> list[dict]:
    """Run GLM-OCR on each page image. Returns enriched page data with regions."""
    try:
        from glmocr import GlmOcr, parse
    except ImportError:
        logger.warning("glmocr not installed, using fallback OCR")
        return _fallback_ocr(pages, doc_id, db)

    results = []
    for page_data in pages:
        try:
            result = parse(
                page_data["image_bytes"],
                output_format="both",
                enable_merge_formula_numbers=True,
                layout_nms=True,
            )

            markdown = result.markdown if hasattr(result, "markdown") else str(result)
            regions = _parse_glm_regions(result)
            ocr_text = result.text if hasattr(result, "text") else markdown

            page = db.query(Page).filter(Page.id == uuid.UUID(page_data["page_id"])).first()
            if page:
                page.markdown = markdown
                page.ocr_text = ocr_text
                page.regions = regions
                page.ocr_confidence = _estimate_confidence(regions)

            results.append({
                **page_data,
                "markdown": markdown,
                "ocr_text": ocr_text,
                "regions": regions,
            })
        except Exception as e:
            logger.error(f"GLM-OCR failed on page {page_data['page_number']}: {e}")
            results.append({**page_data, "markdown": "", "ocr_text": "", "regions": []})

    db.commit()
    return results


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


# GLM-OCR label → our chunk type mapping
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


def _estimate_confidence(regions: list[dict]) -> float:
    if not regions:
        return 0.0
    non_empty = sum(1 for r in regions if r.get("content"))
    return min(non_empty / max(len(regions), 1), 1.0)


def _fallback_ocr(pages: list[dict], doc_id: str, db: Session) -> list[dict]:
    """Fallback: use PyMuPDF text extraction when GLM-OCR is unavailable."""
    key = f"documents/{doc_id}/original.pdf"
    pdf_bytes = download_file(key)
    pdf_doc = fitz.open(stream=pdf_bytes, filetype="pdf")

    results = []
    for page_data in pages:
        page_num = page_data["page_number"] - 1
        page = pdf_doc[page_num]
        text = page.get_text()

        page_record = db.query(Page).filter(Page.id == uuid.UUID(page_data["page_id"])).first()
        if page_record:
            page_record.ocr_text = text
            page_record.markdown = text
            page_record.regions = [{"type": "text", "glm_label": "text", "bbox": [0, 0, 0, 0], "content": text}]

        results.append({**page_data, "markdown": text, "ocr_text": text, "regions": [{"type": "text", "content": text}]})

    db.commit()
    pdf_doc.close()
    return results


# ---- Stage 3: Figure captioning (OpenAI GPT-4o Vision) ----


def _caption_figures(pages: list[dict], doc_id: str, db: Session) -> list[dict]:
    """Send image/chart regions to GPT-4o Vision for text descriptions."""
    client = _get_openai_client()

    for page_data in pages:
        regions = page_data.get("regions", [])
        updated = False

        for region in regions:
            if region["type"] != "figure":
                continue
            if region.get("description"):
                continue

            try:
                img_b64 = base64.b64encode(page_data["image_bytes"]).decode()

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
            except Exception as e:
                logger.error(f"Figure captioning failed: {e}")
                region["description"] = region.get("content", "")

        if updated:
            page_record = db.query(Page).filter(Page.id == uuid.UUID(page_data["page_id"])).first()
            if page_record:
                page_record.regions = regions

    db.commit()
    return pages


# ---- Stage 4: Variable extraction (LLM post-processing for equations) ----


def _extract_variables(pages: list[dict], db: Session):
    """Post-process equations: map LaTeX variables to definitions using surrounding text."""
    client = _get_openai_client()

    for page_data in pages:
        regions = page_data.get("regions", [])
        equations = [r for r in regions if r["type"] == "equation" and r.get("latex")]
        if not equations:
            continue

        text_context = "\n".join(
            r.get("content", "") for r in regions if r["type"] == "text" and r.get("content")
        )
        if not text_context:
            continue

        for eq in equations:
            try:
                response = client.chat.completions.create(
                    model="gpt-4o",
                    max_tokens=500,
                    messages=[{
                        "role": "user",
                        "content": (
                            f"Given this equation in LaTeX: {eq['latex']}\n\n"
                            f"And this surrounding text context:\n{text_context[:2000]}\n\n"
                            "Extract the variable definitions as a JSON object where keys are "
                            "variable names and values are their descriptions with units. "
                            "Return ONLY the JSON object, no other text."
                        ),
                    }],
                )
                text = response.choices[0].message.content.strip()
                if text.startswith("{"):
                    eq["variables"] = json.loads(text)
                elif "{" in text:
                    json_str = text[text.index("{"):text.rindex("}") + 1]
                    eq["variables"] = json.loads(json_str)
            except Exception as e:
                logger.debug(f"Variable extraction failed for equation: {e}")

        page_record = db.query(Page).filter(Page.id == uuid.UUID(page_data["page_id"])).first()
        if page_record:
            page_record.regions = regions

    db.commit()


# ---- Stage 5: Chunking ----


def _create_chunks(pages: list[dict], doc_id: str, db: Session) -> list[Chunk]:
    """Create structural chunks from page regions."""
    chunks = []

    for page_data in pages:
        regions = page_data.get("regions", [])
        page_id = page_data["page_id"]
        page_number = page_data["page_number"]

        text_buffer = []
        text_bboxes = []

        for region in regions:
            if region["type"] == "skip":
                continue

            if region["type"] == "text":
                text_buffer.append(region.get("content", ""))
                text_bboxes.append(region.get("bbox", [0, 0, 0, 0]))
                continue

            # Flush text buffer before non-text region
            if text_buffer:
                content = "\n".join(text_buffer)
                if content.strip():
                    chunk = Chunk(
                        document_id=uuid.UUID(doc_id),
                        page_id=uuid.UUID(page_id),
                        chunk_type="section",
                        content_text=content,
                        bbox_references=text_bboxes.copy(),
                        metadata_={"page_number": page_number},
                    )
                    db.add(chunk)
                    chunks.append(chunk)
                text_buffer.clear()
                text_bboxes.clear()

            if region["type"] == "equation":
                context_before = "\n".join(text_buffer[-2:]) if text_buffer else ""
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

            elif region["type"] == "table":
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

            elif region["type"] == "figure":
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

        # Flush remaining text
        if text_buffer:
            content = "\n".join(text_buffer)
            if content.strip():
                chunk = Chunk(
                    document_id=uuid.UUID(doc_id),
                    page_id=uuid.UUID(page_id),
                    chunk_type="section",
                    content_text=content,
                    bbox_references=text_bboxes.copy(),
                    metadata_={"page_number": page_number},
                )
                db.add(chunk)
                chunks.append(chunk)

        # Full-page chunk as fallback
        page_text = page_data.get("ocr_text", page_data.get("markdown", ""))
        if page_text and page_text.strip():
            all_bboxes = [r.get("bbox", [0, 0, 0, 0]) for r in regions if r["type"] != "skip"]
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


# ---- Stage 6: Generate embeddings ----


def _generate_embeddings(chunks: list[Chunk], db: Session):
    """Generate embeddings for all chunks using OpenAI text-embedding-3-large."""
    client = _get_openai_client()

    batch_size = 100
    for i in range(0, len(chunks), batch_size):
        batch = chunks[i : i + batch_size]
        texts = [c.content_text[:8000] for c in batch]

        try:
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

        except Exception as e:
            logger.error(f"Embedding generation failed for batch {i}: {e}")
            raise

    db.commit()


# ---- Main pipeline task ----


@celery_app.task(bind=True, max_retries=2, default_retry_delay=60)
def process_document(self, doc_id: str):
    """
    Main ingestion pipeline. Processes a PDF through all stages:
    splitting → glm_ocr → captioning → embedding → ready
    """
    db = SyncSession()
    try:
        # Stage 1: Split PDF into pages
        logger.info(f"[{doc_id}] Stage 1: Splitting PDF into pages")
        _update_status(db, doc_id, "splitting")
        pages = _split_pdf(doc_id, db)
        logger.info(f"[{doc_id}] Split into {len(pages)} pages")

        # Stage 2: GLM-OCR
        logger.info(f"[{doc_id}] Stage 2: Running GLM-OCR")
        _update_status(db, doc_id, "glm_ocr")
        pages = _run_glm_ocr(pages, doc_id, db)

        # Stage 3: Figure captioning
        logger.info(f"[{doc_id}] Stage 3: Captioning figures")
        _update_status(db, doc_id, "captioning")
        pages = _caption_figures(pages, doc_id, db)

        # Stage 3b: Variable extraction for equations
        logger.info(f"[{doc_id}] Stage 3b: Extracting variables from equations")
        _extract_variables(pages, db)

        # Stage 4: Chunking
        logger.info(f"[{doc_id}] Stage 4: Creating chunks")
        _update_status(db, doc_id, "embedding")

        # Free memory
        for p in pages:
            p.pop("image_bytes", None)

        chunks = _create_chunks(pages, doc_id, db)
        logger.info(f"[{doc_id}] Created {len(chunks)} chunks")

        # Stage 5: Embeddings
        logger.info(f"[{doc_id}] Stage 5: Generating embeddings")
        _generate_embeddings(chunks, db)

        # Done
        _update_status(db, doc_id, "ready")
        logger.info(f"[{doc_id}] Ingestion complete: {len(pages)} pages, {len(chunks)} chunks")

    except Exception as e:
        logger.error(f"[{doc_id}] Ingestion failed: {e}")
        _update_status(db, doc_id, "failed", str(e))
        db.rollback()
        raise self.retry(exc=e)
    finally:
        db.close()
