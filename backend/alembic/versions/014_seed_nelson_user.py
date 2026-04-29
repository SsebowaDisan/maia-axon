"""seed Nelson Maia user

Revision ID: 014_seed_nelson_user
Revises: 013_seed_coateq_company
Create Date: 2026-04-29
"""

from __future__ import annotations

import uuid
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from passlib.context import CryptContext
from sqlalchemy.dialects.postgresql import UUID

revision: str = "014_seed_nelson_user"
down_revision: Union[str, None] = "013_seed_coateq_company"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

NELSON_NAME = "Nelson"
NELSON_EMAIL = "nelson@maia.local"
NELSON_PASSWORD = "Nelson_coateq_leader"
NELSON_ROLE = "user"

pwd_context = CryptContext(schemes=["pbkdf2_sha256", "bcrypt"], deprecated="auto")

users = sa.table(
    "users",
    sa.column("id", UUID(as_uuid=True)),
    sa.column("email", sa.String),
    sa.column("name", sa.String),
    sa.column("hashed_password", sa.String),
    sa.column("role", sa.String),
)


def upgrade() -> None:
    bind = op.get_bind()
    hashed_password = pwd_context.hash(NELSON_PASSWORD)
    existing_id = bind.execute(
        sa.select(users.c.id).where(users.c.email == NELSON_EMAIL)
    ).scalar_one_or_none()

    if existing_id is None:
        bind.execute(
            users.insert().values(
                id=uuid.uuid4(),
                email=NELSON_EMAIL,
                name=NELSON_NAME,
                hashed_password=hashed_password,
                role=NELSON_ROLE,
            )
        )
        return

    bind.execute(
        users.update()
        .where(users.c.id == existing_id)
        .values(name=NELSON_NAME, hashed_password=hashed_password, role=NELSON_ROLE)
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(users.delete().where(users.c.email == NELSON_EMAIL))
