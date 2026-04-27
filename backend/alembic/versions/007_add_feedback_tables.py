"""add feedback tables

Revision ID: 007_feedback_tables
Revises: 006_message_visualizations
Create Date: 2026-04-27
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "007_feedback_tables"
down_revision: Union[str, None] = "006_message_visualizations"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "message_feedback",
        sa.Column("id", UUID(as_uuid=True), nullable=False),
        sa.Column("message_id", UUID(as_uuid=True), nullable=False),
        sa.Column("conversation_id", UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), nullable=False),
        sa.Column("rating", sa.String(length=12), nullable=False),
        sa.Column("tags", JSONB, nullable=True),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["message_id"], ["messages.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("message_id", "user_id", name="uq_message_feedback_message_user"),
    )
    op.create_index(op.f("ix_message_feedback_conversation_id"), "message_feedback", ["conversation_id"], unique=False)
    op.create_index(op.f("ix_message_feedback_message_id"), "message_feedback", ["message_id"], unique=False)
    op.create_index(op.f("ix_message_feedback_user_id"), "message_feedback", ["user_id"], unique=False)

    op.create_table(
        "feature_ideas",
        sa.Column("id", UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), nullable=False),
        sa.Column("category", sa.String(length=64), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=True),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("priority", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_feature_ideas_status"), "feature_ideas", ["status"], unique=False)
    op.create_index(op.f("ix_feature_ideas_user_id"), "feature_ideas", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_feature_ideas_user_id"), table_name="feature_ideas")
    op.drop_index(op.f("ix_feature_ideas_status"), table_name="feature_ideas")
    op.drop_table("feature_ideas")
    op.drop_index(op.f("ix_message_feedback_user_id"), table_name="message_feedback")
    op.drop_index(op.f("ix_message_feedback_message_id"), table_name="message_feedback")
    op.drop_index(op.f("ix_message_feedback_conversation_id"), table_name="message_feedback")
    op.drop_table("message_feedback")
