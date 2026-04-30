"""grant every user access to every marketing company

Revision ID: 016_grant_all_users_all_companies
Revises: 015_grant_all_users_all_groups
Create Date: 2026-04-30
"""

from __future__ import annotations

import uuid
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "016_grant_all_users_all_companies"
down_revision: Union[str, None] = "015_grant_all_users_all_groups"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

users = sa.table(
    "users",
    sa.column("id", UUID(as_uuid=True)),
    sa.column("role", sa.String),
)

companies = sa.table(
    "companies",
    sa.column("id", UUID(as_uuid=True)),
)

company_users = sa.table(
    "company_users",
    sa.column("id", UUID(as_uuid=True)),
    sa.column("company_id", UUID(as_uuid=True)),
    sa.column("user_id", UUID(as_uuid=True)),
    sa.column("assigned_by", UUID(as_uuid=True)),
)


def upgrade() -> None:
    bind = op.get_bind()
    user_ids = bind.execute(sa.select(users.c.id)).scalars().all()
    company_ids = bind.execute(sa.select(companies.c.id)).scalars().all()
    if not user_ids or not company_ids:
        return

    assigned_by = bind.execute(
        sa.select(users.c.id).where(users.c.role == "admin").limit(1)
    ).scalar_one_or_none()
    if assigned_by is None:
        assigned_by = user_ids[0]

    existing = {
        (row.company_id, row.user_id)
        for row in bind.execute(sa.select(company_users.c.company_id, company_users.c.user_id))
    }

    rows = [
        {
            "id": uuid.uuid4(),
            "company_id": company_id,
            "user_id": user_id,
            "assigned_by": assigned_by,
        }
        for company_id in company_ids
        for user_id in user_ids
        if (company_id, user_id) not in existing
    ]
    if rows:
        bind.execute(company_users.insert(), rows)


def downgrade() -> None:
    pass
