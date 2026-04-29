"""seed Coateq marketing company source

Revision ID: 013_seed_coateq_company
Revises: 012_promote_francis_to_admin
Create Date: 2026-04-29
"""

from __future__ import annotations

import uuid
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "013_seed_coateq_company"
down_revision: Union[str, None] = "012_promote_francis_to_admin"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COATEQ_NAME = "Coateq"
COATEQ_GA4_PROPERTY_ID = "479179141"
COATEQ_GOOGLE_ADS_CUSTOMER_ID = "9996186397"
GOOGLE_ADS_MANAGER_CUSTOMER_ID = "2837672399"

users = sa.table(
    "users",
    sa.column("id", UUID(as_uuid=True)),
    sa.column("email", sa.String),
    sa.column("name", sa.String),
    sa.column("hashed_password", sa.String),
    sa.column("role", sa.String),
)

companies = sa.table(
    "companies",
    sa.column("id", UUID(as_uuid=True)),
    sa.column("name", sa.String),
    sa.column("ga4_property_id", sa.String),
    sa.column("google_ads_customer_id", sa.String),
    sa.column("google_ads_login_customer_id", sa.String),
    sa.column("created_by", UUID(as_uuid=True)),
)


def upgrade() -> None:
    bind = op.get_bind()
    admin_id = bind.execute(
        sa.select(users.c.id).where(users.c.email == "admin@maia.local")
    ).scalar_one_or_none()

    if admin_id is None:
        admin_id = uuid.uuid4()
        bind.execute(
            users.insert().values(
                id=admin_id,
                email="admin@maia.local",
                name="Admin",
                hashed_password="pending-login-reset",
                role="admin",
            )
        )

    existing_id = bind.execute(
        sa.select(companies.c.id).where(companies.c.name == COATEQ_NAME)
    ).scalar_one_or_none()

    values = {
        "name": COATEQ_NAME,
        "ga4_property_id": COATEQ_GA4_PROPERTY_ID,
        "google_ads_customer_id": COATEQ_GOOGLE_ADS_CUSTOMER_ID,
        "google_ads_login_customer_id": GOOGLE_ADS_MANAGER_CUSTOMER_ID,
    }

    if existing_id is None:
        bind.execute(
            companies.insert().values(
                id=uuid.uuid4(),
                created_by=admin_id,
                **values,
            )
        )
        return

    bind.execute(
        companies.update()
        .where(companies.c.id == existing_id)
        .values(**values)
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        companies.delete().where(
            companies.c.name == COATEQ_NAME,
            companies.c.ga4_property_id == COATEQ_GA4_PROPERTY_ID,
            companies.c.google_ads_customer_id == COATEQ_GOOGLE_ADS_CUSTOMER_ID,
        )
    )
