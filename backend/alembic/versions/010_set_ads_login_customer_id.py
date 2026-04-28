"""set Google Ads manager login customer

Revision ID: 010_set_ads_login_customer_id
Revises: 009_seed_marketing_companies
Create Date: 2026-04-28
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "010_set_ads_login_customer_id"
down_revision: Union[str, None] = "009_seed_marketing_companies"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

MANAGER_CUSTOMER_ID = "2837672399"
ADS_CUSTOMER_IDS = ["1874468870", "8726060498", "6655378313"]


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            """
            UPDATE companies
            SET google_ads_login_customer_id = :manager_customer_id
            WHERE regexp_replace(coalesce(google_ads_customer_id, ''), '[^0-9]', '', 'g')
              = ANY(:customer_ids)
            """
        ),
        {
            "manager_customer_id": MANAGER_CUSTOMER_ID,
            "customer_ids": ADS_CUSTOMER_IDS,
        },
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            """
            UPDATE companies
            SET google_ads_login_customer_id = NULL
            WHERE google_ads_login_customer_id = :manager_customer_id
              AND regexp_replace(coalesce(google_ads_customer_id, ''), '[^0-9]', '', 'g')
                = ANY(:customer_ids)
            """
        ),
        {
            "manager_customer_id": MANAGER_CUSTOMER_ID,
            "customer_ids": ADS_CUSTOMER_IDS,
        },
    )
