"""seed marketing company sources

Revision ID: 009_seed_marketing_companies
Revises: 008_seed_shared_users
Create Date: 2026-04-27
"""

from __future__ import annotations

import uuid
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "009_seed_marketing_companies"
down_revision: Union[str, None] = "008_seed_shared_users"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

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

MARKETING_COMPANIES = [
    {
        "name": "DimpleSteel",
        "aliases": ["DimpleSteel"],
        "ga4_property_id": "471953540",
        "google_ads_customer_id": "1874468870",
    },
    {
        "name": "NC.Noviso.eu",
        "aliases": ["NC.Noviso.eu", "Noviso"],
        "ga4_property_id": "490546315",
        "google_ads_customer_id": "8726060498",
    },
    {
        "name": "Proceq.eu",
        "aliases": ["Proceq.eu", "Proceq"],
        "ga4_property_id": "503598422",
        "google_ads_customer_id": "6655378313",
    },
]


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

    for item in MARKETING_COMPANIES:
        existing_id = bind.execute(
            sa.select(companies.c.id).where(companies.c.name == item["name"])
        ).scalar_one_or_none()
        if existing_id is None:
            existing_id = bind.execute(
                sa.select(companies.c.id)
                .where(companies.c.name.in_(item["aliases"][1:]))
                .limit(1)
            ).scalar_one_or_none()

        values = {
            "name": item["name"],
            "ga4_property_id": item["ga4_property_id"],
            "google_ads_customer_id": item["google_ads_customer_id"],
        }

        if existing_id is None:
            bind.execute(
                companies.insert().values(
                    id=uuid.uuid4(),
                    created_by=admin_id,
                    google_ads_login_customer_id=None,
                    **values,
                )
            )
            continue

        bind.execute(
            companies.update()
            .where(companies.c.id == existing_id)
            .values(**values)
        )


def downgrade() -> None:
    pass
