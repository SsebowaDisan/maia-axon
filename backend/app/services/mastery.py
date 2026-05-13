"""Mastery + spaced-repetition service.

Every grading event in learn mode flows through ``apply_grade``,
which:

  * updates the moving-average mastery score for every concept the
    question tested;
  * runs the SM-2 spaced-repetition step (next interval, ease
    factor, due-date);
  * records any tagged misconception that fired (and bumps the
    counter that triggers compare/contrast scaffolding).

The path generator (separate service) calls ``known_concepts`` and
``concepts_due_for_review`` to plan and re-plan paths.

Decay
-----
Mastery decays toward a 0.7 baseline if the concept hasn't been
reviewed recently. Why 0.7, not 0?
    Forgetting curves taper to a non-zero asymptote — once you've
    really learnt something, you don't completely lose it. 0.7 means
    "you knew it well; you'd recognise it but might need a refresher
    on the details." Below the path-generation threshold for
    "skip this prereq" but above the threshold for "treat as never
    seen."
"""

from __future__ import annotations

import json
import logging
import math
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Iterable, Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.mastery import UserConceptMastery, UserMisconception
from app.services.grading import GradeResult

logger = logging.getLogger(__name__)


# Mastery threshold above which the path generator treats a concept
# as "known" and will skip its prerequisites. 0.7 leaves headroom for
# decay — a concept that drifts down to 0.65 falls back into review.
_KNOWN_THRESHOLD = 0.7

# Mastery decay parameters. Half-life in days for how long a concept's
# score takes to halve the gap to the baseline (0.7) without practice.
# 30 days for easy concepts, scaling up to 90 days for harder ones,
# because hard concepts get more deliberate practice to ingrain in
# the first place.
_DECAY_HALF_LIFE_DAYS = {1: 30, 2: 45, 3: 60, 4: 75, 5: 90}
_DECAY_BASELINE = 0.7

# Misconception trigger: at this many unaddressed fires of the same
# tag, surface a compare/contrast scaffold before the next related
# section.
_MISCONCEPTION_TRIGGER_COUNT = 2

# How fast the moving-average mastery score adapts to a new outcome.
# Higher alpha = score moves more on each event. Decays as
# times_seen grows so early encounters move the needle more than
# the 47th repetition.
def _alpha(times_seen: int) -> float:
    if times_seen <= 2:
        return 0.30
    return 0.15 / math.sqrt(max(1, times_seen - 2))


# Map our 0..1 grading score to SM-2's 0..5 quality scale. The thresholds
# tally with the GradeResult convention: 1.0 = correct first try, 0.5
# = correct after hint, 0 = wrong.
def _sm2_quality(score: float, correct: bool) -> int:
    if not correct:
        return 0 if score < 0.25 else 2
    if score >= 0.95:
        return 5
    if score >= 0.7:
        return 4
    return 3


@dataclass
class MasteryUpdate:
    """Concise record of what changed for one concept on one event.
    Returned by ``apply_grade`` so the caller (chat handler) can
    surface "mastery +0.12 on vector space" UI hints if it wants."""

    concept_id: uuid.UUID
    previous_score: float
    new_score: float
    is_known_now: bool
    became_known: bool
    became_unknown: bool


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _get_or_create_mastery(
    db: Session,
    user_id: uuid.UUID,
    concept_id: uuid.UUID,
) -> UserConceptMastery:
    row = (
        db.query(UserConceptMastery)
        .filter(UserConceptMastery.user_id == user_id)
        .filter(UserConceptMastery.concept_id == concept_id)
        .first()
    )
    if row is not None:
        return row
    row = UserConceptMastery(
        id=uuid.uuid4(),
        user_id=user_id,
        concept_id=concept_id,
        score=0.0,
    )
    db.add(row)
    db.flush()
    return row


def _decay_to_now(row: UserConceptMastery, difficulty_tier: int | None) -> None:
    """In-place decay toward the baseline based on time since last_seen.

    Pure update on the row object — no DB write. Caller is expected
    to commit / let the session flush. Called from ``apply_grade``
    so the update uses the decayed score as its starting point
    (otherwise stale scores would over-reward easy recognition).
    """
    if row.last_seen_at is None or row.score <= _DECAY_BASELINE:
        return
    elapsed_days = (_now() - row.last_seen_at).total_seconds() / 86_400
    if elapsed_days <= 1:
        return
    half_life = _DECAY_HALF_LIFE_DAYS.get(difficulty_tier or 3, 60)
    decay_factor = 1 - math.exp(-elapsed_days * math.log(2) / half_life)
    row.score = row.score - (row.score - _DECAY_BASELINE) * decay_factor


def _sm2_step(row: UserConceptMastery, quality: int) -> None:
    """One SM-2 update step. Mutates the row in place."""
    if quality < 3:
        row.repetition_count = 0
        row.interval_days = 1.0
    else:
        row.repetition_count += 1
        if row.repetition_count == 1:
            row.interval_days = 1.0
        elif row.repetition_count == 2:
            row.interval_days = 6.0
        else:
            row.interval_days = row.interval_days * row.ease_factor

    # Ease-factor update — standard SM-2 formula. Clamp at 1.3.
    delta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)
    row.ease_factor = max(1.3, row.ease_factor + delta)
    row.next_review_at = _now() + timedelta(days=row.interval_days)


# ---------------------------------------------------------------------------
# Public API: apply a grading event
# ---------------------------------------------------------------------------


def apply_grade(
    db: Session,
    *,
    user_id: uuid.UUID,
    concept_ids: Sequence[uuid.UUID],
    result: GradeResult,
    difficulty: int | None = None,
) -> list[MasteryUpdate]:
    """Update mastery for every concept the question tested.

    Returns one ``MasteryUpdate`` per concept so the chat handler can
    decide what UI feedback to render. Caller is responsible for the
    DB commit — keeping it in the caller lets one "user answered N
    check-ins in a row" update batch into a single transaction.
    """
    updates: list[MasteryUpdate] = []
    if not concept_ids:
        return updates

    quality = _sm2_quality(result.score, result.is_correct)
    outcome = result.score  # 0..1; rubric grades naturally pass partial

    for concept_id in concept_ids:
        row = _get_or_create_mastery(db, user_id, concept_id)
        _decay_to_now(row, difficulty)

        previous_score = row.score
        was_known = previous_score >= _KNOWN_THRESHOLD

        # Moving-average update.
        alpha = _alpha(row.times_seen)
        row.score = max(0.0, min(1.0, row.score + alpha * (outcome - row.score)))
        row.times_seen += 1
        if result.is_correct:
            row.times_correct += 1
            row.last_correct_at = _now()
        row.last_seen_at = _now()

        # SM-2 schedule.
        _sm2_step(row, quality)

        is_known = row.score >= _KNOWN_THRESHOLD
        updates.append(
            MasteryUpdate(
                concept_id=concept_id,
                previous_score=previous_score,
                new_score=row.score,
                is_known_now=is_known,
                became_known=is_known and not was_known,
                became_unknown=was_known and not is_known,
            )
        )

    # Misconception accounting.
    if result.misconception_tag:
        record_misconception(
            db,
            user_id=user_id,
            misconception_tag=result.misconception_tag,
            related_concept_ids=list(concept_ids),
        )

    return updates


# ---------------------------------------------------------------------------
# Misconception tracking
# ---------------------------------------------------------------------------


def record_misconception(
    db: Session,
    *,
    user_id: uuid.UUID,
    misconception_tag: str,
    related_concept_ids: Iterable[uuid.UUID],
) -> UserMisconception:
    """Bump the user's counter for this misconception tag. Creates
    the row if missing. Caller commits."""
    tag = misconception_tag.strip()
    row = (
        db.query(UserMisconception)
        .filter(UserMisconception.user_id == user_id)
        .filter(UserMisconception.misconception_tag == tag)
        .first()
    )
    if row is None:
        row = UserMisconception(
            id=uuid.uuid4(),
            user_id=user_id,
            misconception_tag=tag,
            fire_count=0,
            related_concept_ids="[]",
        )
        db.add(row)
        db.flush()

    row.fire_count += 1
    row.last_fired_at = _now()

    # Merge related concept ids (stored as JSON-encoded string for
    # portability across DB types). De-duplicated, capped at 32 ids.
    existing = []
    if row.related_concept_ids:
        try:
            existing = json.loads(row.related_concept_ids)
        except json.JSONDecodeError:
            existing = []
    merged = {str(c) for c in existing}
    for cid in related_concept_ids:
        merged.add(str(cid))
    row.related_concept_ids = json.dumps(sorted(merged)[:32])
    return row


def misconceptions_due_for_address(
    db: Session, user_id: uuid.UUID
) -> list[UserMisconception]:
    """Return tags that have fired enough times to warrant an explicit
    compare/contrast preamble in the next check-in. The check-in flow
    calls this before generating the next section's narration, and
    if anything fires, prepends a scaffold."""
    return (
        db.query(UserMisconception)
        .filter(UserMisconception.user_id == user_id)
        .filter(UserMisconception.fire_count >= _MISCONCEPTION_TRIGGER_COUNT)
        .filter(UserMisconception.addressed_at.is_(None))
        .order_by(UserMisconception.last_fired_at.desc())
        .all()
    )


def mark_misconception_addressed(
    db: Session, *, user_id: uuid.UUID, misconception_tag: str
) -> None:
    row = (
        db.query(UserMisconception)
        .filter(UserMisconception.user_id == user_id)
        .filter(UserMisconception.misconception_tag == misconception_tag)
        .first()
    )
    if row is None:
        return
    row.addressed_at = _now()
    row.fire_count = 0


# ---------------------------------------------------------------------------
# Query helpers for the path generator
# ---------------------------------------------------------------------------


def known_concepts(
    db: Session, user_id: uuid.UUID, threshold: float = _KNOWN_THRESHOLD
) -> set[uuid.UUID]:
    """The user's currently-known concept set.

    Applies live decay before checking the threshold — so a concept
    the user hasn't seen in months may drop below the threshold even
    though its stored score is high.
    """
    rows = (
        db.query(UserConceptMastery)
        .filter(UserConceptMastery.user_id == user_id)
        .all()
    )
    known: set[uuid.UUID] = set()
    for row in rows:
        # We don't know per-concept difficulty here without joining;
        # use the middle-of-the-road decay rate for the check. Live
        # decay during grading uses the concept's actual difficulty.
        if row.last_seen_at is not None:
            elapsed_days = (_now() - row.last_seen_at).total_seconds() / 86_400
            if elapsed_days > 1 and row.score > _DECAY_BASELINE:
                decay_factor = 1 - math.exp(
                    -elapsed_days * math.log(2) / _DECAY_HALF_LIFE_DAYS[3]
                )
                effective_score = row.score - (row.score - _DECAY_BASELINE) * decay_factor
            else:
                effective_score = row.score
        else:
            effective_score = row.score
        if effective_score >= threshold:
            known.add(row.concept_id)
    return known


def concepts_due_for_review(
    db: Session,
    user_id: uuid.UUID,
    *,
    limit: int = 20,
) -> list[uuid.UUID]:
    """Concepts whose SM-2 next_review_at has passed. Ordered by
    most-overdue first. Used by the dashboard's "review queue" panel
    and by the path generator when the user explicitly asks for
    review rather than new material."""
    now = _now()
    rows = (
        db.query(UserConceptMastery.concept_id)
        .filter(UserConceptMastery.user_id == user_id)
        .filter(UserConceptMastery.next_review_at.is_not(None))
        .filter(UserConceptMastery.next_review_at <= now)
        .order_by(UserConceptMastery.next_review_at.asc())
        .limit(limit)
        .all()
    )
    return [row[0] for row in rows]


def mastery_snapshot(
    db: Session, user_id: uuid.UUID, concept_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, float]:
    """Return the user's current score for each concept. Concepts
    never seen come back at 0.0. Lightweight — for rendering the
    mindmap colour overlay or a path's progress bar."""
    if not concept_ids:
        return {}
    rows = (
        db.query(UserConceptMastery.concept_id, UserConceptMastery.score)
        .filter(UserConceptMastery.user_id == user_id)
        .filter(UserConceptMastery.concept_id.in_(list(concept_ids)))
        .all()
    )
    out: dict[uuid.UUID, float] = {cid: 0.0 for cid in concept_ids}
    for cid, score in rows:
        out[cid] = float(score)
    return out
