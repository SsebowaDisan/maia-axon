from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_admin
from app.core.database import get_db
from app.models.company import Company, CompanyUser
from app.models.user import User
from app.schemas.company import (
    CompanyCreate,
    CompanyResponse,
    CompanyUpdate,
    CompanyUserAssign,
    CompanyUserResponse,
)
from app.schemas.user import UserResponse

router = APIRouter(prefix="/companies", tags=["companies"])


async def _get_company_or_404(company_id: UUID, db: AsyncSession) -> Company:
    company = await db.scalar(select(Company).where(Company.id == company_id))
    if company is None:
        raise HTTPException(status_code=404, detail="Company not found")
    return company


@router.get("", response_model=list[CompanyResponse])
async def list_companies(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    query = select(Company)
    result = await db.execute(query.order_by(Company.name))
    return result.scalars().all()


@router.post("", response_model=CompanyResponse, status_code=status.HTTP_201_CREATED)
async def create_company(
    body: CompanyCreate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    existing = await db.scalar(select(Company).where(Company.name == body.name.strip()))
    if existing is not None:
        raise HTTPException(status_code=400, detail="Company already exists")

    company = Company(
        name=body.name.strip(),
        ga4_property_id=(body.ga4_property_id or "").strip() or None,
        google_ads_customer_id=(body.google_ads_customer_id or "").strip() or None,
        google_ads_login_customer_id=(body.google_ads_login_customer_id or "").strip() or None,
        created_by=admin.id,
    )
    db.add(company)
    await db.flush()
    return CompanyResponse.model_validate(company)


@router.put("/{company_id}", response_model=CompanyResponse)
async def update_company(
    company_id: UUID,
    body: CompanyUpdate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    company = await _get_company_or_404(company_id, db)

    if body.name is not None:
        normalized_name = body.name.strip()
        existing = await db.scalar(
            select(Company).where(Company.name == normalized_name, Company.id != company_id)
        )
        if existing is not None:
            raise HTTPException(status_code=400, detail="Company already exists")
        company.name = normalized_name

    if body.ga4_property_id is not None:
        company.ga4_property_id = body.ga4_property_id.strip() or None
    if body.google_ads_customer_id is not None:
        company.google_ads_customer_id = body.google_ads_customer_id.strip() or None
    if body.google_ads_login_customer_id is not None:
        company.google_ads_login_customer_id = body.google_ads_login_customer_id.strip() or None

    await db.flush()
    return CompanyResponse.model_validate(company)


@router.delete("/{company_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_company(
    company_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    company = await _get_company_or_404(company_id, db)
    await db.delete(company)


@router.post("/{company_id}/users", response_model=CompanyUserResponse, status_code=status.HTTP_201_CREATED)
async def assign_company_user(
    company_id: UUID,
    body: CompanyUserAssign,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    await _get_company_or_404(company_id, db)

    user = await db.scalar(select(User).where(User.id == body.user_id))
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    existing = await db.scalar(
        select(CompanyUser).where(
            CompanyUser.company_id == company_id,
            CompanyUser.user_id == body.user_id,
        )
    )
    if existing is not None:
        raise HTTPException(status_code=400, detail="User already assigned to company")

    assignment = CompanyUser(
        company_id=company_id,
        user_id=body.user_id,
        assigned_by=admin.id,
    )
    db.add(assignment)
    await db.flush()
    return CompanyUserResponse.model_validate(assignment)


@router.get("/{company_id}/users", response_model=list[UserResponse])
async def list_company_users(
    company_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    await _get_company_or_404(company_id, db)
    result = await db.execute(
        select(User)
        .join(CompanyUser, CompanyUser.user_id == User.id)
        .where(CompanyUser.company_id == company_id)
        .order_by(User.name)
    )
    return result.scalars().all()


@router.delete("/{company_id}/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_company_user(
    company_id: UUID,
    user_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    assignment = await db.scalar(
        select(CompanyUser).where(
            CompanyUser.company_id == company_id,
            CompanyUser.user_id == user_id,
        )
    )
    if assignment is None:
        raise HTTPException(status_code=404, detail="Assignment not found")
    await db.delete(assignment)
