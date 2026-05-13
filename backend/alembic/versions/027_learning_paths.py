"""Per-user learning-path state for learn mode.

One table — ``user_learning_paths`` — with the ordered plan stored
in a JSONB column. Status / current_step / mastery deltas are
mutated in place by the path-recomputation step; stale paths are
preserved (status = 'stale') for audit and replay.

Revision ID: 027_learning_paths
Revises: 026_mastery
Create Date: 2026-05-12
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "027_learning_paths"
down_revision: Union[str, None] = "026_mastery"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "user_learning_paths",
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
            "document_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("documents.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="active",
        ),
        sa.Column("goal_text", sa.Text(), nullable=False),
        sa.Column(
            "depth",
            sa.String(20),
            nullable=False,
            server_default="normal",
        ),
        sa.Column(
            "prior_known_concept_ids",
            sa.dialects.postgresql.JSONB(),
            nullable=True,
        ),
        sa.Column(
            "plan_json",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "current_step",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "recompute_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "last_active_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "completed_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
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
    )
    op.create_index(
        "ix_user_learning_paths_active",
        "user_learning_paths",
        ["user_id", "document_id", "status", "last_active_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_user_learning_paths_active",
        table_name="user_learning_paths",
    )
    op.drop_table("user_learning_paths")
