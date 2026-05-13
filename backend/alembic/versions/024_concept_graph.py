"""Corpus-wide concept graph: concepts, their section links, edges
between them, and per-concept embeddings used for cross-book
deduplication / semantic search.

Three "edge"-shaped tables instead of one:
    * concept_introductions — sections that define a concept
    * concept_applications  — sections that use a concept without
                              re-defining it
    * concept_edges         — directed relationships between concepts
                              (prerequisite, builds_on, related,
                              contradicts), with strength 0..1.

Plus concept_embeddings keyed 1:1 against concepts, with an IVFFlat
index mirroring the pattern in chunks / document_sections.

Revision ID: 024_concept_graph
Revises: 023_document_sections
Create Date: 2026-05-12
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector

from app.core.config import settings

revision: str = "024_concept_graph"
down_revision: Union[str, None] = "023_document_sections"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- concepts: the canonical nodes -----------------------------------
    op.create_table(
        "concepts",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
        ),
        sa.Column("canonical_name", sa.Text(), nullable=False),
        # Lowercased + whitespace-collapsed form, used for the
        # uniqueness check. The display name preserves original casing.
        sa.Column("canonical_name_normalised", sa.Text(), nullable=False),
        sa.Column("canonical_definition", sa.Text(), nullable=False),
        sa.Column("aliases", sa.dialects.postgresql.JSONB(), nullable=True),
        sa.Column("difficulty_tier", sa.Integer(), nullable=True),
        sa.Column("domain_tags", sa.dialects.postgresql.JSONB(), nullable=True),
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
        sa.UniqueConstraint(
            "canonical_name_normalised",
            name="uq_concepts_canonical_norm",
        ),
    )

    # --- concept_embeddings: 1:1 with concept ----------------------------
    op.create_table(
        "concept_embeddings",
        sa.Column(
            "concept_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("concepts.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "embedding",
            Vector(settings.embedding_dimensions),
            nullable=False,
        ),
    )
    op.execute(
        "CREATE INDEX idx_concept_embeddings_ivfflat "
        "ON concept_embeddings "
        "USING ivfflat (embedding vector_cosine_ops) "
        "WITH (lists = 100)"
    )

    # --- concept_introductions: bridge concept → section -----------------
    op.create_table(
        "concept_introductions",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
        ),
        sa.Column(
            "concept_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("concepts.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "document_section_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("document_sections.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("local_definition", sa.Text(), nullable=True),
        sa.UniqueConstraint(
            "concept_id",
            "document_section_id",
            name="uq_concept_introductions",
        ),
    )

    # --- concept_applications: bridge concept → section ------------------
    op.create_table(
        "concept_applications",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
        ),
        sa.Column(
            "concept_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("concepts.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "document_section_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("document_sections.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.UniqueConstraint(
            "concept_id",
            "document_section_id",
            name="uq_concept_applications",
        ),
    )

    # --- concept_edges: prerequisite + softer relations ------------------
    op.create_table(
        "concept_edges",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
        ),
        sa.Column(
            "from_concept_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("concepts.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "to_concept_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("concepts.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("type", sa.String(20), nullable=False),
        sa.Column("strength", sa.Float(), nullable=False, server_default="1.0"),
        sa.Column(
            "source_section_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("document_sections.id", ondelete="CASCADE"),
            nullable=True,
            index=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "from_concept_id",
            "to_concept_id",
            "type",
            "source_section_id",
            name="uq_concept_edges_quad",
        ),
    )
    # The path generator's hot path: "give me prerequisites of X".
    op.create_index(
        "ix_concept_edges_to_type",
        "concept_edges",
        ["to_concept_id", "type"],
    )


def downgrade() -> None:
    op.drop_index("ix_concept_edges_to_type", table_name="concept_edges")
    op.drop_table("concept_edges")
    op.drop_table("concept_applications")
    op.drop_table("concept_introductions")
    op.drop_index(
        "idx_concept_embeddings_ivfflat",
        table_name="concept_embeddings",
    )
    op.drop_table("concept_embeddings")
    op.drop_table("concepts")
