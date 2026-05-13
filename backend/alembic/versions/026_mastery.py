"""Per-user mastery + misconception state for learn mode.

Two tables, both keyed on (user_id, X) with a unique constraint:

* ``user_concept_mastery`` — moving-average score + SM-2 spaced-
  repetition state per (user, concept).
* ``user_misconceptions`` — accumulated misconception counter per
  (user, misconception_tag) with addressed flag for the
  compare/contrast scaffolding trigger.

Revision ID: 026_mastery
Revises: 025_section_questions
Create Date: 2026-05-12
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "026_mastery"
down_revision: Union[str, None] = "025_section_questions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "user_concept_mastery",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
        ),
        sa.Column(
            "user_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "concept_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("concepts.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("score", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("ease_factor", sa.Float(), nullable=False, server_default="2.5"),
        sa.Column("repetition_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("interval_days", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column(
            "next_review_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_correct_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("times_seen", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("times_correct", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "user_id", "concept_id", name="uq_user_concept_mastery"
        ),
    )
    # Hot path: "concepts due for review for this user".
    op.create_index(
        "ix_user_concept_mastery_due",
        "user_concept_mastery",
        ["user_id", "next_review_at"],
    )

    op.create_table(
        "user_misconceptions",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
        ),
        sa.Column(
            "user_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("misconception_tag", sa.Text(), nullable=False),
        sa.Column("fire_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "last_fired_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column(
            "addressed_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column("related_concept_ids", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "user_id",
            "misconception_tag",
            name="uq_user_misconceptions",
        ),
    )


def downgrade() -> None:
    op.drop_table("user_misconceptions")
    op.drop_index(
        "ix_user_concept_mastery_due",
        table_name="user_concept_mastery",
    )
    op.drop_table("user_concept_mastery")
