"""Per-section question bank, generated offline as part of the
section_mapping / learn-mode pipeline.

One table — `section_questions` — with a flexible JSONB ``payload``
column whose shape depends on ``question_type``. The schema-per-type
discipline lives in the application layer (see
``app/models/question.py`` for the contract). Keeping it in one
table because we never query *into* the payload — we read it whole
for the user and for the grader.

Revision ID: 025_section_questions
Revises: 024_concept_graph
Create Date: 2026-05-12
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "025_section_questions"
down_revision: Union[str, None] = "024_concept_graph"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "section_questions",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
        ),
        sa.Column(
            "section_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("document_sections.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("question_type", sa.String(20), nullable=False),
        sa.Column("stem", sa.Text(), nullable=False),
        sa.Column(
            "payload",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
        ),
        sa.Column("explanation", sa.Text(), nullable=False),
        sa.Column(
            "concept_ids",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "difficulty",
            sa.Integer(),
            nullable=False,
            server_default="2",
        ),
        sa.Column(
            "estimated_seconds",
            sa.Integer(),
            nullable=False,
            server_default="45",
        ),
        sa.Column(
            "misconception_tags",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "display_ordinal",
            sa.Integer(),
            nullable=False,
            server_default="0",
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
    # Hot-path display query: "section's questions in display order".
    op.create_index(
        "ix_section_questions_section_ord",
        "section_questions",
        ["section_id", "display_ordinal"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_section_questions_section_ord",
        table_name="section_questions",
    )
    op.drop_table("section_questions")
