"""Add thematic chapter groups to documents.

The mindmap and learn-mode UI need a level above raw chapters so
books with many top-level sections (the German fans book has 17)
don't dump everything onto the user at once. A single ``chapter_groups_json``
JSONB column on ``documents`` carries an array of clusters, each
with a name, rationale, and list of top-level section UUIDs that
belong to it. Generated offline by an LLM clustering pass; mutated
in place by the admin review UI.

Schema of the JSONB value (validated by the section-mapping pass):

    [
      {
        "name": "Operating modes",
        "rationale": "Chapters covering ...",
        "section_ids": ["uuid", "uuid", ...]
      },
      ...
    ]

Revision ID: 028_chapter_groups
Revises: 027_learning_paths
Create Date: 2026-05-13
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "028_chapter_groups"
down_revision: Union[str, None] = "027_learning_paths"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "documents",
        sa.Column(
            "chapter_groups_json",
            sa.dialects.postgresql.JSONB(),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("documents", "chapter_groups_json")
