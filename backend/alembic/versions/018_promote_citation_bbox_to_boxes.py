"""promote legacy citation bbox to boxes

Older persisted message citations were written before the per-region ``boxes``
field existed and only carry a single ``bbox`` 4-element list. The frontend
no longer falls back to ``bbox`` for highlight rendering, so those citations
would silently lose their highlights. This migration promotes ``bbox`` into
``boxes = [bbox]`` so the new code path renders them.

Degenerate boxes (``x2 <= x1`` or ``y2 <= y1``) are left alone — they would
render as phantom rectangles via the renderer's minimum-size clamps.

Revision ID: 018_citation_boxes_promote
Revises: 017_general_projects
Create Date: 2026-05-05
"""

from __future__ import annotations

import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "018_citation_boxes_promote"
down_revision: Union[str, None] = "017_general_projects"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _promote_one(citation: dict) -> dict:
    """Return a citation dict with ``boxes`` populated from ``bbox`` if needed."""
    if not isinstance(citation, dict):
        return citation
    if citation.get("boxes") is not None:
        return citation
    bbox = citation.get("bbox")
    if not isinstance(bbox, list) or len(bbox) != 4:
        return citation
    try:
        x1, y1, x2, y2 = (float(v) for v in bbox)
    except (TypeError, ValueError):
        return citation
    if x2 <= x1 or y2 <= y1:
        # Degenerate bbox; skip rather than promote (would render as ghost).
        return citation
    promoted = dict(citation)
    promoted["boxes"] = [bbox]
    return promoted


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            """
            SELECT m.id, m.citations
            FROM messages m
            WHERE m.role = 'assistant'
              AND m.citations IS NOT NULL
              AND EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(m.citations->'citations') c
                  WHERE c->'bbox' IS NOT NULL AND c->'boxes' IS NULL
              )
            """
        )
    ).fetchall()

    for message_id, citations in rows:
        if not isinstance(citations, dict):
            continue
        cite_list = citations.get("citations", [])
        if not isinstance(cite_list, list):
            continue

        new_list = [_promote_one(c) for c in cite_list]
        if new_list == cite_list:
            continue  # no-op for this row

        new_citations = dict(citations)
        new_citations["citations"] = new_list
        bind.execute(
            sa.text("UPDATE messages SET citations = CAST(:c AS JSONB) WHERE id = :id"),
            {"c": json.dumps(new_citations), "id": message_id},
        )


def downgrade() -> None:
    # Removing a promoted ``boxes`` field is not safe — we cannot tell which
    # citations had ``boxes`` originally vs. were promoted by upgrade(). Leave
    # the data as-is on downgrade; the schema is unchanged.
    pass
