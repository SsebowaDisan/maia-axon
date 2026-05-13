"""Concept graph models.

A concept is a single named idea (e.g. "vector space", "Bernoulli's
equation") extracted from the section enrichment pass. The graph
spans the whole corpus — a concept introduced in one book is the
same node as the same concept introduced in another, after the
cross-book deduplication pass.

Tables
------
``concepts``
    Canonical concept nodes. Each concept has a name, definition,
    optional aliases, difficulty tier, and an embedding used for
    deduplication and semantic search.

``concept_section_links``
    Bridge table: which sections introduce vs. apply each concept.
    A concept can be introduced by multiple sections (across books)
    after deduplication, and applied by many more.

``concept_edges``
    Directed edges between concepts, with type and strength. The
    prerequisite trace used by the learn-mode path generator
    walks this graph.

Why a separate table per relation (introduce vs. apply) instead
of a single link table with a "kind" column?
    JSON-flat enrichment payloads already carry the distinction
    cleanly; keeping two named tables keeps queries readable (you
    write `JOIN concept_introductions` rather than `... WHERE
    kind = 'introduced'`) and lets us put per-relation indexes on
    the columns most queries actually filter by.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    Float,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.config import settings
from app.core.database import Base

# Valid relation types between a concept and a section.
CONCEPT_SECTION_RELATIONS = ("introduced", "applied")

# Valid edge types between concepts. ``prerequisite`` is the hard
# "you cannot understand B without A" edge that the path generator
# walks. ``builds_on`` is softer (B extends A but A isn't strictly
# required). ``related`` is the loosest — same area, useful context.
# ``contradicts`` lets us flag inconsistent definitions across books
# (e.g. one book treats "vector" as a column, another as a row).
CONCEPT_EDGE_TYPES = ("prerequisite", "builds_on", "related", "contradicts")


class Concept(Base):
    """One canonical concept node in the corpus-wide graph.

    Created lazily during the concept-graph build stage from
    `concepts_introduced` payloads on document_sections. The first
    book to introduce a concept "wins" the canonical name + definition;
    later books fold their variants into ``aliases`` once the
    cross-book deduplication pass clusters them.
    """

    __tablename__ = "concepts"
    __table_args__ = (
        # Canonical names are case-insensitive within the corpus.
        # The deduplication pass normalises (lowercased + stripped)
        # before insertion, so this unique constraint catches any
        # duplicate that slips through.
        UniqueConstraint("canonical_name_normalised", name="uq_concepts_canonical_norm"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    canonical_name: Mapped[str] = mapped_column(Text, nullable=False)
    # Lowercased + whitespace-collapsed for the uniqueness check. The
    # display name (``canonical_name``) preserves the original casing
    # from the first book that introduced it.
    canonical_name_normalised: Mapped[str] = mapped_column(Text, nullable=False)
    canonical_definition: Mapped[str] = mapped_column(Text, nullable=False)
    # Alternate names this concept goes by in other books. JSON list
    # of strings — kept here (not in a separate table) because we
    # never query individual aliases; we only render them in the
    # admin tools and read all of them at once during dedup.
    aliases: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # 1 introductory, 5 advanced research — same scale as headline
    # difficulty. Derived as the *minimum* difficulty across all
    # sections that introduce this concept.
    difficulty_tier: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Free-form tags (subject area, sub-domain) the admin can use
    # to filter the corpus. Populated by the LLM during dedup.
    domain_tags: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    # Relationships
    introductions = relationship(
        "ConceptIntroduction",
        back_populates="concept",
        cascade="all, delete-orphan",
    )
    applications = relationship(
        "ConceptApplication",
        back_populates="concept",
        cascade="all, delete-orphan",
    )
    embedding = relationship(
        "ConceptEmbedding",
        back_populates="concept",
        uselist=False,
        cascade="all, delete-orphan",
    )
    outgoing_edges = relationship(
        "ConceptEdge",
        foreign_keys="ConceptEdge.from_concept_id",
        back_populates="from_concept",
        cascade="all, delete-orphan",
    )
    incoming_edges = relationship(
        "ConceptEdge",
        foreign_keys="ConceptEdge.to_concept_id",
        back_populates="to_concept",
        cascade="all, delete-orphan",
    )


class ConceptEmbedding(Base):
    """Embedding of a concept's name + canonical definition.

    Used for two things: cross-book deduplication (cluster by
    similarity, then LLM-confirm merges) and semantic search when
    the path generator needs to match a free-form user goal that
    mentions a concept by alias.
    """

    __tablename__ = "concept_embeddings"

    concept_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("concepts.id", ondelete="CASCADE"),
        primary_key=True,
    )
    embedding = mapped_column(Vector(settings.embedding_dimensions), nullable=False)

    concept = relationship("Concept", back_populates="embedding")


# IVFFlat index for cross-book concept clustering / search.
Index(
    "idx_concept_embeddings_ivfflat",
    ConceptEmbedding.embedding,
    postgresql_using="ivfflat",
    postgresql_with={"lists": 100},
    postgresql_ops={"embedding": "vector_cosine_ops"},
)


class ConceptIntroduction(Base):
    """Bridge: this section is where this concept is first defined.

    A concept can have multiple introductions across the corpus —
    one per book that defines it (the deduplication pass merges
    them under one canonical Concept row, but the originating
    section links stay distinct so the system can offer the user
    alternate explanations from different books).
    """

    __tablename__ = "concept_introductions"
    __table_args__ = (
        UniqueConstraint(
            "concept_id", "document_section_id", name="uq_concept_introductions"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    concept_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("concepts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    document_section_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("document_sections.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Per-section override of the concept's definition. The enrichment
    # pass extracts a definition phrased the way *this* section
    # presents the concept; useful for surfacing alternate explanations.
    local_definition: Mapped[str | None] = mapped_column(Text, nullable=True)

    concept = relationship("Concept", back_populates="introductions")


class ConceptApplication(Base):
    """Bridge: this section uses this concept without re-defining it.

    Populated from headlines' ``concepts_assumed`` payload. The
    edge derivation step pairs each application with the concept's
    introduction(s) to create the prerequisite edges.
    """

    __tablename__ = "concept_applications"
    __table_args__ = (
        UniqueConstraint(
            "concept_id", "document_section_id", name="uq_concept_applications"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    concept_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("concepts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    document_section_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("document_sections.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    concept = relationship("Concept", back_populates="applications")


class ConceptEdge(Base):
    """Directed edge between two concepts.

    The most-used type is ``prerequisite``: the path generator walks
    these backward from a target concept until it hits something the
    user already knows. ``strength`` is 0..1 — 1.0 means strict
    prerequisite (the to-concept cannot be understood without the
    from-concept), lower values weaken the requirement.

    Edges are derived from section enrichment payloads:
      * Each ``concepts_assumed`` entry on a headline that introduces
        a concept becomes a ``prerequisite`` edge.
      * An optional second pass (LLM-driven) can add ``builds_on``,
        ``related``, and ``contradicts`` edges for richer relations.

    ``source_section_id`` is the section whose enrichment produced
    this edge — kept for traceability (admin can see which section's
    "concepts_assumed" caused this dependency) and so re-running
    enrichment for one section cleanly rebuilds only its edges.
    """

    __tablename__ = "concept_edges"
    __table_args__ = (
        # A single source section produces at most one edge of each
        # type between a given pair of concepts. Re-running enrichment
        # on a section therefore replaces, not duplicates, its edges.
        UniqueConstraint(
            "from_concept_id",
            "to_concept_id",
            "type",
            "source_section_id",
            name="uq_concept_edges_quad",
        ),
        # The path generator filters by (to_concept, type) most often:
        # "give me prerequisites of concept X". Index that path.
        Index(
            "ix_concept_edges_to_type",
            "to_concept_id",
            "type",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    from_concept_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("concepts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    to_concept_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("concepts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    type: Mapped[str] = mapped_column(String(20), nullable=False)
    # 0..1. Default 1.0 for direct prerequisite edges; the secondary
    # LLM pass can write fractional values when the dependency is
    # softer.
    strength: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    # The section whose enrichment payload produced this edge. Null
    # for edges added by the cross-book LLM pass (since they're not
    # tied to a single section).
    source_section_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("document_sections.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    from_concept = relationship(
        "Concept", foreign_keys=[from_concept_id], back_populates="outgoing_edges"
    )
    to_concept = relationship(
        "Concept", foreign_keys=[to_concept_id], back_populates="incoming_edges"
    )
