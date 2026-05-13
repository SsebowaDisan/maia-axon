"""Question-bank model.

Each ``DocumentSection`` of kind ``headline`` accumulates a small
bank of check-in questions during the offline question-generation
pass. Each question targets one or more concepts that the section
introduces or applies, has a type that determines how it's graded,
and stores type-specific payload in a JSONB column.

A single table — not one table per question type — because the
type-specific fields differ enough that splitting them out would
explode the schema, and we never query *within* the payload (only
read it whole for the user and the grader).

Question types
--------------
``mcq``
    Multiple-choice recognition. Payload carries ``choices`` array.
    Graded by exact match against the choice marked ``is_correct``.

``numeric``
    Numeric answer with optional unit and tolerance. Graded by
    parsing the user's input via SymPy + pint and comparing within
    tolerance.

``symbolic``
    Algebraic / LaTeX answer. Graded by ``simplify(user - expected)``
    via SymPy. Much more reliable than asking an LLM whether two
    expressions are equivalent.

``free_text``
    Explanation in natural language. Graded by an LLM rubric grader
    decomposed into per-criterion yes/no checks (not "is this
    correct" — that's where LLM grading fails).

``counterexample``
    Free-text or short answer. Either a constrained rubric grader
    (specific properties the counterexample must have) or an
    MCQ-style multiple-choice "which of these is a counterexample".
    Stored as ``mcq`` or ``free_text`` under the hood — kept as a
    separate semantic type so the UI can label and pace it
    differently.

``code``
    Python answer graded by running it against test cases in a
    sandbox. Payload carries ``test_cases`` and ``setup_code``.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

QUESTION_TYPES = (
    "mcq",
    "numeric",
    "symbolic",
    "free_text",
    "counterexample",
    "code",
)


class SectionQuestion(Base):
    """One check-in question for a section.

    The payload JSON's shape depends on ``question_type``:

    * ``mcq`` / ``counterexample`` (MCQ flavour):
          {
            "choices": [
              {"label": "A", "text": "...", "is_correct": bool, "misconception": str | null},
              ...
            ]
          }
    * ``numeric``:
          {
            "correct_value": float,
            "tolerance": float,        # absolute, in answer units
            "unit": str | null,        # e.g. "Pa", "m/s", null for dimensionless
            "alternate_forms": [str, ...]  # additional accepted text representations
          }
    * ``symbolic``:
          {
            "correct_expression_latex": str,
            "variables": [str, ...],       # variable names that appear in the answer
            "domain_constraints": str | null  # human-readable, e.g. "x > 0"
          }
    * ``free_text`` / ``counterexample`` (rubric flavour):
          {
            "rubric": [
              {
                "criterion": str,                # what the grader checks for
                "expected_signal": str,          # an answer that would satisfy
                "misconception_if_missing": str | null
              },
              ...
            ],
            "pass_threshold": int                # minimum criteria satisfied to pass
          }
    * ``code``:
          {
            "starter_code": str | null,
            "setup_code": str | null,        # runs before user code (imports, fixtures)
            "test_cases": [
              {
                "input": str | dict,
                "expected_output": str | dict
              },
              ...
            ],
            "language": "python"
          }

    ``stem`` always carries the prompt the user sees. ``explanation``
    is shown after grading so the user learns from a wrong answer.
    ``concept_ids`` lets the mastery system update the right concepts
    when this question is answered.
    """

    __tablename__ = "section_questions"
    __table_args__ = (
        # Hot path: "give me this section's questions, ordered for
        # display". `display_ordinal` is set by the generator so
        # MCQs come first, free-text later — mimics typical
        # learning-app pacing.
        Index(
            "ix_section_questions_section_ord",
            "section_id",
            "display_ordinal",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    section_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("document_sections.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # 'mcq' | 'numeric' | 'symbolic' | 'free_text' | 'counterexample' | 'code'
    question_type: Mapped[str] = mapped_column(String(20), nullable=False)
    stem: Mapped[str] = mapped_column(Text, nullable=False)
    # The shape is determined by question_type — see class docstring.
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    # Shown to the user after grading. Always present so a wrong
    # answer never leaves them hanging.
    explanation: Mapped[str] = mapped_column(Text, nullable=False)
    # JSON array of concept UUIDs (stringified) this question tests.
    # Stored as JSONB (not a bridge table) because most reads pull
    # the whole list at once for the mastery update and we never
    # search by individual concept.
    concept_ids: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    # 1 introductory, 5 challenging. Pulled from the section's
    # difficulty (or the generator can lower for early recognition
    # checks and raise for synthesis checks).
    difficulty: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    # Realistic seconds for a beginner to answer. UI uses this to
    # show "this should take ~30s" and to pace check-ins.
    estimated_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=45)
    # JSON array of short tags describing the misconceptions
    # tested by this question's distractors / rubric. Useful for
    # the per-user misconception tracker.
    misconception_tags: Mapped[list] = mapped_column(
        JSONB, nullable=False, default=list
    )
    # Sort order within a section. Generator sets it so that
    # recognition checks come before application checks before
    # explanation checks.
    display_ordinal: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    section = relationship("DocumentSection", backref="questions")
