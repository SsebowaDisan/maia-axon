"""Per-user mastery state for the learn-mode adaptive engine.

Two tables:

``user_concept_mastery``
    One row per (user, concept). Carries the moving-average mastery
    score (0..1), SM-2 spaced-repetition state, last-seen timestamps,
    and lightweight counters. Updated after every grading event;
    decays toward 0.7 baseline if the user hasn't seen the concept
    in a while.

``user_misconceptions``
    One row per (user, misconception_tag). Counter + last-fired
    timestamp + addressed flag. The check-in flow inspects this:
    when a tag fires twice without being addressed, the next
    relevant section gets a "I notice you've confused X and Y twice
    — here's the distinction" preamble.

Why per-concept, not per-section?
    Concepts span books — covering "vector space" in book A
    advances your mastery of it everywhere it appears. Per-section
    state would force the user to re-prove themselves every time
    the same concept came up under a different chapter heading.
    The concept graph already handles "what is this concept" as a
    canonical idea; mastery sits on top.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class UserConceptMastery(Base):
    """Per-(user, concept) mastery + spaced-repetition state.

    Score is a moving average in [0, 1] updated by an exponential
    rule after every grading event the concept participates in:

        new_score = old_score + α * (outcome - old_score)

    where α decays as ``times_seen`` grows (so early encounters move
    the needle more than later ones — exactly mirrors how human
    confidence builds with repetition).

    Spaced repetition state follows SM-2:
    ``ease_factor`` (default 2.5), ``repetition_count`` (consecutive
    correct responses, resets on a wrong answer), and ``interval_days``
    (next review gap). ``next_review_at`` is the materialised
    scheduling timestamp — indexed for the "show me concepts due
    today" query.
    """

    __tablename__ = "user_concept_mastery"
    __table_args__ = (
        UniqueConstraint("user_id", "concept_id", name="uq_user_concept_mastery"),
        Index("ix_user_concept_mastery_due", "user_id", "next_review_at"),
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
    concept_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("concepts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Moving-average mastery in [0, 1]. 0 = never seen, 1 = fluent.
    # Initialised to 0 on first encounter; updated by the exponential
    # rule on every grading event.
    score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    # SM-2 ease factor, default 2.5. Bounded below at 1.3 by the
    # standard SM-2 update rule. Higher = concept is easy for this
    # user and review intervals grow faster.
    ease_factor: Mapped[float] = mapped_column(Float, nullable=False, default=2.5)
    # SM-2 consecutive-correct counter. Resets to 0 on a wrong answer.
    repetition_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # SM-2 review-interval in days. Used to compute next_review_at.
    interval_days: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    # When the user should next see this concept for review. Null
    # before the first review is scheduled.
    next_review_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_correct_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    times_seen: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    times_correct: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class UserMisconception(Base):
    """Per-(user, misconception_tag) accumulated counter + state.

    Populated whenever a grading event surfaces a tagged misconception
    (MCQ distractor picked, rubric criterion missed with a tag). The
    check-in flow watches the counter: at >= 2 unaddressed fires, the
    next relevant section gets an explicit "compare and contrast"
    preamble. After the preamble runs, ``addressed_at`` is set, the
    counter is reset, and the cycle starts over.
    """

    __tablename__ = "user_misconceptions"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "misconception_tag", name="uq_user_misconceptions"
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
    # Free-form tag string — same vocabulary the question generator
    # uses on distractors / rubric criteria. Examples:
    # "confuses_vector_with_scalar", "uses_static_pressure_for_total".
    misconception_tag: Mapped[str] = mapped_column(Text, nullable=False)
    # Total times this tag has fired for this user (since last
    # addressed). Reset to 0 when ``addressed_at`` is set.
    fire_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_fired_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    addressed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Concepts this misconception tends to attach to — a JSONB-like
    # text array, populated from the questions that have fired it
    # for this user. Used by the path recomputation step to know
    # which sections benefit from a compare/contrast scaffold.
    related_concept_ids: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
