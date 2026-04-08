"""Initial schema with all tables

Revision ID: 001
Revises:
Create Date: 2026-04-07
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Enable pgvector extension
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    # Users
    op.create_table(
        "users",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("email", sa.String(255), nullable=False, unique=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("hashed_password", sa.String(255), nullable=False),
        sa.Column("role", sa.String(20), nullable=False, server_default="user"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_users_email", "users", ["email"])

    # Groups
    op.create_table(
        "groups",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # Group assignments
    op.create_table(
        "group_assignments",
        sa.Column(
            "group_id",
            UUID(as_uuid=True),
            sa.ForeignKey("groups.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("assigned_by", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("assigned_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # Documents
    op.create_table(
        "documents",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "group_id",
            UUID(as_uuid=True),
            sa.ForeignKey("groups.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("filename", sa.String(500), nullable=False),
        sa.Column("file_url", sa.String(1000), nullable=False),
        sa.Column("file_size_bytes", sa.BigInteger, nullable=True),
        sa.Column("page_count", sa.Integer, nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="uploading"),
        sa.Column("error_detail", sa.Text, nullable=True),
        sa.Column("uploaded_by", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
    )
    op.create_index("ix_documents_group_id", "documents", ["group_id"])

    # Pages
    op.create_table(
        "pages",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "document_id",
            UUID(as_uuid=True),
            sa.ForeignKey("documents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("page_number", sa.Integer, nullable=False),
        sa.Column("image_url", sa.String(1000), nullable=False),
        sa.Column("markdown", sa.Text, nullable=True),
        sa.Column("ocr_text", sa.Text, nullable=True),
        sa.Column("ocr_confidence", sa.Float, nullable=True),
        sa.Column("regions", JSONB, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_pages_document_id", "pages", ["document_id"])

    # Chunks
    op.create_table(
        "chunks",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "document_id",
            UUID(as_uuid=True),
            sa.ForeignKey("documents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "page_id",
            UUID(as_uuid=True),
            sa.ForeignKey("pages.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("chunk_type", sa.String(20), nullable=False),
        sa.Column("content_text", sa.Text, nullable=False),
        sa.Column("latex", sa.Text, nullable=True),
        sa.Column("variables", JSONB, nullable=True),
        sa.Column("bbox_references", JSONB, nullable=True),
        sa.Column("metadata", JSONB, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_chunks_document_id", "chunks", ["document_id"])
    op.create_index("ix_chunks_page_id", "chunks", ["page_id"])

    # Chunk embeddings (pgvector)
    op.create_table(
        "chunk_embeddings",
        sa.Column(
            "chunk_id",
            UUID(as_uuid=True),
            sa.ForeignKey("chunks.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("embedding", Vector(1536), nullable=False),
    )
    op.execute(
        "CREATE INDEX idx_chunk_embeddings_ivfflat ON chunk_embeddings "
        "USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)"
    )

    # Conversations
    op.create_table(
        "conversations",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("group_id", UUID(as_uuid=True), sa.ForeignKey("groups.id"), nullable=False),
        sa.Column("title", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
    )
    op.create_index("ix_conversations_user_id", "conversations", ["user_id"])
    op.create_index("ix_conversations_group_id", "conversations", ["group_id"])

    # Messages
    op.create_table(
        "messages",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "conversation_id",
            UUID(as_uuid=True),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("content", sa.Text, nullable=False),
        sa.Column("citations", JSONB, nullable=True),
        sa.Column("mindmap", JSONB, nullable=True),
        sa.Column("search_mode", sa.String(20), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_messages_conversation_id", "messages", ["conversation_id"])


def downgrade() -> None:
    op.drop_table("messages")
    op.drop_table("conversations")
    op.drop_table("chunk_embeddings")
    op.drop_table("chunks")
    op.drop_table("pages")
    op.drop_table("documents")
    op.drop_table("group_assignments")
    op.drop_table("groups")
    op.drop_table("users")
    op.execute("DROP EXTENSION IF EXISTS vector")
