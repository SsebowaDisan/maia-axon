"""add projects and decouple conversations from groups

Revision ID: 004_projects_groups
Revises: 003_add_document_progress_fields
Create Date: 2026-04-20
"""

from __future__ import annotations

import uuid
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "004_projects_groups"
down_revision: Union[str, None] = "003_add_document_progress_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _find_fk_name(table_name: str, constrained_column: str) -> str | None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for fk in inspector.get_foreign_keys(table_name):
        if fk.get("constrained_columns") == [constrained_column]:
            return fk.get("name")
    return None


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
    )
    op.create_index("ix_projects_user_id", "projects", ["user_id"])

    op.add_column("conversations", sa.Column("project_id", UUID(as_uuid=True), nullable=True))
    op.create_index("ix_conversations_project_id", "conversations", ["project_id"])

    bind = op.get_bind()

    rows = bind.execute(
        sa.text(
            """
            SELECT DISTINCT c.user_id, c.group_id, g.name
            FROM conversations c
            JOIN groups g ON g.id = c.group_id
            WHERE c.group_id IS NOT NULL
            """
        )
    ).fetchall()

    for row in rows:
        project_id = uuid.uuid4()
        bind.execute(
            sa.text(
                """
                INSERT INTO projects (id, user_id, name)
                VALUES (:id, :user_id, :name)
                """
            ),
            {"id": project_id, "user_id": row.user_id, "name": row.name},
        )
        bind.execute(
            sa.text(
                """
                UPDATE conversations
                SET project_id = :project_id
                WHERE user_id = :user_id AND group_id = :group_id AND project_id IS NULL
                """
            ),
            {
                "project_id": project_id,
                "user_id": row.user_id,
                "group_id": row.group_id,
            },
        )

    op.create_foreign_key(
        "fk_conversations_project_id_projects",
        "conversations",
        "projects",
        ["project_id"],
        ["id"],
        ondelete="SET NULL",
    )

    fk_name = _find_fk_name("conversations", "group_id")
    if fk_name:
        op.drop_constraint(fk_name, "conversations", type_="foreignkey")
    op.alter_column("conversations", "group_id", existing_type=UUID(as_uuid=True), nullable=True)
    op.create_foreign_key(
        "fk_conversations_group_id_groups",
        "conversations",
        "groups",
        ["group_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    fk_name = _find_fk_name("conversations", "project_id")
    if fk_name:
        op.drop_constraint(fk_name, "conversations", type_="foreignkey")

    group_fk_name = _find_fk_name("conversations", "group_id")
    if group_fk_name:
        op.drop_constraint(group_fk_name, "conversations", type_="foreignkey")

    bind = op.get_bind()
    bind.execute(sa.text("UPDATE conversations SET project_id = NULL"))

    op.alter_column("conversations", "group_id", existing_type=UUID(as_uuid=True), nullable=False)
    op.create_foreign_key(
        "fk_conversations_group_id_groups",
        "conversations",
        "groups",
        ["group_id"],
        ["id"],
    )

    op.drop_index("ix_conversations_project_id", table_name="conversations")
    op.drop_column("conversations", "project_id")
    op.drop_index("ix_projects_user_id", table_name="projects")
    op.drop_table("projects")
