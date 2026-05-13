"""Learn-mode REST endpoints.

The chat WebSocket handles open-ended Q&A; learn mode is structured
enough (diagnostic → path → narration → check-ins → next section)
that fighting the streaming chat protocol would be more work than
just exposing a clean REST surface.

Endpoints
---------
``POST /learn/path/start``
    Take the diagnostic answers, generate the path, persist.

``GET /learn/path/active?document_id=...``
    Return the user's most-recent active or paused path for the
    given document. 404 if none exists (frontend prompts the user
    to run the diagnostic).

``POST /learn/path/{path_id}/advance``
    Mark the current step ``completed`` or ``skipped`` and advance
    the pointer. Triggers ``recompute_path`` so the remaining tail
    reflects the user's updated mastery.

``GET /learn/section/{section_id}/questions``
    Return the section's check-in question bank (without answer
    keys or explanations).

``POST /learn/check-in``
    Submit an answer for one question. Grades it, updates mastery,
    records misconceptions, returns the result with explanation.

``GET /learn/document/{document_id}/sections``
    Return the document's section tree with this user's mastery
    overlay. Drives the mindmap visualisation.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import SyncSessionLocal, get_db
from app.models.document import Document, DocumentSection
from app.models.learning_path import UserLearningPath
from app.models.question import SectionQuestion
from app.models.user import User
from app.schemas.learn import (
    AdvanceStepRequest,
    CheckInAnswerRequest,
    CheckInQuestionResponse,
    CheckInResultResponse,
    LearningPathResponse,
    MasteryUpdateResponse,
    PathStepResponse,
    SectionNodeResponse,
    StartLearningPathRequest,
)
from app.services.grading import GraderError, grade
from app.services.learn_path import (
    advance_step as advance_step_service,
    create_path as create_path_service,
    get_active_path as get_active_path_service,
    recompute_path as recompute_path_service,
)
from app.services.mastery import (
    apply_grade,
    mastery_snapshot,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/learn", tags=["learn"])


# Service functions in app/services/learn_path.py + app/services/mastery.py
# were written against sync SQLAlchemy because the offline ingestion stages
# they share helpers with use it too. The REST API uses async SQLAlchemy;
# we run service calls via ``asyncio.to_thread`` using the shared
# ``SyncSessionLocal`` so the event loop stays unblocked.
_SyncSession = SyncSessionLocal


def _path_to_response(row: UserLearningPath) -> LearningPathResponse:
    """Translate the JSONB ``plan_json`` into typed step responses."""
    steps: list[PathStepResponse] = []
    for entry in row.plan_json or []:
        completed_at = None
        if entry.get("completed_at"):
            try:
                completed_at = datetime.fromisoformat(entry["completed_at"])
            except (TypeError, ValueError):
                completed_at = None
        steps.append(
            PathStepResponse(
                section_id=uuid.UUID(entry["section_id"]),
                title=entry.get("title", ""),
                rationale=entry.get("rationale", ""),
                page_start=int(entry.get("page_start", 1)),
                page_end=int(entry.get("page_end", 1)),
                is_target=bool(entry.get("is_target", False)),
                is_prereq=bool(entry.get("is_prereq", False)),
                status=entry.get("status", "pending"),
                completed_at=completed_at,
                mastery_delta_json=entry.get("mastery_delta_json"),
            )
        )
    return LearningPathResponse(
        id=row.id,
        document_id=row.document_id,
        user_id=row.user_id,
        status=row.status,
        goal_text=row.goal_text,
        depth=row.depth,
        plan=steps,
        current_step=row.current_step,
        recompute_count=row.recompute_count,
        started_at=row.started_at,
        last_active_at=row.last_active_at,
        completed_at=row.completed_at,
    )


# ---------------------------------------------------------------------------
# Path lifecycle
# ---------------------------------------------------------------------------


@router.post("/path/start", response_model=LearningPathResponse)
async def start_path(
    payload: StartLearningPathRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> LearningPathResponse:
    """Create a new learning path. Stales any prior active path
    for the same (user, document)."""
    # Authorise: the document must exist and be accessible to the user.
    doc = await db.scalar(
        select(Document).where(Document.id == payload.document_id)
    )
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    def _run() -> UserLearningPath:
        sync_db = _SyncSession()
        try:
            return create_path_service(
                sync_db,
                user_id=user.id,
                document_id=payload.document_id,
                goal_text=payload.goal_text,
                depth=payload.depth,
                prior_known_concept_ids=payload.prior_known_concept_ids,
            )
        finally:
            sync_db.close()

    row = await asyncio.to_thread(_run)
    return _path_to_response(row)


@router.get("/path/active", response_model=LearningPathResponse)
async def get_active_path(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> LearningPathResponse:
    """Return the user's most-recent active/paused path for the
    given document. 404 if no resumable path exists."""

    def _run() -> UserLearningPath | None:
        sync_db = _SyncSession()
        try:
            return get_active_path_service(
                sync_db, user_id=user.id, document_id=document_id
            )
        finally:
            sync_db.close()

    row = await asyncio.to_thread(_run)
    if row is None:
        raise HTTPException(status_code=404, detail="No active path for this document")
    return _path_to_response(row)


@router.post("/path/{path_id}/advance", response_model=LearningPathResponse)
async def advance_path_step(
    path_id: uuid.UUID,
    payload: AdvanceStepRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> LearningPathResponse:
    """Mark the current step done (or skipped), advance the pointer,
    and recompute the remaining tail based on fresh mastery state."""

    def _run() -> UserLearningPath:
        sync_db = _SyncSession()
        try:
            row = sync_db.query(UserLearningPath).filter(
                UserLearningPath.id == path_id
            ).first()
            if row is None or row.user_id != user.id:
                raise HTTPException(status_code=404, detail="Path not found")
            if row.status not in ("active", "paused"):
                raise HTTPException(
                    status_code=400,
                    detail=f"Path is {row.status}, cannot advance",
                )
            # Mark current step.
            if row.current_step < len(row.plan_json):
                step = row.plan_json[row.current_step]
                step["status"] = "skipped" if payload.skip else "completed"
                step["completed_at"] = datetime.utcnow().isoformat()
                # Persist the JSONB mutation.
                from sqlalchemy.orm.attributes import flag_modified
                flag_modified(row, "plan_json")
                sync_db.flush()
            advance_step_service(sync_db, row)
            recompute_path_service(sync_db, row)
            return row
        finally:
            sync_db.close()

    row = await asyncio.to_thread(_run)
    return _path_to_response(row)


# ---------------------------------------------------------------------------
# Check-in flow
# ---------------------------------------------------------------------------


def _question_to_response(q: SectionQuestion) -> CheckInQuestionResponse:
    """Strip answer / explanation before sending to the client."""
    # MCQ payloads have choices; we strip the `is_correct` flag so
    # the answer key isn't leaked. Other types' payloads can ship
    # as-is — they don't contain the answer in plain text.
    payload = dict(q.payload or {})
    if q.question_type in ("mcq", "counterexample") and isinstance(
        payload.get("choices"), list
    ):
        payload["choices"] = [
            {
                "label": c.get("label"),
                "text": c.get("text"),
            }
            for c in payload["choices"]
        ]
    elif q.question_type == "numeric":
        # Keep the unit for the UI prompt, hide the value/tolerance.
        payload = {"unit": payload.get("unit")}
    elif q.question_type == "symbolic":
        payload = {
            "variables": payload.get("variables", []),
            "domain_constraints": payload.get("domain_constraints"),
        }
    elif q.question_type == "free_text":
        # Only expose the count of criteria, not the criteria text
        # itself — the criteria are graders' rubric, not user hints.
        rubric = payload.get("rubric") or {}
        payload = {"criteria_count": len(rubric.get("criteria") or [])}
    elif q.question_type == "code":
        payload = {
            "starter_code": payload.get("starter_code"),
            "language": payload.get("language", "python"),
        }
    return CheckInQuestionResponse(
        id=q.id,
        section_id=q.section_id,
        question_type=q.question_type,
        stem=q.stem,
        payload=payload,
        difficulty=q.difficulty,
        estimated_seconds=q.estimated_seconds,
        display_ordinal=q.display_ordinal,
    )


@router.get(
    "/section/{section_id}/questions",
    response_model=list[CheckInQuestionResponse],
)
async def get_section_questions(
    section_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[CheckInQuestionResponse]:
    """Return this section's check-in question bank, stripped of
    answer keys and explanations."""
    rows = await db.execute(
        select(SectionQuestion)
        .where(SectionQuestion.section_id == section_id)
        .order_by(SectionQuestion.display_ordinal.asc())
    )
    questions = [row[0] for row in rows.all()]
    if not questions:
        raise HTTPException(
            status_code=404,
            detail="No questions for this section",
        )
    return [_question_to_response(q) for q in questions]


@router.post("/check-in", response_model=CheckInResultResponse)
async def submit_check_in(
    payload: CheckInAnswerRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CheckInResultResponse:
    """Grade a check-in answer, update mastery, return the result.

    Reads the question + its full payload (with answer key) from
    the DB, runs the grader, applies mastery updates, commits.
    """
    question = await db.scalar(
        select(SectionQuestion).where(SectionQuestion.id == payload.question_id)
    )
    if question is None:
        raise HTTPException(status_code=404, detail="Question not found")

    # Grade synchronously — math graders are fast; LLM rubric calls
    # need a thread to avoid blocking the loop.
    def _run() -> CheckInResultResponse:
        sync_db = _SyncSession()
        try:
            q = sync_db.query(SectionQuestion).filter(
                SectionQuestion.id == payload.question_id
            ).first()
            if q is None:
                raise HTTPException(status_code=404, detail="Question not found")
            try:
                result = grade(
                    question_type=q.question_type,
                    user_answer=payload.user_answer,
                    payload=q.payload or {},
                )
            except GraderError as exc:
                raise HTTPException(
                    status_code=500,
                    detail=f"Grader error: {exc}",
                ) from exc
            except NotImplementedError as exc:
                raise HTTPException(
                    status_code=501,
                    detail=str(exc),
                ) from exc

            concept_uuids = [
                uuid.UUID(c) for c in (q.concept_ids or []) if c
            ]
            mastery_updates = apply_grade(
                sync_db,
                user_id=user.id,
                concept_ids=concept_uuids,
                result=result,
                difficulty=q.difficulty,
            )
            sync_db.commit()
            return CheckInResultResponse(
                is_correct=result.is_correct,
                score=result.score,
                feedback=result.feedback,
                explanation=q.explanation,
                misconception_tag=result.misconception_tag,
                mastery_updates=[
                    MasteryUpdateResponse(
                        concept_id=u.concept_id,
                        previous_score=u.previous_score,
                        new_score=u.new_score,
                        is_known_now=u.is_known_now,
                        became_known=u.became_known,
                        became_unknown=u.became_unknown,
                    )
                    for u in mastery_updates
                ],
                section_completed=False,  # frontend tracks per-section progress
            )
        finally:
            sync_db.close()

    return await asyncio.to_thread(_run)


# ---------------------------------------------------------------------------
# Section tree (mindmap data source)
# ---------------------------------------------------------------------------


def _build_section_tree(
    sections: list[DocumentSection],
    mastery_by_concept: dict[uuid.UUID, float],
    intros_by_section: dict[uuid.UUID, list[uuid.UUID]],
) -> list[SectionNodeResponse]:
    """Turn a flat list of sections + the mastery map into the
    nested tree the frontend renders.

    Mastery score for a headline = mean of its introduced concepts'
    scores. Topics / subtopics inherit later (frontend or aggregation
    step computes the average of descendants).
    """
    by_id = {s.id: s for s in sections}
    children_of: dict[uuid.UUID | None, list[DocumentSection]] = {}
    for s in sections:
        children_of.setdefault(s.parent_id, []).append(s)
    for siblings in children_of.values():
        siblings.sort(key=lambda x: x.ordinal)

    def _make_node(section: DocumentSection) -> SectionNodeResponse:
        content = section.content_json or {}
        concept_ids = intros_by_section.get(section.id, [])
        if section.kind == "headline" and concept_ids:
            scores = [
                mastery_by_concept.get(cid, 0.0) for cid in concept_ids
            ]
            mastery_score = sum(scores) / len(scores) if scores else 0.0
        else:
            mastery_score = None
        kids = children_of.get(section.id, [])
        return SectionNodeResponse(
            id=section.id,
            kind=section.kind,
            title=section.title,
            page_start=section.page_start,
            page_end=section.page_end,
            ordinal=section.ordinal,
            summary=(content.get("summary") or None),
            concept_ids=concept_ids,
            mastery_score=mastery_score,
            children=[_make_node(child) for child in kids],
        )

    roots = children_of.get(None, [])
    return [_make_node(r) for r in roots]


@router.get(
    "/document/{document_id}/sections",
    response_model=list[SectionNodeResponse],
)
async def get_document_sections(
    document_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[SectionNodeResponse]:
    """The document's section tree, with this user's mastery overlay.

    Drives the mindmap visualisation. One call per mindmap open;
    cheap on the server side (no LLM, just a single query plus a
    join for mastery)."""
    doc = await db.scalar(select(Document).where(Document.id == document_id))
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")

    sections_result = await db.execute(
        select(DocumentSection)
        .where(DocumentSection.document_id == document_id)
        .order_by(DocumentSection.ordinal.asc())
    )
    sections = [row[0] for row in sections_result.all()]
    if not sections:
        return []

    # Fetch concept introductions for this document.
    from app.models.concept import ConceptIntroduction
    intros_result = await db.execute(
        select(
            ConceptIntroduction.document_section_id,
            ConceptIntroduction.concept_id,
        ).where(
            ConceptIntroduction.document_section_id.in_([s.id for s in sections])
        )
    )
    intros_by_section: dict[uuid.UUID, list[uuid.UUID]] = {}
    all_concepts: set[uuid.UUID] = set()
    for section_id, concept_id in intros_result.all():
        intros_by_section.setdefault(section_id, []).append(concept_id)
        all_concepts.add(concept_id)

    # Mastery snapshot in one synchronous helper call.
    def _snapshot() -> dict[uuid.UUID, float]:
        sync_db = _SyncSession()
        try:
            return mastery_snapshot(sync_db, user.id, list(all_concepts))
        finally:
            sync_db.close()

    mastery_by_concept = await asyncio.to_thread(_snapshot)
    return _build_section_tree(sections, mastery_by_concept, intros_by_section)
