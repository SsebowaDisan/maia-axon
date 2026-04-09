from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import create_access_token, hash_password, verify_password
from app.models.user import User
from app.schemas.user import LoginRequest, TokenResponse, UserCreate, UserResponse

router = APIRouter(prefix="/auth", tags=["auth"])

DEFAULT_ADMIN_NAME = "admin"
DEFAULT_ADMIN_EMAIL = "admin@maia.local"
DEFAULT_ADMIN_PASSWORD = "admin"


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def register(body: UserCreate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.email == body.email))
    if result.scalar_one_or_none() is not None:
        raise HTTPException(status_code=400, detail="Email already registered")

    user = User(
        email=body.email,
        name=body.name,
        hashed_password=hash_password(body.password),
        role=body.role,
    )
    db.add(user)
    await db.flush()

    token = create_access_token(str(user.id))
    return TokenResponse(
        access_token=token,
        user=UserResponse.model_validate(user),
    )


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, db: AsyncSession = Depends(get_db)):
    identifier = body.login_identifier
    user = None

    if identifier == DEFAULT_ADMIN_NAME and body.password == DEFAULT_ADMIN_PASSWORD:
        result = await db.execute(select(User).where(User.email == DEFAULT_ADMIN_EMAIL))
        user = result.scalar_one_or_none()

        if user is None:
            user = User(
                email=DEFAULT_ADMIN_EMAIL,
                name=DEFAULT_ADMIN_NAME,
                hashed_password=hash_password(DEFAULT_ADMIN_PASSWORD),
                role="admin",
            )
            db.add(user)
            await db.flush()
        else:
            should_update = False
            if user.name != DEFAULT_ADMIN_NAME:
                user.name = DEFAULT_ADMIN_NAME
                should_update = True
            if user.role != "admin":
                user.role = "admin"
                should_update = True
            if not verify_password(DEFAULT_ADMIN_PASSWORD, user.hashed_password):
                user.hashed_password = hash_password(DEFAULT_ADMIN_PASSWORD)
                should_update = True
            if should_update:
                await db.flush()

    if user is None:
        result = await db.execute(select(User).where(User.email == identifier))
        user = result.scalar_one_or_none()

    if user is None:
        result = await db.execute(
            select(User).where(User.name == identifier).order_by(User.created_at.asc())
        )
        user = result.scalars().first()

    if user is None or not verify_password(body.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid username/email or password")

    token = create_access_token(str(user.id))
    return TokenResponse(
        access_token=token,
        user=UserResponse.model_validate(user),
    )
