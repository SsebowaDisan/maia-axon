"""Admin endpoints for reviewing and correcting LLM-generated
learn-mode artefacts.

Three surfaces:

* Section browser — list documents with section counts and
  review-flag counts; drill into a document's section tree; edit
  the enrichment payload for a section; regenerate (re-run the
  enrichment LLM call) for a single section; delete a section.

* Question reviewer — list a section's questions WITH answer keys,
  patch a question's stem / explanation / payload; regenerate a
  single question or all questions for a section.

* Concept graph viewer — list canonical concepts with section
  counts; merge two concept rows (repointing all links).

All endpoints are admin-gated. Edits clear the corresponding
``review_flags`` on the section payload (a human review is the
final word). Regeneration calls reuse the same sync-service
machinery the offline pipelines use.

Why a separate module from ``learn.py``?
    ``learn.py`` is the user-facing surface: starting paths, taking
    check-ins, reading mastery. This module is the moderator's
    surface: editing what the LLM generated. They share no schema
    or auth-shape, and keeping them apart keeps the user surface
    free of admin-only paths.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from app.api.deps import get_current_user, require_admin
from app.core.database import SyncSessionLocal, get_db
from app.models.concept import (
    Concept,
    ConceptApplication,
    ConceptEdge,
    ConceptIntroduction,
)
from app.models.document import Document, DocumentSection
from app.models.question import SectionQuestion
from app.models.user import User

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/admin/learn", tags=["admin-learn"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class AdminDocumentRow(BaseModel):
    id: uuid.UUID
    filename: str
    page_count: int | None
    section_count: int
    flagged_section_count: int
    question_count: int
    updated_at: datetime


class AdminSectionSummary(BaseModel):
    id: uuid.UUID
    parent_id: uuid.UUID | None
    kind: str
    title: str
    page_start: int
    page_end: int
    ordinal: int
    review_flags: list[str]
    has_questions: bool


class AdminSectionDetail(BaseModel):
    id: uuid.UUID
    document_id: uuid.UUID
    parent_id: uuid.UUID | None
    kind: str
    title: str
    page_start: int
    page_end: int
    ordinal: int
    content_json: dict[str, Any] | None
    question_count: int


class SectionPatch(BaseModel):
    """Fields the admin can override on a section.

    All optional — any provided field replaces the LLM value. The
    admin's edit is treated as authoritative: ``review_flags`` is
    cleared whenever a patch lands.
    """

    title: str | None = None
    content_summary: str | None = None
    content_json: dict[str, Any] | None = None


class AdminQuestionRow(BaseModel):
    id: uuid.UUID
    section_id: uuid.UUID
    question_type: str
    stem: str
    payload: dict[str, Any]
    explanation: str
    concept_ids: list[str]
    difficulty: int
    estimated_seconds: int
    misconception_tags: list[str]
    display_ordinal: int
    review_meta: dict[str, Any] | None  # source_quote, confidence, leakage_flag


class QuestionPatch(BaseModel):
    stem: str | None = None
    explanation: str | None = None
    payload: dict[str, Any] | None = None
    difficulty: int | None = None
    estimated_seconds: int | None = None


class AdminConceptRow(BaseModel):
    id: uuid.UUID
    canonical_name: str
    canonical_definition: str
    aliases: list[str] | None
    difficulty_tier: int | None
    introduction_count: int
    application_count: int


class ConceptMergePayload(BaseModel):
    keep_id: uuid.UUID
    absorb_id: uuid.UUID


# ---------------------------------------------------------------------------
# Documents listing
# ---------------------------------------------------------------------------


@router.get("/documents", response_model=list[AdminDocumentRow])
async def list_documents(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> list[AdminDocumentRow]:
    """List documents alongside enrichment health stats.

    Returns: section count, flagged-section count, question count
    for each document. Sorted by most-recently-updated so the
    admin sees newly-ingested books at the top of the queue.
    """
    docs = (await db.execute(select(Document).order_by(Document.updated_at.desc()))).scalars().all()

    section_counts = dict(
        (row.document_id, row.cnt)
        for row in (
            await db.execute(
                select(
                    DocumentSection.document_id,
                    func.count(DocumentSection.id).label("cnt"),
                ).group_by(DocumentSection.document_id)
            )
        ).all()
    )
    question_counts = dict(
        (row.document_id, row.cnt)
        for row in (
            await db.execute(
                select(
                    DocumentSection.document_id,
                    func.count(SectionQuestion.id).label("cnt"),
                )
                .join(SectionQuestion, SectionQuestion.section_id == DocumentSection.id)
                .group_by(DocumentSection.document_id)
            )
        ).all()
    )

    # Flagged count — needs to inspect the JSONB content_json
    # review_flags array. Pull just the sections that have a
    # non-empty review_flags entry; group-by in Python is cheaper
    # than a JSONB query for the scale we care about (hundreds of
    # sections per document).
    flagged_counts: dict[uuid.UUID, int] = {}
    flagged_rows = (
        await db.execute(
            select(DocumentSection.document_id, DocumentSection.content_json).where(
                DocumentSection.kind == "headline"
            )
        )
    ).all()
    for doc_id, content_json in flagged_rows:
        if isinstance(content_json, dict):
            flags = content_json.get("review_flags") or []
            if isinstance(flags, list) and flags:
                flagged_counts[doc_id] = flagged_counts.get(doc_id, 0) + 1

    return [
        AdminDocumentRow(
            id=doc.id,
            filename=doc.filename,
            page_count=doc.page_count,
            section_count=section_counts.get(doc.id, 0),
            flagged_section_count=flagged_counts.get(doc.id, 0),
            question_count=question_counts.get(doc.id, 0),
            updated_at=doc.updated_at,
        )
        for doc in docs
    ]


# ---------------------------------------------------------------------------
# Section browser
# ---------------------------------------------------------------------------


@router.get(
    "/documents/{document_id}/sections",
    response_model=list[AdminSectionSummary],
)
async def list_sections_for_document(
    document_id: uuid.UUID,
    flagged_only: bool = Query(default=False),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> list[AdminSectionSummary]:
    """Flat list of all sections (topic / subtopic / headline) for
    one document. The frontend assembles the tree client-side using
    parent_id. ``flagged_only`` filters to sections whose payload
    contains a non-empty ``review_flags`` array."""
    rows = (
        await db.execute(
            select(DocumentSection)
            .where(DocumentSection.document_id == document_id)
            .order_by(DocumentSection.page_start.asc(), DocumentSection.ordinal.asc())
        )
    ).scalars().all()

    question_section_ids = set(
        row.section_id
        for row in (
            await db.execute(
                select(SectionQuestion.section_id).distinct()
            )
        ).all()
    )

    summaries: list[AdminSectionSummary] = []
    for row in rows:
        content = row.content_json or {}
        flags = content.get("review_flags") if isinstance(content, dict) else None
        flags = [str(f) for f in flags] if isinstance(flags, list) else []
        if flagged_only and not flags:
            continue
        summaries.append(
            AdminSectionSummary(
                id=row.id,
                parent_id=row.parent_id,
                kind=row.kind,
                title=row.title,
                page_start=row.page_start,
                page_end=row.page_end,
                ordinal=row.ordinal,
                review_flags=flags,
                has_questions=row.id in question_section_ids,
            )
        )
    return summaries


@router.get("/sections/{section_id}", response_model=AdminSectionDetail)
async def get_section_detail(
    section_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> AdminSectionDetail:
    """Full section payload — content_json with summary, concepts,
    equations, verification flags, etc."""
    section = await db.scalar(
        select(DocumentSection).where(DocumentSection.id == section_id)
    )
    if section is None:
        raise HTTPException(status_code=404, detail="Section not found")
    question_count = await db.scalar(
        select(func.count(SectionQuestion.id)).where(SectionQuestion.section_id == section_id)
    )
    return AdminSectionDetail(
        id=section.id,
        document_id=section.document_id,
        parent_id=section.parent_id,
        kind=section.kind,
        title=section.title,
        page_start=section.page_start,
        page_end=section.page_end,
        ordinal=section.ordinal,
        content_json=section.content_json,
        question_count=int(question_count or 0),
    )


@router.patch("/sections/{section_id}", response_model=AdminSectionDetail)
async def patch_section(
    section_id: uuid.UUID,
    payload: SectionPatch,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> AdminSectionDetail:
    """Apply an admin override. Clears ``review_flags`` since a
    human just looked at the section."""
    section = await db.scalar(
        select(DocumentSection).where(DocumentSection.id == section_id)
    )
    if section is None:
        raise HTTPException(status_code=404, detail="Section not found")

    if payload.title is not None and payload.title.strip():
        section.title = payload.title.strip()

    if payload.content_json is not None:
        # Replace the content_json wholesale — admin is authoritative.
        merged = dict(payload.content_json)
        merged["review_flags"] = []
        merged["edited_by_admin_at"] = datetime.utcnow().isoformat()
        section.content_json = merged
    elif payload.content_summary is not None:
        content = dict(section.content_json or {})
        content["summary"] = payload.content_summary
        content["review_flags"] = []
        content["edited_by_admin_at"] = datetime.utcnow().isoformat()
        section.content_json = content

    await db.commit()
    await db.refresh(section)
    question_count = await db.scalar(
        select(func.count(SectionQuestion.id)).where(SectionQuestion.section_id == section_id)
    )
    return AdminSectionDetail(
        id=section.id,
        document_id=section.document_id,
        parent_id=section.parent_id,
        kind=section.kind,
        title=section.title,
        page_start=section.page_start,
        page_end=section.page_end,
        ordinal=section.ordinal,
        content_json=section.content_json,
        question_count=int(question_count or 0),
    )


@router.post("/sections/{section_id}/regenerate", response_model=AdminSectionDetail)
async def regenerate_section(
    section_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> AdminSectionDetail:
    """Re-run headline enrichment for a single section. Useful
    when the admin spotted a bad payload and wants the LLM to
    take another pass after we tightened the prompt or fixed a
    bug. The new payload overwrites the old."""

    def _run() -> dict[str, Any]:
        # Lazy import — the enrichment task pulls in fitz, openai,
        # and a lot of other heavy dependencies we don't need on
        # every admin endpoint import.
        from app.models.document import Page
        from app.tasks.section_mapping import _enrich_headline, _get_openai_client

        sync_db = SyncSessionLocal()
        try:
            section = sync_db.query(DocumentSection).filter(
                DocumentSection.id == section_id
            ).first()
            if section is None:
                raise HTTPException(status_code=404, detail="Section not found")
            if section.kind != "headline":
                raise HTTPException(
                    status_code=400,
                    detail="Only headline sections can be regenerated",
                )
            pages = (
                sync_db.query(Page)
                .filter(Page.document_id == section.document_id)
                .filter(Page.page_number >= section.page_start)
                .filter(Page.page_number <= section.page_end)
                .order_by(Page.page_number.asc())
                .all()
            )
            text_lines: list[str] = []
            for page in pages:
                text = (page.markdown or page.text or "").strip()
                if text:
                    text_lines.append(f"[page {page.page_number}]\n{text}")
            section_text = "\n\n".join(text_lines).strip()
            if not section_text:
                raise HTTPException(
                    status_code=400,
                    detail="Section pages have no readable text — re-run OCR first",
                )
            client = _get_openai_client()
            payload = _enrich_headline(
                client,
                title=section.title,
                page_start=section.page_start,
                page_end=section.page_end,
                section_text=section_text,
            )
            payload["regenerated_at"] = datetime.utcnow().isoformat()
            section.content_json = payload
            flag_modified(section, "content_json")
            sync_db.commit()
            return payload
        finally:
            sync_db.close()

    await asyncio.to_thread(_run)
    # Re-read via async session so the response carries any
    # event-time updates.
    section = await db.scalar(
        select(DocumentSection).where(DocumentSection.id == section_id)
    )
    if section is None:
        raise HTTPException(status_code=404, detail="Section vanished mid-regenerate")
    question_count = await db.scalar(
        select(func.count(SectionQuestion.id)).where(SectionQuestion.section_id == section_id)
    )
    return AdminSectionDetail(
        id=section.id,
        document_id=section.document_id,
        parent_id=section.parent_id,
        kind=section.kind,
        title=section.title,
        page_start=section.page_start,
        page_end=section.page_end,
        ordinal=section.ordinal,
        content_json=section.content_json,
        question_count=int(question_count or 0),
    )


@router.delete("/sections/{section_id}", status_code=204)
async def delete_section(
    section_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> None:
    """Hard-delete a section. Cascades to its questions, concept
    introductions, and embeddings via FK ondelete=CASCADE."""
    section = await db.scalar(
        select(DocumentSection).where(DocumentSection.id == section_id)
    )
    if section is None:
        raise HTTPException(status_code=404, detail="Section not found")
    await db.delete(section)
    await db.commit()


# ---------------------------------------------------------------------------
# Question reviewer
# ---------------------------------------------------------------------------


def _question_to_admin_row(q: SectionQuestion) -> AdminQuestionRow:
    payload = dict(q.payload or {})
    review_meta = payload.pop("__review", None) if isinstance(payload.get("__review"), dict) else None
    return AdminQuestionRow(
        id=q.id,
        section_id=q.section_id,
        question_type=q.question_type,
        stem=q.stem,
        payload=payload,
        explanation=q.explanation,
        concept_ids=[str(c) for c in (q.concept_ids or [])],
        difficulty=q.difficulty,
        estimated_seconds=q.estimated_seconds,
        misconception_tags=list(q.misconception_tags or []),
        display_ordinal=q.display_ordinal,
        review_meta=review_meta,
    )


@router.get(
    "/sections/{section_id}/questions",
    response_model=list[AdminQuestionRow],
)
async def list_section_questions_admin(
    section_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> list[AdminQuestionRow]:
    """List questions for a section with the FULL payload — including
    answer keys and review metadata. This is the admin reviewer view,
    NOT the user check-in view."""
    rows = (
        await db.execute(
            select(SectionQuestion)
            .where(SectionQuestion.section_id == section_id)
            .order_by(SectionQuestion.display_ordinal.asc())
        )
    ).scalars().all()
    return [_question_to_admin_row(q) for q in rows]


@router.patch("/questions/{question_id}", response_model=AdminQuestionRow)
async def patch_question(
    question_id: uuid.UUID,
    payload: QuestionPatch,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> AdminQuestionRow:
    """Edit a question's stem, explanation, payload, or difficulty.
    Admin replaces the LLM payload — the new content is treated as
    authoritative and the review meta is cleared."""
    q = await db.scalar(select(SectionQuestion).where(SectionQuestion.id == question_id))
    if q is None:
        raise HTTPException(status_code=404, detail="Question not found")

    if payload.stem is not None and payload.stem.strip():
        q.stem = payload.stem.strip()
    if payload.explanation is not None and payload.explanation.strip():
        q.explanation = payload.explanation.strip()
    if payload.difficulty is not None and 1 <= payload.difficulty <= 5:
        q.difficulty = payload.difficulty
    if payload.estimated_seconds is not None and payload.estimated_seconds > 0:
        q.estimated_seconds = payload.estimated_seconds
    if payload.payload is not None:
        # Preserve __review markers from the original so the admin
        # patch doesn't accidentally erase the review-meta context;
        # but strip any inline review flags since the human just
        # approved this version.
        existing_meta = (q.payload or {}).get("__review") if isinstance(q.payload, dict) else None
        new_payload = dict(payload.payload)
        if existing_meta:
            new_payload["__review"] = {
                **existing_meta,
                "edited_by_admin_at": datetime.utcnow().isoformat(),
            }
        q.payload = new_payload
        flag_modified(q, "payload")

    await db.commit()
    await db.refresh(q)
    return _question_to_admin_row(q)


@router.delete("/questions/{question_id}", status_code=204)
async def delete_question(
    question_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> None:
    q = await db.scalar(select(SectionQuestion).where(SectionQuestion.id == question_id))
    if q is None:
        raise HTTPException(status_code=404, detail="Question not found")
    await db.delete(q)
    await db.commit()


@router.post(
    "/sections/{section_id}/questions/regenerate",
    response_model=list[AdminQuestionRow],
)
async def regenerate_section_questions(
    section_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> list[AdminQuestionRow]:
    """Wipe and re-generate the question bank for a single section.
    Uses the same generator the offline pipeline runs. Leakage check
    and math self-validation both run."""

    def _run() -> None:
        from app.tasks.question_generation import (
            _GenStats,
            _build_concept_lookup,
            _generate_questions_for_section,
            _math_question_self_grades_correct,
            _mcq_is_leaky,
            _to_section_question,
            _get_openai_client,
        )
        from sqlalchemy import delete

        sync_db = SyncSessionLocal()
        try:
            section = sync_db.query(DocumentSection).filter(
                DocumentSection.id == section_id
            ).first()
            if section is None:
                raise HTTPException(status_code=404, detail="Section not found")
            sync_db.execute(
                delete(SectionQuestion).where(SectionQuestion.section_id == section_id)
            )
            client = _get_openai_client()
            stats = _GenStats()
            concept_lookup = _build_concept_lookup(sync_db, section.document_id)
            questions = _generate_questions_for_section(client, section, stats)
            kept: list[dict[str, Any]] = []
            for q in questions:
                if q["question_type"] in ("numeric", "symbolic"):
                    ok, _ = _math_question_self_grades_correct(q)
                    if not ok:
                        continue
                if q["question_type"] in ("mcq", "counterexample") and q.get("choices"):
                    leaky, _ = _mcq_is_leaky(client, q)
                    if leaky:
                        continue
                kept.append(q)
            for ordinal, q in enumerate(kept):
                sync_db.add(
                    _to_section_question(
                        q=q,
                        section_id=section.id,
                        concept_lookup=concept_lookup,
                        display_ordinal=ordinal,
                    )
                )
            sync_db.commit()
        finally:
            sync_db.close()

    await asyncio.to_thread(_run)
    rows = (
        await db.execute(
            select(SectionQuestion)
            .where(SectionQuestion.section_id == section_id)
            .order_by(SectionQuestion.display_ordinal.asc())
        )
    ).scalars().all()
    return [_question_to_admin_row(q) for q in rows]


# ---------------------------------------------------------------------------
# Concept graph viewer
# ---------------------------------------------------------------------------


@router.get("/concepts", response_model=list[AdminConceptRow])
async def list_concepts(
    document_id: uuid.UUID | None = Query(default=None),
    limit: int = Query(default=200, le=1000),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> list[AdminConceptRow]:
    """List concepts with usage counts. Filter by document_id to
    see only concepts introduced or applied in that book."""
    if document_id is None:
        concepts = (
            await db.execute(
                select(Concept).order_by(Concept.canonical_name.asc()).limit(limit)
            )
        ).scalars().all()
    else:
        concepts = (
            await db.execute(
                select(Concept)
                .join(ConceptIntroduction, ConceptIntroduction.concept_id == Concept.id)
                .join(
                    DocumentSection,
                    DocumentSection.id == ConceptIntroduction.document_section_id,
                )
                .where(DocumentSection.document_id == document_id)
                .order_by(Concept.canonical_name.asc())
                .distinct()
                .limit(limit)
            )
        ).scalars().all()

    intro_counts = dict(
        (row.concept_id, row.cnt)
        for row in (
            await db.execute(
                select(
                    ConceptIntroduction.concept_id,
                    func.count(ConceptIntroduction.id).label("cnt"),
                ).group_by(ConceptIntroduction.concept_id)
            )
        ).all()
    )
    app_counts = dict(
        (row.concept_id, row.cnt)
        for row in (
            await db.execute(
                select(
                    ConceptApplication.concept_id,
                    func.count(ConceptApplication.id).label("cnt"),
                ).group_by(ConceptApplication.concept_id)
            )
        ).all()
    )

    return [
        AdminConceptRow(
            id=c.id,
            canonical_name=c.canonical_name,
            canonical_definition=c.canonical_definition,
            aliases=list(c.aliases) if c.aliases else None,
            difficulty_tier=c.difficulty_tier,
            introduction_count=intro_counts.get(c.id, 0),
            application_count=app_counts.get(c.id, 0),
        )
        for c in concepts
    ]


@router.post("/concepts/merge", response_model=AdminConceptRow)
async def merge_concepts(
    payload: ConceptMergePayload,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> AdminConceptRow:
    """Merge two concepts: keep one, repoint all links from the
    other onto it, fold its name into the survivor's aliases, then
    delete the absorbed row.

    Manual admin merges bypass the LLM-confirmation step the offline
    dedup pipeline does — the admin is the source of truth here.
    """
    if payload.keep_id == payload.absorb_id:
        raise HTTPException(status_code=400, detail="keep_id and absorb_id must differ")

    def _run() -> AdminConceptRow:
        from sqlalchemy import delete

        sync_db = SyncSessionLocal()
        try:
            survivor = sync_db.query(Concept).filter(Concept.id == payload.keep_id).first()
            absorbed = sync_db.query(Concept).filter(Concept.id == payload.absorb_id).first()
            if survivor is None or absorbed is None:
                raise HTTPException(status_code=404, detail="Concept not found")

            # Fold the absorbed concept's display name into the
            # survivor's aliases so search by either name still hits.
            aliases = set(survivor.aliases or [])
            aliases.add(absorbed.canonical_name)
            for alias in absorbed.aliases or []:
                aliases.add(alias)
            aliases.discard(survivor.canonical_name)
            survivor.aliases = sorted(aliases)

            # Repoint introductions / applications. Drop dupes first
            # so the (concept_id, document_section_id) unique
            # constraint doesn't collide when a section linked both.
            sync_db.execute(
                delete(ConceptIntroduction).where(
                    ConceptIntroduction.concept_id == absorbed.id,
                    ConceptIntroduction.document_section_id.in_(
                        select(ConceptIntroduction.document_section_id).where(
                            ConceptIntroduction.concept_id == survivor.id
                        )
                    ),
                )
            )
            sync_db.execute(
                delete(ConceptApplication).where(
                    ConceptApplication.concept_id == absorbed.id,
                    ConceptApplication.document_section_id.in_(
                        select(ConceptApplication.document_section_id).where(
                            ConceptApplication.concept_id == survivor.id
                        )
                    ),
                )
            )
            sync_db.execute(
                ConceptIntroduction.__table__.update()
                .where(ConceptIntroduction.concept_id == absorbed.id)
                .values(concept_id=survivor.id)
            )
            sync_db.execute(
                ConceptApplication.__table__.update()
                .where(ConceptApplication.concept_id == absorbed.id)
                .values(concept_id=survivor.id)
            )
            # Self-loops (A→B where the merge would make both equal
            # to survivor) get deleted; non-self edges get repointed.
            sync_db.execute(
                delete(ConceptEdge).where(
                    (
                        (ConceptEdge.from_concept_id == absorbed.id)
                        & (ConceptEdge.to_concept_id == survivor.id)
                    )
                    | (
                        (ConceptEdge.from_concept_id == survivor.id)
                        & (ConceptEdge.to_concept_id == absorbed.id)
                    )
                )
            )
            sync_db.execute(
                ConceptEdge.__table__.update()
                .where(ConceptEdge.from_concept_id == absorbed.id)
                .values(from_concept_id=survivor.id)
            )
            sync_db.execute(
                ConceptEdge.__table__.update()
                .where(ConceptEdge.to_concept_id == absorbed.id)
                .values(to_concept_id=survivor.id)
            )
            sync_db.execute(delete(Concept).where(Concept.id == absorbed.id))

            sync_db.commit()
            sync_db.refresh(survivor)
            intro_cnt = (
                sync_db.query(func.count(ConceptIntroduction.id))
                .filter(ConceptIntroduction.concept_id == survivor.id)
                .scalar()
            ) or 0
            app_cnt = (
                sync_db.query(func.count(ConceptApplication.id))
                .filter(ConceptApplication.concept_id == survivor.id)
                .scalar()
            ) or 0
            return AdminConceptRow(
                id=survivor.id,
                canonical_name=survivor.canonical_name,
                canonical_definition=survivor.canonical_definition,
                aliases=list(survivor.aliases) if survivor.aliases else None,
                difficulty_tier=survivor.difficulty_tier,
                introduction_count=int(intro_cnt),
                application_count=int(app_cnt),
            )
        finally:
            sync_db.close()

    return await asyncio.to_thread(_run)


@router.delete("/concepts/{concept_id}", status_code=204)
async def delete_concept(
    concept_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
) -> None:
    """Hard-delete a hallucinated concept. Cascades to its
    introductions / applications / edges via FK ondelete=CASCADE."""
    c = await db.scalar(select(Concept).where(Concept.id == concept_id))
    if c is None:
        raise HTTPException(status_code=404, detail="Concept not found")
    await db.delete(c)
    await db.commit()
