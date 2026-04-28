"""promote francis to admin

Revision ID: 012_promote_francis_to_admin
Revises: 011_deduplicate_document_pages
Create Date: 2026-04-28
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "012_promote_francis_to_admin"
down_revision: Union[str, None] = "011_deduplicate_document_pages"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        sa.text("UPDATE users SET role = 'admin' WHERE lower(email) = 'francis@maia.local'")
    )


def downgrade() -> None:
    op.execute(
        sa.text("UPDATE users SET role = 'user' WHERE lower(email) = 'francis@maia.local'")
    )
