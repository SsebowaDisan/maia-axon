"""add message visualizations

Revision ID: 006_message_visualizations
Revises: 005_companies_exports
Create Date: 2026-04-23
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "006_message_visualizations"
down_revision: Union[str, None] = "005_companies_exports"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("visualizations", JSONB, nullable=True))


def downgrade() -> None:
    op.drop_column("messages", "visualizations")
