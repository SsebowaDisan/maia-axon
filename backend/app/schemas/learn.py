"""Pydantic schemas for learn-mode REST endpoints.

Two surfaces:

* Path lifecycle — start / fetch / advance.
* Check-in flow — list questions for a section, submit an answer,
  receive a grading result.

A third surface (mindmap support) lives in
``app/schemas/sections.py`` — keeps each schema module small.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


# ---------------------------------------------------------------------------
# Path lifecycle
# ---------------------------------------------------------------------------


class StartLearningPathRequest(BaseModel):
    """Diagnostic answers + the document the user wants to learn from.

    ``goal_text`` is the answer to "what are you trying to learn?".
    ``depth`` is the depth-preference answer ("quick", "normal", "deep").
    ``prior_known_concept_ids`` is the chips/tags the user tapped to
    indicate "I already know this". Optional — empty list is fine and
    drops the user back to "default known set = mastery >= 0.7".
    """

    document_id: UUID
    goal_text: str = Field(min_length=2, max_length=2000)
    depth: str = "normal"
    prior_known_concept_ids: list[UUID] = []

    @field_validator("depth")
    @classmethod
    def _validate_depth(cls, v: str) -> str:
        if v not in ("quick", "normal", "deep"):
            raise ValueError("depth must be one of: quick, normal, deep")
        return v


class PathStepResponse(BaseModel):
    """One row of the path — what the user works through in order."""

    section_id: UUID
    title: str
    rationale: str
    page_start: int
    page_end: int
    is_target: bool
    is_prereq: bool
    status: str  # pending | in_progress | completed | skipped
    completed_at: datetime | None = None
    mastery_delta_json: dict[str, Any] | None = None


class LearningPathResponse(BaseModel):
    id: UUID
    document_id: UUID
    user_id: UUID
    status: str  # active | paused | completed | stale
    goal_text: str
    depth: str
    plan: list[PathStepResponse]
    current_step: int
    recompute_count: int
    started_at: datetime
    last_active_at: datetime
    completed_at: datetime | None = None


# ---------------------------------------------------------------------------
# Check-ins
# ---------------------------------------------------------------------------


class CheckInQuestionResponse(BaseModel):
    """Question stem + payload, **without** the answer key or
    explanation. The grading endpoint reveals those after submission.
    """

    id: UUID
    section_id: UUID
    question_type: str
    stem: str
    payload: dict[str, Any]  # type-specific; choices for MCQ, etc.
    difficulty: int
    estimated_seconds: int
    display_ordinal: int


class CheckInAnswerRequest(BaseModel):
    question_id: UUID
    # Free-form string for every question type — the grader knows
    # how to parse it based on type. For MCQ the frontend sends the
    # label ("A", "B", …); for numeric, the raw input text;
    # for symbolic, the LaTeX or SymPy-style expression; for
    # free-text, the answer paragraph.
    user_answer: str


class MasteryUpdateResponse(BaseModel):
    concept_id: UUID
    previous_score: float
    new_score: float
    is_known_now: bool
    became_known: bool
    became_unknown: bool


class CheckInResultResponse(BaseModel):
    """What the user sees after submitting a check-in."""

    is_correct: bool
    score: float  # 0..1
    feedback: str  # short user-facing message
    explanation: str  # the question's canonical reasoning
    misconception_tag: str | None = None
    mastery_updates: list[MasteryUpdateResponse] = []
    # When the user just finished the last question for a section,
    # the chat handler should advance the path and reload state —
    # this flag tells the frontend to refetch.
    section_completed: bool = False


# ---------------------------------------------------------------------------
# Path advance / skip
# ---------------------------------------------------------------------------


class AdvanceStepRequest(BaseModel):
    """Used by the frontend to mark the current step done without
    going through check-ins (e.g. the user explicitly skipped) or
    to confirm completion after the last check-in passed.
    """

    skip: bool = False  # if true, mark as skipped instead of completed


# ---------------------------------------------------------------------------
# Mindmap section tree
# ---------------------------------------------------------------------------


class SectionNodeResponse(BaseModel):
    """One node of the document's section tree (book → topic →
    subtopic → headline). The frontend uses this to render the
    mindmap; nested via ``children``."""

    id: UUID
    kind: str  # topic | subtopic | headline
    title: str
    page_start: int
    page_end: int
    ordinal: int
    # For headlines: the section's summary. For topics/subtopics:
    # the rollup summary.
    summary: str | None = None
    # Headlines only: which concepts they introduce / apply, for the
    # mindmap to colour by mastery.
    concept_ids: list[UUID] = []
    # Headlines only: the user's average mastery across the
    # introduced concepts (0..1). Drives the node fill colour on
    # the mindmap. Null for non-leaf nodes (computed client-side
    # as the average of descendants' values).
    mastery_score: float | None = None
    # Recursive — the frontend tree-renders from this.
    children: list["SectionNodeResponse"] = []
