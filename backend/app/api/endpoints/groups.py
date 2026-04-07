from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, require_admin
from app.core.database import get_db
from app.models.document import Document
from app.models.group import Group, GroupAssignment
from app.models.user import User
from app.schemas.group import (
    GroupAssignmentCreate,
    GroupAssignmentResponse,
    GroupCreate,
    GroupResponse,
    GroupUpdate,
)
from app.schemas.user import UserResponse

router = APIRouter(prefix="/groups", tags=["groups"])


async def _get_group_or_404(group_id: UUID, db: AsyncSession) -> Group:
    result = await db.execute(select(Group).where(Group.id == group_id))
    group = result.scalar_one_or_none()
    if group is None:
        raise HTTPException(status_code=404, detail="Group not found")
    return group


async def _check_group_access(group_id: UUID, user: User, db: AsyncSession) -> Group:
    group = await _get_group_or_404(group_id, db)
    if user.is_admin:
        return group
    result = await db.execute(
        select(GroupAssignment).where(
            GroupAssignment.group_id == group_id,
            GroupAssignment.user_id == user.id,
        )
    )
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=403, detail="No access to this group")
    return group


# --- # command: list groups for current user ---


@router.get("", response_model=list[GroupResponse])
async def list_groups(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Serves the # command: list groups the user has access to."""
    if user.is_admin:
        query = select(Group)
    else:
        query = (
            select(Group)
            .join(GroupAssignment, GroupAssignment.group_id == Group.id)
            .where(GroupAssignment.user_id == user.id)
        )

    result = await db.execute(query.order_by(Group.name))
    groups = result.scalars().all()

    # Fetch counts
    responses = []
    for group in groups:
        doc_count = await db.scalar(
            select(func.count()).select_from(Document).where(Document.group_id == group.id)
        )
        user_count = await db.scalar(
            select(func.count())
            .select_from(GroupAssignment)
            .where(GroupAssignment.group_id == group.id)
        )
        resp = GroupResponse.model_validate(group)
        resp.document_count = doc_count or 0
        resp.user_count = user_count or 0
        responses.append(resp)

    return responses


@router.post("", response_model=GroupResponse, status_code=status.HTTP_201_CREATED)
async def create_group(
    body: GroupCreate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    group = Group(name=body.name, description=body.description, created_by=admin.id)
    db.add(group)
    await db.flush()
    return GroupResponse.model_validate(group)


@router.get("/{group_id}", response_model=GroupResponse)
async def get_group(
    group_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    group = await _check_group_access(group_id, user, db)
    doc_count = await db.scalar(
        select(func.count()).select_from(Document).where(Document.group_id == group.id)
    )
    user_count = await db.scalar(
        select(func.count())
        .select_from(GroupAssignment)
        .where(GroupAssignment.group_id == group.id)
    )
    resp = GroupResponse.model_validate(group)
    resp.document_count = doc_count or 0
    resp.user_count = user_count or 0
    return resp


@router.put("/{group_id}", response_model=GroupResponse)
async def update_group(
    group_id: UUID,
    body: GroupUpdate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    group = await _get_group_or_404(group_id, db)
    if body.name is not None:
        group.name = body.name
    if body.description is not None:
        group.description = body.description
    await db.flush()
    return GroupResponse.model_validate(group)


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_group(
    group_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    group = await _get_group_or_404(group_id, db)
    await db.delete(group)


# --- User assignment ---


@router.post("/{group_id}/assign", response_model=GroupAssignmentResponse)
async def assign_user(
    group_id: UUID,
    body: GroupAssignmentCreate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    await _get_group_or_404(group_id, db)

    # Check user exists
    result = await db.execute(select(User).where(User.id == body.user_id))
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="User not found")

    # Check not already assigned
    result = await db.execute(
        select(GroupAssignment).where(
            GroupAssignment.group_id == group_id,
            GroupAssignment.user_id == body.user_id,
        )
    )
    if result.scalar_one_or_none() is not None:
        raise HTTPException(status_code=400, detail="User already assigned to group")

    assignment = GroupAssignment(
        group_id=group_id, user_id=body.user_id, assigned_by=admin.id
    )
    db.add(assignment)
    await db.flush()
    return GroupAssignmentResponse.model_validate(assignment)


@router.delete("/{group_id}/assign/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_user(
    group_id: UUID,
    user_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(GroupAssignment).where(
            GroupAssignment.group_id == group_id,
            GroupAssignment.user_id == user_id,
        )
    )
    assignment = result.scalar_one_or_none()
    if assignment is None:
        raise HTTPException(status_code=404, detail="Assignment not found")
    await db.delete(assignment)


@router.get("/{group_id}/users", response_model=list[UserResponse])
async def list_group_users(
    group_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    await _get_group_or_404(group_id, db)
    result = await db.execute(
        select(User)
        .join(GroupAssignment, GroupAssignment.user_id == User.id)
        .where(GroupAssignment.group_id == group_id)
    )
    return result.scalars().all()
