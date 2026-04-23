"""add companies and export destinations

Revision ID: 005_companies_exports
Revises: 004_projects_groups
Create Date: 2026-04-23
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "005_companies_exports"
down_revision: Union[str, None] = "004_projects_groups"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "companies",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("ga4_property_id", sa.String(length=64), nullable=True),
        sa.Column("google_ads_customer_id", sa.String(length=64), nullable=True),
        sa.Column("google_ads_login_customer_id", sa.String(length=64), nullable=True),
        sa.Column("created_by", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
    )
    op.create_index("ix_companies_name", "companies", ["name"], unique=True)

    op.create_table(
        "company_users",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "company_id",
            UUID(as_uuid=True),
            sa.ForeignKey("companies.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("assigned_by", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("assigned_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint(
            "company_id",
            "user_id",
            name="uq_company_users_company_id_user_id",
        ),
    )
    op.create_index("ix_company_users_company_id", "company_users", ["company_id"])
    op.create_index("ix_company_users_user_id", "company_users", ["user_id"])

    op.create_table(
        "user_export_destinations",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "company_id",
            UUID(as_uuid=True),
            sa.ForeignKey("companies.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("type", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("file_id", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="pending"),
        sa.Column("last_verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
    )
    op.create_index("ix_user_export_destinations_user_id", "user_export_destinations", ["user_id"])
    op.create_index(
        "ix_user_export_destinations_company_id", "user_export_destinations", ["company_id"]
    )
    op.create_index("ix_user_export_destinations_file_id", "user_export_destinations", ["file_id"])


def downgrade() -> None:
    op.drop_index("ix_user_export_destinations_file_id", table_name="user_export_destinations")
    op.drop_index("ix_user_export_destinations_company_id", table_name="user_export_destinations")
    op.drop_index("ix_user_export_destinations_user_id", table_name="user_export_destinations")
    op.drop_table("user_export_destinations")

    op.drop_index("ix_company_users_user_id", table_name="company_users")
    op.drop_index("ix_company_users_company_id", table_name="company_users")
    op.drop_table("company_users")

    op.drop_index("ix_companies_name", table_name="companies")
    op.drop_table("companies")
