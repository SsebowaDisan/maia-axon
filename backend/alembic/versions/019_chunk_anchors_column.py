"""add anchors column to chunks for sentence-level citations

Stores a JSONB list of per-sentence anchors per chunk:
``[{"id": "12.3", "bbox": [x1,y1,x2,y2], "char_start": 0, "char_end": 87}, ...]``

The id format is ``{page_number}.{reading_order}``. The answer model receives
chunk text with inline ``<c>12.3</c>`` markers, returns those ids in its
citation field, and the backend resolves each id to its sentence-level bbox
for rendering a precise highlight (NotebookLM-style).

Nullable so existing chunks remain valid; the ingestion pipeline populates
the field on new uploads, and the backfill script (forthcoming) re-anchors
historical data.

Revision ID: 019_chunk_anchors_column
Revises: 018_citation_boxes_promote
Create Date: 2026-05-05
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "019_chunk_anchors_column"
down_revision: Union[str, None] = "018_citation_boxes_promote"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("chunks", sa.Column("anchors", JSONB, nullable=True))


def downgrade() -> None:
    op.drop_column("chunks", "anchors")
