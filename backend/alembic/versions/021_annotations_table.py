"""create annotations table for personal + shared notes on PDF pages

Each annotation anchors a highlight (and optional comment) to a specific
character range inside a chunk's content_text. The owning user can keep
it private (default) or share it with their group, in which case the
retrieval layer treats it as an additional source chunk so future Maia
answers can quote teammate insights alongside the books themselves.

Visibility model:
- ``private`` (default): only the creator sees it.
- ``group_shared``: visible to everyone with access to the document's
  group, and indexed for retrieval.

Anchor model:
- ``chunk_id`` + ``char_start`` / ``char_end`` are character offsets
  into the chunk's content_text (with the same convention as the
  sentence anchors stored on chunks). This is robust across re-renders
  because we work in source-text coordinates, not pixel coordinates.
- ``bbox`` is a denormalised cache of the rectangle to render in the
  PDF viewer; recomputed by the backend at create time from the chunk's
  per-line bboxes so the frontend can paint the highlight without
  having to look chunks up.

Revision ID: 021_annotations_table
Revises: 020_msg_suggested_questions
Create Date: 2026-05-05
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "021_annotations_table"
down_revision: Union[str, None] = "020_msg_suggested_questions"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "annotations",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="CASCADE"),
                  nullable=False, index=True),
        sa.Column("group_id", UUID(as_uuid=True),
                  sa.ForeignKey("groups.id", ondelete="CASCADE"),
                  nullable=False, index=True),
        sa.Column("document_id", UUID(as_uuid=True),
                  sa.ForeignKey("documents.id", ondelete="CASCADE"),
                  nullable=False, index=True),
        sa.Column("page_id", UUID(as_uuid=True),
                  sa.ForeignKey("pages.id", ondelete="CASCADE"),
                  nullable=False, index=True),
        sa.Column("chunk_id", UUID(as_uuid=True),
                  sa.ForeignKey("chunks.id", ondelete="CASCADE"),
                  nullable=True, index=True),
        sa.Column("page_number", sa.Integer(), nullable=False),
        sa.Column("color", sa.String(length=20), nullable=False,
                  server_default=sa.text("'yellow'")),
        sa.Column("highlighted_text", sa.Text(), nullable=False,
                  server_default=sa.text("''")),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column("visibility", sa.String(length=20), nullable=False,
                  server_default=sa.text("'private'")),
        sa.Column("char_start", sa.Integer(), nullable=True),
        sa.Column("char_end", sa.Integer(), nullable=True),
        sa.Column("bbox", JSONB, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.func.now(),
                  onupdate=sa.func.now(), nullable=False),
    )

    # Hot-path indexes: list-by-document, list-by-group-shared (for
    # retrieval), list-by-user.
    op.create_index(
        "ix_annotations_document_visibility",
        "annotations",
        ["document_id", "visibility"],
    )
    op.create_index(
        "ix_annotations_group_visibility",
        "annotations",
        ["group_id", "visibility"],
    )


def downgrade() -> None:
    op.drop_index("ix_annotations_group_visibility", table_name="annotations")
    op.drop_index("ix_annotations_document_visibility", table_name="annotations")
    op.drop_table("annotations")
