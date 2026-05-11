"""Cache the printed-page-number → internal-page-index offset on each
document so the PDF viewer can resolve TOC entries (e.g. "Chapter 5 ...
40") to the right page without recomputing on every open.

A NULL value means "not yet computed"; 0 means "no offset" (printed
page numbers match internal indices, common for short docs).

Revision ID: 022_doc_printed_page_offset
Revises: 021_annotations_table
Create Date: 2026-05-12
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "022_doc_printed_page_offset"
down_revision: Union[str, None] = "021_annotations_table"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "documents",
        sa.Column("printed_page_offset", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("documents", "printed_page_offset")
