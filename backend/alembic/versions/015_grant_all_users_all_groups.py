"""grant every user access to every library group

Revision ID: 015_grant_all_users_all_groups
Revises: 014_seed_nelson_user
Create Date: 2026-04-30
"""

from __future__ import annotations

import uuid
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "015_grant_all_users_all_groups"
down_revision: Union[str, None] = "014_seed_nelson_user"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

users = sa.table(
    "users",
    sa.column("id", UUID(as_uuid=True)),
    sa.column("role", sa.String),
)

groups = sa.table(
    "groups",
    sa.column("id", UUID(as_uuid=True)),
)

group_assignments = sa.table(
    "group_assignments",
    sa.column("group_id", UUID(as_uuid=True)),
    sa.column("user_id", UUID(as_uuid=True)),
    sa.column("assigned_by", UUID(as_uuid=True)),
)


def upgrade() -> None:
    bind = op.get_bind()
    user_ids = bind.execute(sa.select(users.c.id)).scalars().all()
    group_ids = bind.execute(sa.select(groups.c.id)).scalars().all()
    if not user_ids or not group_ids:
        return

    assigned_by = bind.execute(
        sa.select(users.c.id).where(users.c.role == "admin").limit(1)
    ).scalar_one_or_none()
    if assigned_by is None:
        assigned_by = user_ids[0]

    existing = {
        (row.group_id, row.user_id)
        for row in bind.execute(
            sa.select(group_assignments.c.group_id, group_assignments.c.user_id)
        )
    }

    rows = [
        {"group_id": group_id, "user_id": user_id, "assigned_by": assigned_by}
        for group_id in group_ids
        for user_id in user_ids
        if (group_id, user_id) not in existing
    ]
    if rows:
        bind.execute(group_assignments.insert(), rows)


def downgrade() -> None:
    pass
