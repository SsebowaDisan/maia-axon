"""seed general projects for existing users

Revision ID: 017_general_projects
Revises: 016_grant_users_companies
Create Date: 2026-04-30
"""

from __future__ import annotations

import uuid
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "017_general_projects"
down_revision: Union[str, None] = "016_grant_users_companies"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

DEFAULT_PROJECT_NAME = "General"

users = sa.table(
    "users",
    sa.column("id", UUID(as_uuid=True)),
)

projects = sa.table(
    "projects",
    sa.column("id", UUID(as_uuid=True)),
    sa.column("user_id", UUID(as_uuid=True)),
    sa.column("name", sa.String),
)


def upgrade() -> None:
    bind = op.get_bind()
    user_ids = bind.execute(sa.select(users.c.id)).scalars().all()
    if not user_ids:
        return

    existing_user_ids = set(
        bind.execute(
            sa.select(projects.c.user_id).where(projects.c.name == DEFAULT_PROJECT_NAME)
        ).scalars()
    )
    rows = [
        {"id": uuid.uuid4(), "user_id": user_id, "name": DEFAULT_PROJECT_NAME}
        for user_id in user_ids
        if user_id not in existing_user_ids
    ]
    if rows:
        bind.execute(projects.insert(), rows)


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(projects.delete().where(projects.c.name == DEFAULT_PROJECT_NAME))
