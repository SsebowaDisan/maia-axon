from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, EmailStr, model_validator


class UserCreate(BaseModel):
    email: EmailStr
    name: str
    password: str
    role: str = "user"


class AdminUserCreate(BaseModel):
    username: str
    password: str
    role: str = "user"


class UserUpdate(BaseModel):
    name: str | None = None
    email: EmailStr | None = None
    role: str | None = None


class UserResponse(BaseModel):
    id: UUID
    email: str
    name: str
    role: str
    created_at: datetime

    model_config = {"from_attributes": True}


class LoginRequest(BaseModel):
    identifier: str | None = None
    email: str | None = None
    password: str

    @model_validator(mode="after")
    def validate_identifier(self):
        if self.identifier or self.email:
            return self
        raise ValueError("Either identifier or email is required")

    @property
    def login_identifier(self) -> str:
        return (self.identifier or self.email or "").strip()


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse
