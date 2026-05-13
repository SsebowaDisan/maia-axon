"""Learn-mode path generator.

Takes a user's free-text goal and produces an ordered list of
sections to work through. Combines three inputs:

  * Semantic similarity — embed the goal, match against headline
    summary embeddings (text-embedding-3-large via pgvector).
  * Prerequisite graph — walk backward from target concepts so
    foundational dependencies surface even if they don't match the
    goal text directly.
  * User mastery — concepts the user already knows (or claimed to
    know in the diagnostic) get pruned from the candidate set so
    the path doesn't re-teach them.

The path is materialised as a ``UserLearningPath`` row. The same
function is used for creation and for recomputation after a
check-in event changes mastery state.

Why one module not many?
    The five stages (embed → search → trace → prune → render) are
    a single algorithm. Splitting them across files makes the data
    flow harder to follow without buying any encapsulation —
    they're all called sequentially and share working state.
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Sequence

import openai
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.concept import (
    Concept,
    ConceptEdge,
    ConceptIntroduction,
)
from app.models.document import DocumentSection, DocumentSectionEmbedding
from app.models.learning_path import (
    LEARNING_PATH_DEPTHS,
    UserLearningPath,
)
from app.services.mastery import known_concepts

logger = logging.getLogger(__name__)


# How many headlines to fetch as semantic-search candidates before
# layering on the prereq trace. Empirically 8-15 catches the directly-
# relevant material; the prereq trace surfaces the foundations the
# search alone would miss.
_SEARCH_TOP_K = 12

# Per-target-concept prereq trace depth. SM-2-friendly small numbers
# work fine for technical books; the chain rarely runs deeper than
# 4-5 hops before hitting an unknown that the user already knows.
_PREREQ_TRACE_DEPTH = 8

# Maximum total sections in a path. Even the deepest paths shouldn't
# overwhelm — users abandon over ~20 steps. The depth-trimming step
# uses this as the upper bound.
_PATH_MAX_LEN = {
    "quick": 6,
    "normal": 12,
    "deep": 24,
}


# ---------------------------------------------------------------------------
# Data classes for the working set
# ---------------------------------------------------------------------------


@dataclass
class _CandidateSection:
    section_id: uuid.UUID
    title: str
    summary: str
    page_start: int
    page_end: int
    similarity: float  # vs the user's goal embedding (0..1, higher = better)
    concept_ids_introduced: set[uuid.UUID] = field(default_factory=set)
    concept_ids_assumed: set[uuid.UUID] = field(default_factory=set)
    # Whether this section is on the path because (a) it matched the
    # goal directly, (b) it's a prerequisite of a matched section, or
    # both. Drives rationale generation.
    is_target: bool = False
    is_prereq: bool = False


# ---------------------------------------------------------------------------
# OpenAI clients
# ---------------------------------------------------------------------------


def _openai_client() -> openai.OpenAI:
    return openai.OpenAI(api_key=settings.openai_api_key)


def _embed_goal(client: openai.OpenAI, goal_text: str) -> list[float]:
    response = client.embeddings.create(
        model=settings.embedding_model,
        input=[goal_text],
        dimensions=settings.embedding_dimensions,
    )
    return response.data[0].embedding


# ---------------------------------------------------------------------------
# Semantic search over section embeddings
# ---------------------------------------------------------------------------


def _semantic_search_sections(
    db: Session,
    *,
    document_id: uuid.UUID,
    goal_embedding: list[float],
    top_k: int,
) -> list[_CandidateSection]:
    """Find the top-K headlines whose embeddings are closest to the
    goal vector. Filtered to this document only — cross-book matches
    happen in a separate, optional path-generation mode.

    Uses pgvector's cosine distance operator. Raw SQL because the
    operator is awkward via the ORM; the embedding vector is bound
    safely via a parameter literal."""
    # Format the embedding as a pgvector literal. The embedding is a
    # trusted server-generated value, but we still use a parameter
    # rather than interpolation to be safe.
    vector_literal = "[" + ",".join(repr(float(x)) for x in goal_embedding) + "]"
    sql = text(
        """
        SELECT
          ds.id,
          ds.title,
          ds.content_json->>'summary' AS summary,
          ds.page_start,
          ds.page_end,
          1 - (dse.embedding <=> CAST(:vec AS vector)) AS similarity
        FROM document_sections ds
        JOIN document_section_embeddings dse ON dse.section_id = ds.id
        WHERE ds.document_id = :doc_id
          AND ds.kind = 'headline'
        ORDER BY dse.embedding <=> CAST(:vec AS vector)
        LIMIT :limit
        """
    )
    rows = db.execute(
        sql,
        {"vec": vector_literal, "doc_id": document_id, "limit": top_k},
    ).all()
    return [
        _CandidateSection(
            section_id=row.id,
            title=row.title or "",
            summary=row.summary or "",
            page_start=row.page_start,
            page_end=row.page_end,
            similarity=float(row.similarity),
        )
        for row in rows
    ]


# ---------------------------------------------------------------------------
# Concept ↔ section lookups
# ---------------------------------------------------------------------------


def _attach_concept_ids(
    db: Session, candidates: list[_CandidateSection]
) -> None:
    """Populate each candidate's introduced + assumed concept-id sets
    from the concept-graph bridge tables. Called once per path
    generation — one query per direction across all candidates."""
    section_ids = [c.section_id for c in candidates]
    if not section_ids:
        return

    introductions = db.execute(
        select(ConceptIntroduction.document_section_id, ConceptIntroduction.concept_id)
        .where(ConceptIntroduction.document_section_id.in_(section_ids))
    ).all()
    intro_by_section: dict[uuid.UUID, set[uuid.UUID]] = {}
    for section_id, concept_id in introductions:
        intro_by_section.setdefault(section_id, set()).add(concept_id)

    from app.models.concept import ConceptApplication
    applications = db.execute(
        select(ConceptApplication.document_section_id, ConceptApplication.concept_id)
        .where(ConceptApplication.document_section_id.in_(section_ids))
    ).all()
    app_by_section: dict[uuid.UUID, set[uuid.UUID]] = {}
    for section_id, concept_id in applications:
        app_by_section.setdefault(section_id, set()).add(concept_id)

    for c in candidates:
        c.concept_ids_introduced = intro_by_section.get(c.section_id, set())
        c.concept_ids_assumed = app_by_section.get(c.section_id, set())


def _trace_prerequisites(
    db: Session,
    *,
    target_concepts: set[uuid.UUID],
    known: set[uuid.UUID],
    max_depth: int,
) -> dict[uuid.UUID, int]:
    """BFS backward through prerequisite edges. Returns a map
    ``concept_id → depth_at_which_first_reached`` — depth 1 means a
    direct prerequisite of a target concept, depth 2 a prereq of a
    prereq, etc. ``known`` concepts cut the walk short (they're
    already covered, no need to explore their ancestors).
    """
    found: dict[uuid.UUID, int] = {}
    frontier: list[uuid.UUID] = [t for t in target_concepts if t not in known]
    if not frontier:
        return found
    visited: set[uuid.UUID] = set(frontier) | known
    for depth in range(1, max_depth + 1):
        if not frontier:
            break
        edges = db.execute(
            select(ConceptEdge.from_concept_id)
            .where(ConceptEdge.to_concept_id.in_(frontier))
            .where(ConceptEdge.type == "prerequisite")
            .distinct()
        ).all()
        next_frontier: list[uuid.UUID] = []
        for (from_id,) in edges:
            if from_id in visited:
                continue
            visited.add(from_id)
            found[from_id] = depth
            next_frontier.append(from_id)
        frontier = next_frontier
    return found


def _sections_that_introduce(
    db: Session,
    *,
    concept_ids: set[uuid.UUID],
    document_id: uuid.UUID,
) -> dict[uuid.UUID, uuid.UUID]:
    """For each concept, find the section in this document that
    introduces it. Returns ``concept_id → section_id``. Concepts
    introduced outside this document (in another book) are omitted —
    the path can only walk through sections in the current document.

    Cross-book paths could relax this by widening the document
    filter; intentionally narrow for v1 to keep paths coherent.
    """
    if not concept_ids:
        return {}
    rows = db.execute(
        select(ConceptIntroduction.concept_id, ConceptIntroduction.document_section_id)
        .join(
            DocumentSection,
            DocumentSection.id == ConceptIntroduction.document_section_id,
        )
        .where(ConceptIntroduction.concept_id.in_(list(concept_ids)))
        .where(DocumentSection.document_id == document_id)
    ).all()
    out: dict[uuid.UUID, uuid.UUID] = {}
    for concept_id, section_id in rows:
        # If a concept is introduced in multiple sections of this
        # document, keep the first by reading order (lower page_start).
        if concept_id in out:
            continue
        out[concept_id] = section_id
    return out


# ---------------------------------------------------------------------------
# Rationale generation
# ---------------------------------------------------------------------------


_RATIONALE_SYSTEM = """\
You are explaining why each section is part of a learning path. You will be \
given the user's goal and a list of sections (each with a title and one-line \
summary). Output STRICT JSON ONLY:

{
  "rationales": [
    {"section_id": <string>, "why": <string, ONE short sentence>},
    ...
  ]
}

Rules:
  - One entry per section, in the same order you were given.
  - Each "why" is ONE sentence connecting the section to the user's goal.
  - For sections marked as prerequisites, explain what foundation they provide.
  - Output ONLY the JSON object.\
"""


def _generate_rationales(
    client: openai.OpenAI,
    *,
    goal_text: str,
    sections: list[_CandidateSection],
) -> dict[uuid.UUID, str]:
    """One LLM call per path — batches all sections together so the
    cost is one call regardless of path length."""
    if not sections:
        return {}
    payload = [
        {
            "section_id": str(s.section_id),
            "title": s.title,
            "summary": s.summary,
            "is_target": s.is_target,
            "is_prereq": s.is_prereq,
        }
        for s in sections
    ]
    user = (
        f"User's goal: {goal_text}\n\n"
        f"Sections (in order):\n{json.dumps(payload, ensure_ascii=False, indent=2)}"
    )
    completion = client.chat.completions.create(
        model=settings.openai_reasoning_model,
        messages=[
            {"role": "system", "content": _RATIONALE_SYSTEM},
            {"role": "user", "content": user},
        ],
        response_format={"type": "json_object"},
        temperature=0,
    )
    try:
        parsed = json.loads(completion.choices[0].message.content or "")
        rationales = parsed.get("rationales") or []
    except json.JSONDecodeError:
        return {}
    out: dict[uuid.UUID, str] = {}
    for r in rationales:
        sid = r.get("section_id")
        why = (r.get("why") or "").strip()
        if not sid or not why:
            continue
        try:
            out[uuid.UUID(sid)] = why
        except ValueError:
            continue
    return out


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def _build_plan(
    db: Session,
    *,
    user_id: uuid.UUID,
    document_id: uuid.UUID,
    goal_text: str,
    depth: str,
    prior_known: Sequence[uuid.UUID],
) -> list[dict[str, Any]]:
    """Run the full pipeline and return the plan_json list.

    Pulled out so create + recompute share it.
    """
    if depth not in LEARNING_PATH_DEPTHS:
        raise ValueError(f"Unknown depth: {depth!r}")

    client = _openai_client()

    # 1. Embed the goal.
    goal_vec = _embed_goal(client, goal_text)

    # 2. Semantic-search top-K headlines in the document.
    candidates = _semantic_search_sections(
        db,
        document_id=document_id,
        goal_embedding=goal_vec,
        top_k=_SEARCH_TOP_K,
    )
    if not candidates:
        return []

    # 3. Tag the search hits as "target" sections.
    for c in candidates:
        c.is_target = True

    # 4. Attach concept ids.
    _attach_concept_ids(db, candidates)

    # 5. Build the union of target concepts (what the user actually
    # wants to know after reading the path).
    target_concepts: set[uuid.UUID] = set()
    for c in candidates:
        target_concepts.update(c.concept_ids_introduced)
        target_concepts.update(c.concept_ids_assumed)

    # 6. Known concepts: mastery >= 0.7 OR claimed in diagnostic.
    user_known = known_concepts(db, user_id)
    user_known.update(prior_known)

    # 7. Prereq trace: which extra concepts the user needs to cover.
    prereq_depth_by_concept = _trace_prerequisites(
        db,
        target_concepts=target_concepts,
        known=user_known,
        max_depth=_PREREQ_TRACE_DEPTH,
    )

    # 8. Map prereq concepts back to sections in this document.
    prereq_sections = _sections_that_introduce(
        db,
        concept_ids=set(prereq_depth_by_concept.keys()),
        document_id=document_id,
    )
    candidate_ids = {c.section_id for c in candidates}

    # Hydrate prereq sections that aren't already in the candidates list.
    if prereq_sections:
        missing_section_ids = [
            sid for sid in set(prereq_sections.values()) if sid not in candidate_ids
        ]
        if missing_section_ids:
            extra_rows = db.execute(
                select(
                    DocumentSection.id,
                    DocumentSection.title,
                    DocumentSection.content_json,
                    DocumentSection.page_start,
                    DocumentSection.page_end,
                ).where(DocumentSection.id.in_(missing_section_ids))
            ).all()
            for row in extra_rows:
                content = row.content_json or {}
                candidates.append(
                    _CandidateSection(
                        section_id=row.id,
                        title=row.title,
                        summary=(content.get("summary") or ""),
                        page_start=row.page_start,
                        page_end=row.page_end,
                        similarity=0.0,  # not from semantic search
                        is_prereq=True,
                    )
                )
            _attach_concept_ids(db, candidates)
            # Re-mark prereq sections that ARE also in candidate_ids.
            section_id_set = {s for s in prereq_sections.values()}
            for c in candidates:
                if c.section_id in section_id_set:
                    c.is_prereq = True

    # 9. Filter: drop sections whose introduced concepts are all
    # already known and which aren't direct goal-search hits.
    surviving: list[_CandidateSection] = []
    for c in candidates:
        if c.is_target:
            surviving.append(c)
            continue
        if not c.concept_ids_introduced:
            continue
        if not c.concept_ids_introduced.issubset(user_known):
            surviving.append(c)

    # 10. Order: by reading order (page_start) for clarity. Prereqs
    # naturally come before their applicants because earlier sections
    # tend to define before later sections apply.
    surviving.sort(key=lambda s: (s.page_start, s.title))

    # 11. Trim by depth preference.
    max_len = _PATH_MAX_LEN[depth]
    if len(surviving) > max_len:
        # Keep all targets; for prereqs, prefer those with shallower
        # depth (closer to a target).
        targets = [s for s in surviving if s.is_target]
        prereqs = [s for s in surviving if not s.is_target]
        room_for_prereqs = max(0, max_len - len(targets))
        # Sort prereqs by min prereq-depth of their introduced
        # concepts (shallowest first).
        prereqs.sort(
            key=lambda s: (
                min(
                    (
                        prereq_depth_by_concept.get(cid, _PREREQ_TRACE_DEPTH + 1)
                        for cid in s.concept_ids_introduced
                    ),
                    default=_PREREQ_TRACE_DEPTH + 1,
                ),
                s.page_start,
            )
        )
        surviving = sorted(
            targets + prereqs[:room_for_prereqs],
            key=lambda s: (s.page_start, s.title),
        )

    if not surviving:
        return []

    # 12. Rationale generation.
    rationales = _generate_rationales(
        client, goal_text=goal_text, sections=surviving
    )

    # 13. Build the plan list.
    plan: list[dict[str, Any]] = []
    for c in surviving:
        plan.append(
            {
                "section_id": str(c.section_id),
                "rationale": rationales.get(
                    c.section_id,
                    "Part of your learning path."
                    if c.is_target
                    else "Foundation needed for the next sections.",
                ),
                "is_target": c.is_target,
                "is_prereq": c.is_prereq,
                "page_start": c.page_start,
                "page_end": c.page_end,
                "title": c.title,
                "status": "pending",
                "completed_at": None,
                "mastery_delta_json": None,
            }
        )
    return plan


def create_path(
    db: Session,
    *,
    user_id: uuid.UUID,
    document_id: uuid.UUID,
    goal_text: str,
    depth: str = "normal",
    prior_known_concept_ids: Sequence[uuid.UUID] = (),
) -> UserLearningPath:
    """Create a new learning path. Marks any prior active/paused path
    on the same (user, document) as 'stale' first so resume always
    finds the freshest one."""
    document_uuid = document_id

    # Stale any prior active/paused paths for this (user, document).
    db.query(UserLearningPath).filter(
        UserLearningPath.user_id == user_id
    ).filter(UserLearningPath.document_id == document_uuid).filter(
        UserLearningPath.status.in_(("active", "paused"))
    ).update(
        {"status": "stale"}, synchronize_session=False
    )

    plan = _build_plan(
        db,
        user_id=user_id,
        document_id=document_uuid,
        goal_text=goal_text,
        depth=depth,
        prior_known=prior_known_concept_ids,
    )

    row = UserLearningPath(
        id=uuid.uuid4(),
        user_id=user_id,
        document_id=document_uuid,
        status="active" if plan else "completed",
        goal_text=goal_text,
        depth=depth,
        prior_known_concept_ids=[str(c) for c in prior_known_concept_ids] or None,
        plan_json=plan,
        current_step=0,
    )
    if not plan:
        row.completed_at = datetime.now(timezone.utc)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def recompute_path(
    db: Session, path: UserLearningPath
) -> UserLearningPath:
    """Rebuild the remaining (pending) portion of an existing path
    using the user's current mastery state. Preserves completed
    steps, replaces the pending tail.

    Called after every section's check-ins to absorb the user's
    progress: if they nailed a foundational concept, downstream
    prereqs may compress; if they struggled, remedial steps may be
    inserted before the next hard section.
    """
    if path.status not in ("active", "paused"):
        return path

    completed_steps = path.plan_json[: path.current_step]
    new_tail = _build_plan(
        db,
        user_id=path.user_id,
        document_id=path.document_id,
        goal_text=path.goal_text,
        depth=path.depth,
        prior_known=[uuid.UUID(c) for c in (path.prior_known_concept_ids or [])],
    )

    # Drop any new-plan sections that the user already completed in
    # the old plan — no point re-teaching them.
    completed_section_ids = {step["section_id"] for step in completed_steps}
    filtered_tail = [
        step for step in new_tail if step["section_id"] not in completed_section_ids
    ]

    path.plan_json = completed_steps + filtered_tail
    path.recompute_count += 1
    path.last_active_at = datetime.now(timezone.utc)
    if not filtered_tail:
        path.status = "completed"
        path.completed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(path)
    return path


def get_active_path(
    db: Session, *, user_id: uuid.UUID, document_id: uuid.UUID
) -> UserLearningPath | None:
    """Return the most-recent active/paused path for (user, document).
    None if no resumable path exists.
    """
    return (
        db.query(UserLearningPath)
        .filter(UserLearningPath.user_id == user_id)
        .filter(UserLearningPath.document_id == document_id)
        .filter(UserLearningPath.status.in_(("active", "paused")))
        .order_by(UserLearningPath.last_active_at.desc())
        .first()
    )


def advance_step(
    db: Session,
    path: UserLearningPath,
    *,
    mastery_deltas: dict[str, dict[str, float]] | None = None,
) -> UserLearningPath:
    """Mark the current step completed and advance the pointer.

    ``mastery_deltas`` is an optional dict keyed by concept_id (str)
    with ``{previous, new}`` score pairs — stored on the step for
    the UI to render "you levelled up on X" hints.
    """
    if path.current_step >= len(path.plan_json):
        return path
    step = path.plan_json[path.current_step]
    step["status"] = "completed"
    step["completed_at"] = datetime.now(timezone.utc).isoformat()
    if mastery_deltas is not None:
        step["mastery_delta_json"] = mastery_deltas
    path.current_step += 1
    path.last_active_at = datetime.now(timezone.utc)
    if path.current_step >= len(path.plan_json):
        path.status = "completed"
        path.completed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(path)
    return path
