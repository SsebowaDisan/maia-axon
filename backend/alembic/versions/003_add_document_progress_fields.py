"""add document progress fields

Revision ID: 003_add_document_progress_fields
Revises: 002
Create Date: 2026-04-09 15:10:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "003_add_document_progress_fields"
down_revision = "002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("documents", sa.Column("current_stage", sa.String(length=20), nullable=True))
    op.add_column("documents", sa.Column("progress_current", sa.Integer(), nullable=True))
    op.add_column("documents", sa.Column("progress_total", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("documents", "progress_total")
    op.drop_column("documents", "progress_current")
    op.drop_column("documents", "current_stage")
