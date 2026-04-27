"""seed shared Maia users

Revision ID: 008_seed_shared_users
Revises: 007_feedback_tables
Create Date: 2026-04-27
"""

from __future__ import annotations

import uuid
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from passlib.context import CryptContext
from sqlalchemy.dialects.postgresql import UUID

revision: str = "008_seed_shared_users"
down_revision: Union[str, None] = "007_feedback_tables"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

pwd_context = CryptContext(schemes=["pbkdf2_sha256", "bcrypt"], deprecated="auto")

users = sa.table(
    "users",
    sa.column("id", UUID(as_uuid=True)),
    sa.column("email", sa.String),
    sa.column("name", sa.String),
    sa.column("hashed_password", sa.String),
    sa.column("role", sa.String),
)

SEEDED_USERS = [
    ("Ava", "ava@maia.local", "Ava_is_a_genius", "user"),
    ("Alireza", "alireza@maia.local", "Ali_the_great", "user"),
    ("Bart", "bart@maia.local", "Bart_the_great", "user"),
    ("Jan", "jan@maia.local", "Jan_the_engineer", "user"),
    ("Kevin", "kevin@maia.local", "Kevin_the_IT", "user"),
    ("Guillaume", "guillaume@maia.local", "Guillaume_the_marketer", "user"),
    ("Francis", "francis@maia.local", "1F2r3a4n5c6i7s", "user"),
    ("Admin", "admin@maia.local", "1A2d3m4i5n", "admin"),
]


def upgrade() -> None:
    bind = op.get_bind()
    for name, email, password, role in SEEDED_USERS:
        hashed_password = pwd_context.hash(password)
        existing_id = bind.execute(
            sa.select(users.c.id).where(users.c.email == email)
        ).scalar_one_or_none()

        if existing_id is None:
            bind.execute(
                users.insert().values(
                    id=uuid.uuid4(),
                    email=email,
                    name=name,
                    hashed_password=hashed_password,
                    role=role,
                )
            )
            continue

        bind.execute(
            users.update()
            .where(users.c.id == existing_id)
            .values(name=name, hashed_password=hashed_password, role=role)
        )


def downgrade() -> None:
    pass
