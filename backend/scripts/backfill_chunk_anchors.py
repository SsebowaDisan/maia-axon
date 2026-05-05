"""One-shot backfill: re-chunk all existing documents so chunks carry sentence anchors.

The chunking stage was extended to embed ``<c>page.order</c>`` anchor markers
in chunk text and persist a parallel ``anchors`` JSONB list with sentence-
level bboxes (NotebookLM-style). Documents ingested before that change have
chunks without anchors; this script regenerates their chunks (and
embeddings) using the persisted page regions so they participate in the
new sentence-level citation pipeline.

It re-runs the equivalent of the ``embed_document`` Celery stage inline
without touching upstream stages (download / OCR / captioning), so it's
fast and safe to re-run.

Usage::

    python -m scripts.backfill_chunk_anchors            # all ready documents
    python -m scripts.backfill_chunk_anchors <doc_id>   # single doc
"""

from __future__ import annotations

import argparse
import logging
import sys
import uuid

from sqlalchemy.orm import Session

# Allow running as ``python -m scripts.backfill_chunk_anchors`` from backend/.
sys.path.insert(0, ".")

from app.models.document import Document  # noqa: E402
from app.tasks.ingestion import (  # noqa: E402
    SyncSession,
    _create_chunks,
    _document_page_rows,
    _generate_embeddings,
    _page_to_chunk_payload,
    _reset_embeddings_and_chunks,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("backfill_chunk_anchors")


def _list_documents(db: Session, only: uuid.UUID | None) -> list[Document]:
    query = db.query(Document)
    if only is not None:
        query = query.filter(Document.id == only)
    else:
        query = query.filter(Document.status == "ready")
    return query.order_by(Document.created_at).all()


def _backfill_one(db: Session, doc: Document) -> tuple[int, int]:
    """Re-chunk + re-embed a single document. Returns (chunks_created, page_count)."""
    pages = _document_page_rows(db, str(doc.id))
    if not pages:
        return 0, 0

    page_payloads = [_page_to_chunk_payload(page) for page in pages]
    _reset_embeddings_and_chunks(str(doc.id), db)
    chunks = _create_chunks(page_payloads, str(doc.id), db)
    _generate_embeddings(chunks, db, str(doc.id))
    return len(chunks), len(pages)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("document_id", nargs="?", help="Optional UUID; default = all ready docs")
    args = parser.parse_args()

    only_id = uuid.UUID(args.document_id) if args.document_id else None

    db = SyncSession()
    try:
        documents = _list_documents(db, only_id)
        if not documents:
            logger.warning("No matching documents found.")
            return 1

        logger.info("Backfilling chunk anchors for %d document(s)", len(documents))
        for doc in documents:
            logger.info("Processing %s — %s", doc.id, doc.filename)
            try:
                chunk_count, page_count = _backfill_one(db, doc)
            except Exception as exc:  # pragma: no cover
                logger.error("  failed: %s", exc)
                continue
            logger.info("  -> %d chunks across %d pages", chunk_count, page_count)

        logger.info("DONE")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
