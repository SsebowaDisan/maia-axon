from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class CompanyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    ga4_property_id: str | None = Field(default=None, max_length=64)
    google_ads_customer_id: str | None = Field(default=None, max_length=64)
    google_ads_login_customer_id: str | None = Field(default=None, max_length=64)


class CompanyUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    ga4_property_id: str | None = Field(default=None, max_length=64)
    google_ads_customer_id: str | None = Field(default=None, max_length=64)
    google_ads_login_customer_id: str | None = Field(default=None, max_length=64)


class CompanyResponse(BaseModel):
    id: UUID
    name: str
    ga4_property_id: str | None
    google_ads_customer_id: str | None
    google_ads_login_customer_id: str | None
    created_by: UUID
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class CompanyUserAssign(BaseModel):
    user_id: UUID


class CompanyUserResponse(BaseModel):
    id: UUID
    company_id: UUID
    user_id: UUID
    assigned_by: UUID
    assigned_at: datetime

    model_config = {"from_attributes": True}
