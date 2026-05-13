"""User learning path state.

One ``UserLearningPath`` row per active learn-mode session. The path
plan itself — an ordered list of section IDs with per-step status
and rationale — lives in a single JSONB column so it serialises
trivially to the frontend.

Why a single JSONB column rather than a path_steps table?
    The path is a snapshot of the plan at creation time, mutated only
    by the path-recomputation step. We never need to query individual
    steps across paths, never join steps to other tables, and the
    plan is read whole by the chat handler on every turn. JSONB
    matches the access pattern exactly — and lets the recomputation
    step rewrite the plan atomically (write the new plan, swap one
    column) without juggling step-level inserts/deletes.

Status transitions
------------------
``active``   — the user is working through the plan.
``paused``   — temporary pause (user closed the chat, came back later).
                Path can resume from ``current_step``.
``completed`` — every step has status ``completed`` or ``skipped``.
``stale``    — superseded by a regenerated path on the same
                (user, document). Kept around for audit / replay.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

LEARNING_PATH_STATUSES = ("active", "paused", "completed", "stale")
LEARNING_PATH_DEPTHS = ("quick", "normal", "deep")
LEARNING_PATH_STEP_STATUSES = (
    "pending",
    "in_progress",
    "completed",
    "skipped",
)


class UserLearningPath(Base):
    """One in-flight (or completed) learn-mode session for a user.

    ``plan_json`` is the ordered list of step descriptors:
        [
          {
            "section_id": <uuid>,
            "rationale": <string>,         # 1-sentence "why this section"
            "status": <step status>,
            "completed_at": <iso8601 | null>,
            "mastery_delta_json": <dict | null>  # per-concept score deltas
          },
          ...
        ]

    The chat handler reads ``plan_json[current_step]`` on every turn
    to know where the user is, and bumps ``current_step`` after a
    section's check-ins pass.

    A single (user, document) can have multiple paths over time —
    new ones supersede old (the old gets ``status = stale``). The
    most recent ``active`` / ``paused`` path is the one resumed
    when the user reopens learn mode for that document.
    """

    __tablename__ = "user_learning_paths"
    __table_args__ = (
        # Hot path: "give me this user's current path for this document".
        Index(
            "ix_user_learning_paths_active",
            "user_id",
            "document_id",
            "status",
            "last_active_at",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    # User's free-text answer to "what are you trying to learn?".
    # Stored for path-rationale generation and so the chat handler
    # can keep referring back to the original goal.
    goal_text: Mapped[str] = mapped_column(Text, nullable=False)
    # 'quick' | 'normal' | 'deep' — depth preference from the
    # diagnostic. Drives which prerequisite levels survive trimming.
    depth: Mapped[str] = mapped_column(String(20), nullable=False, default="normal")
    # JSON-encoded list of concept ids the user said they already
    # knew during the diagnostic. Used to seed the "known" set for
    # the path generator before any check-ins have run.
    prior_known_concept_ids: Mapped[list | None] = mapped_column(
        JSONB, nullable=True
    )
    # The plan itself — see the class docstring for the shape.
    plan_json: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    # Index into plan_json of the step currently being worked on.
    # Equals ``len(plan_json)`` when the path is completed.
    current_step: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Number of times this path's recompute has run. Used as a
    # tie-breaker between identical paths and useful for debugging
    # "why did the path change between turns?".
    recompute_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    last_active_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
