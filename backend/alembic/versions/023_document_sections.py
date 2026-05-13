"""Section enrichment tables — the offline `book → topic → subtopic →
headline` tree, plus per-headline embeddings used by the learn-mode
path generator.

Each row in `document_sections` is one node in the hierarchy. Self-
referential FK via `parent_id`. Headlines (leaves) carry the full
enrichment JSON inside `content_json`; topics and subtopics carry
rolled-up summaries.

Embeddings live in a separate table (mirrors the chunks /
chunk_embeddings split) so the main row stays light and embedding
generation can run as a follow-up step after enrichment.

Revision ID: 023_document_sections
Revises: 022_doc_printed_page_offset
Create Date: 2026-05-12
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector

from app.core.config import settings

revision: str = "023_document_sections"
down_revision: Union[str, None] = "022_doc_printed_page_offset"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "document_sections",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
        ),
        sa.Column(
            "document_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("documents.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "parent_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("document_sections.id", ondelete="CASCADE"),
            nullable=True,
            index=True,
        ),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("page_start", sa.Integer(), nullable=False),
        sa.Column("page_end", sa.Integer(), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column(
            "content_json",
            sa.dialects.postgresql.JSONB(),
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
    # Hot-path lookup: "give me this document's tree in order".
    op.create_index(
        "ix_document_sections_doc_parent_ord",
        "document_sections",
        ["document_id", "parent_id", "ordinal"],
    )

    op.create_table(
        "document_section_embeddings",
        sa.Column(
            "section_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("document_sections.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "embedding",
            Vector(settings.embedding_dimensions),
            nullable=False,
        ),
    )
    # IVFFlat ANN index over the section summary embeddings — used
    # by the learn-mode path generator to map a user's goal text to
    # the most relevant headlines. Same pattern as chunk_embeddings.
    op.execute(
        "CREATE INDEX idx_document_section_embeddings_ivfflat "
        "ON document_section_embeddings "
        "USING ivfflat (embedding vector_cosine_ops) "
        "WITH (lists = 100)"
    )


def downgrade() -> None:
    op.drop_index(
        "idx_document_section_embeddings_ivfflat",
        table_name="document_section_embeddings",
    )
    op.drop_table("document_section_embeddings")
    op.drop_index(
        "ix_document_sections_doc_parent_ord",
        table_name="document_sections",
    )
    op.drop_table("document_sections")
