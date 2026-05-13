"""Maintenance CLI for one-off / admin operations.

Run via ``python -m app.cli <command> ...`` from the backend
directory. Designed for the things that don't belong in the
HTTP API or the Celery chain: backfilling new pipeline stages
over existing documents, debugging a single document's
enrichment without waiting for a worker, etc.

Subcommands
-----------
``enrich-document <document_id>``
    Run the section_mapping stage on one document synchronously,
    against the same database the API uses. Useful for:
      * backfilling documents ingested before section_mapping
        was added to the pipeline;
      * tuning the enrichment prompt while watching the output
        live (logs stream to stderr).
    Idempotent — re-running on the same document wipes its
    existing section tree and rebuilds.

``backfill-sections``
    Run ``enrich-document`` against every document whose
    status is ``ready`` (post-ingestion) but which has no
    ``document_sections`` rows yet. Skips anything currently
    processing. Useful right after deploying the
    section_mapping stage so old PDFs catch up.

``build-concept-graph <document_id>``
    Rebuild one document's concept-graph contribution from its
    current section_mapping output. Idempotent — replaces the
    document's existing Concept links + edges in one transaction.
    Useful when iterating on the enrichment prompt and re-running
    just the graph derivation step.

``dedupe-concepts``
    Run the corpus-wide concept deduplication pass. Clusters
    near-identical concepts by embedding similarity, asks the
    LLM to confirm each cluster, and merges confirmed duplicates
    into a single canonical concept. Run periodically (or after
    a large batch of ingestion).

``generate-questions <document_id>``
    Rebuild one document's per-section check-in questions from
    its current enrichment payload. Idempotent — wipes existing
    SectionQuestion rows for the document first. Math questions
    are self-graded via SymPy before storage; non-passing ones
    are dropped.
"""

from __future__ import annotations

import argparse
import logging
import sys
import uuid

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.models.document import Document, DocumentSection

# Background tasks use sync SQLAlchemy (the API uses async); the CLI
# follows the same pattern as Celery so we share connection-pool
# behaviour and avoid pulling in the async runtime for what is a
# blocking, single-process script.
_sync_url = settings.database_url.replace("+asyncpg", "+psycopg2")
if "asyncpg" in _sync_url:
    _sync_url = _sync_url.replace("asyncpg", "psycopg2")
_engine = create_engine(_sync_url)
SyncSession = sessionmaker(_engine)


def _configure_logging(verbose: bool) -> None:
    """Mirror the worker's log format so traces line up."""
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s — %(message)s",
        stream=sys.stderr,
    )
    # Quiet the noisy http libraries so the enrichment output is
    # readable when tailing the run.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("openai").setLevel(logging.WARNING)


def _cmd_enrich_document(args: argparse.Namespace) -> int:
    """Synchronous run of section_mapping for a single document.

    Errors are logged with full tracebacks and the process exits
    non-zero so a CI / shell loop calling this on many ids can fail
    loudly without rolling its own retry.
    """
    # Lazy import so simply running ``python -m app.cli --help``
    # doesn't pay the import cost of fitz, openai, etc.
    from app.tasks.section_mapping import run_section_mapping

    try:
        document_uuid = uuid.UUID(args.document_id)
    except ValueError:
        print(f"Invalid document_id: {args.document_id!r}", file=sys.stderr)
        return 2

    db = SyncSession()
    try:
        document = db.query(Document).filter(Document.id == document_uuid).first()
        if document is None:
            print(f"Document {args.document_id} not found.", file=sys.stderr)
            return 1
        print(
            f"Enriching '{document.filename}' (id={document.id}, "
            f"{document.page_count or '?'} pages, status={document.status}) …",
            file=sys.stderr,
        )
        stats = run_section_mapping(db, str(document.id))
    except Exception as exc:  # noqa: BLE001 — CLI surface should print full error
        logging.exception("section_mapping failed for %s", args.document_id)
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1
    finally:
        db.close()

    print(
        "OK: "
        f"{stats['headlines']} headlines, "
        f"{stats['topics_and_subtopics']} topics+subtopics, "
        f"{stats['embeddings']} embeddings",
        file=sys.stderr,
    )
    return 0


def _cmd_backfill_sections(args: argparse.Namespace) -> int:
    """Run enrichment on every document that is `ready` but has no
    section rows yet. Sequential, not parallel — section_mapping is
    expensive and we'd rather respect rate limits than thrash."""
    from app.tasks.section_mapping import run_section_mapping

    db = SyncSession()
    try:
        # Subquery: documents that already have at least one section.
        has_sections_subquery = (
            select(DocumentSection.document_id)
            .group_by(DocumentSection.document_id)
            .having(func.count(DocumentSection.id) > 0)
        )
        candidates = (
            db.query(Document)
            .filter(Document.status == "ready")
            .filter(Document.id.notin_(has_sections_subquery))
            .order_by(Document.created_at.asc())
            .all()
        )
    finally:
        db.close()

    if not candidates:
        print("No documents to backfill — all `ready` PDFs already enriched.", file=sys.stderr)
        return 0

    print(f"Backfilling {len(candidates)} document(s) …", file=sys.stderr)
    failures = 0
    for index, document in enumerate(candidates, start=1):
        print(
            f"[{index}/{len(candidates)}] {document.filename} (id={document.id})",
            file=sys.stderr,
        )
        if args.dry_run:
            continue
        db = SyncSession()
        try:
            stats = run_section_mapping(db, str(document.id))
            print(
                f"    → {stats['headlines']} headlines, "
                f"{stats['embeddings']} embeddings",
                file=sys.stderr,
            )
        except Exception as exc:  # noqa: BLE001
            failures += 1
            logging.exception("backfill failed for %s", document.id)
            print(f"    → FAILED: {exc}", file=sys.stderr)
        finally:
            db.close()

    if failures:
        print(f"Done with {failures} failure(s).", file=sys.stderr)
        return 1
    print("Done.", file=sys.stderr)
    return 0


def _cmd_build_concept_graph(args: argparse.Namespace) -> int:
    """Rebuild one document's concept-graph contribution.

    Synchronous. Useful when iterating on the enrichment prompt or
    re-running graph derivation for a single doc without touching
    section_mapping itself.
    """
    from app.tasks.concept_graph import build_concept_graph_for_document

    try:
        document_uuid = uuid.UUID(args.document_id)
    except ValueError:
        print(f"Invalid document_id: {args.document_id!r}", file=sys.stderr)
        return 2

    db = SyncSession()
    try:
        from app.models.document import Document  # local import keeps top-level small
        document = db.query(Document).filter(Document.id == document_uuid).first()
        if document is None:
            print(f"Document {args.document_id} not found.", file=sys.stderr)
            return 1
        print(
            f"Building concept graph for '{document.filename}' (id={document.id}) …",
            file=sys.stderr,
        )
        stats = build_concept_graph_for_document(db, str(document.id))
    except Exception as exc:  # noqa: BLE001
        logging.exception("concept_graph build failed for %s", args.document_id)
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1
    finally:
        db.close()

    print(
        "OK: "
        f"sections={stats['sections_seen']}, "
        f"new_concepts={stats['concepts_created']}, "
        f"reused={stats['concepts_reused']}, "
        f"introductions={stats['introductions']}, "
        f"applications={stats['applications']}, "
        f"edges={stats['edges']}, "
        f"orphans_removed={stats['orphans_removed']}",
        file=sys.stderr,
    )
    return 0


def _cmd_dedupe_concepts(args: argparse.Namespace) -> int:
    """Cross-book concept deduplication pass.

    Clusters concepts by embedding similarity, confirms each cluster
    via the LLM, merges duplicates. Safe to re-run; already-merged
    clusters won't re-trigger.
    """
    from app.tasks.concept_graph import deduplicate_concepts_corpus

    db = SyncSession()
    try:
        stats = deduplicate_concepts_corpus(
            db, similarity_threshold=args.similarity
        )
    except Exception as exc:  # noqa: BLE001
        logging.exception("concept deduplication failed")
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1
    finally:
        db.close()

    print(
        "OK: "
        f"clusters_examined={stats['clusters_examined']}, "
        f"merges_performed={stats['merges_performed']}, "
        f"concepts_merged={stats['concepts_merged']}",
        file=sys.stderr,
    )
    return 0


def _cmd_group_chapters(args: argparse.Namespace) -> int:
    """Re-run only the thematic chapter-grouping LLM call on a
    document that already has sections persisted. Useful when
    iterating on the grouping prompt without re-enriching all
    headlines."""
    from app.tasks.section_mapping import _generate_chapter_groups, _get_openai_client
    from dataclasses import dataclass, field

    try:
        document_uuid = uuid.UUID(args.document_id)
    except ValueError:
        print(f"Invalid document_id: {args.document_id!r}", file=sys.stderr)
        return 2

    @dataclass
    class _FakeNode:
        # Minimal duck-type for what _generate_chapter_groups reads
        # off SkeletonNode: title, content_json, page_start. We avoid
        # importing SkeletonNode (and dragging in fitz) so the CLI
        # stays lightweight.
        title: str
        content_json: dict | None
        page_start: int
        children: list = field(default_factory=list)

    db = SyncSession()
    try:
        document = db.query(Document).filter(Document.id == document_uuid).first()
        if document is None:
            print(f"Document {args.document_id} not found.", file=sys.stderr)
            return 1
        chapter_rows = (
            db.query(DocumentSection)
            .filter(DocumentSection.document_id == document_uuid)
            .filter(DocumentSection.parent_id.is_(None))
            .order_by(DocumentSection.page_start.asc(), DocumentSection.ordinal.asc())
            .all()
        )
        if not chapter_rows:
            print("No top-level chapters; run enrich-document first.", file=sys.stderr)
            return 1
        print(
            f"Grouping {len(chapter_rows)} chapter(s) for "
            f"'{document.filename}' (id={document.id}) …",
            file=sys.stderr,
        )
        fake_roots = [
            _FakeNode(
                title=row.title,
                content_json=row.content_json,
                page_start=row.page_start,
            )
            for row in chapter_rows
        ]
        root_ids = {i: str(row.id) for i, row in enumerate(chapter_rows)}
        client = _get_openai_client()
        groups = _generate_chapter_groups(client, fake_roots, root_ids)
        if not groups:
            print(
                "Grouping returned empty — likely too few chapters or "
                "LLM validator failed. Existing groups unchanged.",
                file=sys.stderr,
            )
            return 1
        document.chapter_groups_json = groups
        db.commit()
    except Exception as exc:  # noqa: BLE001
        logging.exception("chapter grouping failed for %s", args.document_id)
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1
    finally:
        db.close()

    print(
        f"OK: {len(groups)} group(s): " + ", ".join(g["name"] for g in groups),
        file=sys.stderr,
    )
    return 0


def _cmd_generate_questions(args: argparse.Namespace) -> int:
    """Rebuild one document's per-section check-in questions."""
    from app.tasks.question_generation import generate_questions_for_document

    try:
        document_uuid = uuid.UUID(args.document_id)
    except ValueError:
        print(f"Invalid document_id: {args.document_id!r}", file=sys.stderr)
        return 2

    db = SyncSession()
    try:
        from app.models.document import Document
        document = db.query(Document).filter(Document.id == document_uuid).first()
        if document is None:
            print(f"Document {args.document_id} not found.", file=sys.stderr)
            return 1
        print(
            f"Generating questions for '{document.filename}' (id={document.id}) …",
            file=sys.stderr,
        )
        stats = generate_questions_for_document(db, str(document.id))
    except Exception as exc:  # noqa: BLE001
        logging.exception("question generation failed for %s", args.document_id)
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1
    finally:
        db.close()

    print(
        "OK: "
        f"sections_processed={stats['sections_processed']}, "
        f"kept={stats['questions_kept']}, "
        f"rejected_schema={stats['questions_rejected_schema']}, "
        f"rejected_math={stats['questions_rejected_math']}",
        file=sys.stderr,
    )
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.cli",
        description="Maia Axon backend maintenance CLI.",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Enable DEBUG-level logging.",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    enrich = subparsers.add_parser(
        "enrich-document",
        help="Run section_mapping on one document (synchronous).",
    )
    enrich.add_argument(
        "document_id",
        help="UUID of the document to enrich.",
    )
    enrich.set_defaults(func=_cmd_enrich_document)

    backfill = subparsers.add_parser(
        "backfill-sections",
        help="Run section_mapping on every `ready` document without sections.",
    )
    backfill.add_argument(
        "--dry-run",
        action="store_true",
        help="List documents that would be enriched, but don't run.",
    )
    backfill.set_defaults(func=_cmd_backfill_sections)

    build_graph = subparsers.add_parser(
        "build-concept-graph",
        help="Rebuild one document's concept-graph contribution.",
    )
    build_graph.add_argument(
        "document_id",
        help="UUID of the document whose concept-graph contribution should be rebuilt.",
    )
    build_graph.set_defaults(func=_cmd_build_concept_graph)

    dedupe = subparsers.add_parser(
        "dedupe-concepts",
        help="Cross-book concept deduplication pass (clusters by embedding + LLM confirms merges).",
    )
    dedupe.add_argument(
        "--similarity",
        type=float,
        default=0.90,
        help=(
            "Cosine-similarity threshold for cluster candidates. "
            "Default 0.90; lower → more candidate clusters → more LLM "
            "calls."
        ),
    )
    dedupe.set_defaults(func=_cmd_dedupe_concepts)

    gen_questions = subparsers.add_parser(
        "generate-questions",
        help="Rebuild one document's per-section check-in questions.",
    )
    gen_questions.add_argument(
        "document_id",
        help="UUID of the document whose questions should be regenerated.",
    )
    gen_questions.set_defaults(func=_cmd_generate_questions)

    group_chapters = subparsers.add_parser(
        "group-chapters",
        help="Re-run the chapter-grouping LLM call for one document.",
    )
    group_chapters.add_argument(
        "document_id",
        help="UUID of the document to (re-)group.",
    )
    group_chapters.set_defaults(func=_cmd_group_chapters)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    _configure_logging(args.verbose)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
