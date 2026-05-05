"""One-shot backfill: re-extract LaTeX for every equation chunk in every document.

The ingestion pipeline historically stored OCR'd plaintext in ``chunks.latex``,
which mangled formulas (e.g. "Lw(f) = Kw(f) + 10 1g (11)"). This script walks
every document, re-runs gpt-4o-mini vision extraction over each equation
region, and updates ``chunks.latex`` in place.

Usage::

    python -m scripts.backfill_equation_latex            # all documents
    python -m scripts.backfill_equation_latex <doc_id>   # single document
    python -m scripts.backfill_equation_latex --dry-run  # report counts only

Cost: ~$0.0002 per equation with gpt-4o-mini at high detail. Roughly $0.30
to backfill ~1600 equations across a typical small library.
"""

from __future__ import annotations

import argparse
import logging
import sys
import uuid

import openai
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

# Allow running as ``python -m scripts.backfill_equation_latex`` from backend/.
sys.path.insert(0, ".")

from app.core.config import settings  # noqa: E402
from app.models.chunk import Chunk  # noqa: E402
from app.models.document import Document  # noqa: E402
from app.services.math_extraction import refresh_equation_chunks_for_document  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("backfill_equation_latex")


def _make_session() -> Session:
    sync_url = settings.database_url.replace("+asyncpg", "+psycopg2")
    if "asyncpg" in sync_url:
        sync_url = sync_url.replace("asyncpg", "psycopg2")
    engine = create_engine(sync_url)
    return sessionmaker(engine)()


def _list_documents(db: Session, only: uuid.UUID | None) -> list[Document]:
    stmt = select(Document).order_by(Document.created_at)
    if only is not None:
        stmt = stmt.where(Document.id == only)
    return list(db.execute(stmt).scalars().all())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("document_id", nargs="?", help="Optional UUID; default = all docs")
    parser.add_argument("--dry-run", action="store_true", help="Report counts only, no API calls")
    parser.add_argument("--model", default="gpt-4o-mini", help="OpenAI model to use")
    args = parser.parse_args()

    only_id = uuid.UUID(args.document_id) if args.document_id else None

    db = _make_session()
    try:
        documents = _list_documents(db, only_id)
        if not documents:
            logger.warning("No matching documents found.")
            return 1

        logger.info("Backfilling %d document(s) using %s", len(documents), args.model)
        if args.dry_run:
            for doc in documents:
                count = db.execute(
                    select(Chunk)
                    .where(Chunk.document_id == doc.id, Chunk.chunk_type == "equation")
                ).all()
                logger.info(
                    "  [DRY] %s — %d equation chunks (%s)",
                    doc.id, len(count), doc.filename,
                )
            return 0

        client = openai.OpenAI(api_key=settings.openai_api_key)
        grand_updated = 0
        grand_total = 0
        for doc in documents:
            logger.info("Processing %s — %s", doc.id, doc.filename)
            try:
                updated, total = refresh_equation_chunks_for_document(
                    doc.id, db, client, model=args.model
                )
            except Exception as exc:
                logger.error("  failed: %s", exc)
                continue
            grand_updated += updated
            grand_total += total
            logger.info("  -> %d / %d equation chunks updated", updated, total)

        logger.info("DONE: %d / %d equation chunks updated across %d document(s)",
                    grand_updated, grand_total, len(documents))
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
