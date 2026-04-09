import re

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, require_admin
from app.core.database import get_db
from app.core.security import hash_password
from app.models.user import User
from app.schemas.user import AdminUserCreate, UserResponse, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])


def make_local_email(username: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", ".", username.strip().lower()).strip(".")
    if not normalized:
        raise HTTPException(status_code=400, detail="Username must include letters or numbers")
    return f"{normalized}@maia.local"


@router.get("/me", response_model=UserResponse)
async def get_me(user: User = Depends(get_current_user)):
    return user


@router.get("", response_model=list[UserResponse])
async def list_users(
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).order_by(User.created_at.desc()))
    return result.scalars().all()


@router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(
    body: AdminUserCreate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    username = body.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="Username is required")

    email = make_local_email(username)

    result = await db.execute(
        select(User).where(or_(User.name == username, User.email == email))
    )
    if result.scalar_one_or_none() is not None:
        raise HTTPException(status_code=400, detail="Username already exists")

    user = User(
        email=email,
        name=username,
        hashed_password=hash_password(body.password),
        role=body.role,
    )
    db.add(user)
    await db.flush()
    return user


@router.put("/me", response_model=UserResponse)
async def update_me(
    body: UserUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if body.name is not None:
        user.name = body.name
    if body.email is not None:
        user.email = body.email
    # Only admin can change roles — ignore role field for self-update
    await db.flush()
    return user
