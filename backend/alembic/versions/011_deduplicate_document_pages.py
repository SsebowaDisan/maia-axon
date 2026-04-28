"""deduplicate document pages

Revision ID: 011_deduplicate_document_pages
Revises: 010_set_ads_login_customer_id
Create Date: 2026-04-28
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "011_deduplicate_document_pages"
down_revision: Union[str, None] = "010_set_ads_login_customer_id"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            """
            CREATE TEMP TABLE duplicate_pages_to_delete AS
            SELECT id
            FROM (
                SELECT
                    id,
                    row_number() OVER (
                        PARTITION BY document_id, page_number
                        ORDER BY
                            CASE WHEN markdown IS NOT NULL AND ocr_text IS NOT NULL AND regions IS NOT NULL THEN 1 ELSE 0 END DESC,
                            CASE WHEN jsonb_typeof(regions) = 'array' THEN jsonb_array_length(regions) ELSE 0 END DESC,
                            created_at DESC,
                            id DESC
                    ) AS row_number
                FROM pages
            ) ranked_pages
            WHERE row_number > 1
            """
        )
    )
    bind.execute(
        sa.text(
            """
            DELETE FROM chunk_embeddings
            WHERE chunk_id IN (
                SELECT chunks.id
                FROM chunks
                JOIN duplicate_pages_to_delete ON duplicate_pages_to_delete.id = chunks.page_id
            )
            """
        )
    )
    bind.execute(
        sa.text(
            """
            DELETE FROM chunks
            WHERE page_id IN (SELECT id FROM duplicate_pages_to_delete)
            """
        )
    )
    bind.execute(
        sa.text(
            """
            DELETE FROM pages
            WHERE id IN (SELECT id FROM duplicate_pages_to_delete)
            """
        )
    )
    bind.execute(sa.text("DROP TABLE duplicate_pages_to_delete"))
    op.create_unique_constraint(
        "uq_pages_document_page_number",
        "pages",
        ["document_id", "page_number"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_pages_document_page_number", "pages", type_="unique")
