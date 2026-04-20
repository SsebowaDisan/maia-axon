from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.conversation import Conversation
from app.models.project import Project
from app.models.user import User
from app.schemas.project import ProjectCreate, ProjectResponse, ProjectUpdate

router = APIRouter(prefix="/projects", tags=["projects"])


async def _get_project_or_404(project_id: UUID, user: User, db: AsyncSession) -> Project:
    result = await db.execute(
        select(Project).where(Project.id == project_id, Project.user_id == user.id)
    )
    project = result.scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.get("", response_model=list[ProjectResponse])
async def list_projects(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(
            Project,
            func.count(Conversation.id).label("conversation_count"),
        )
        .outerjoin(Conversation, Conversation.project_id == Project.id)
        .where(Project.user_id == user.id)
        .group_by(Project.id)
        .order_by(Project.updated_at.desc(), Project.created_at.desc())
    )

    responses: list[ProjectResponse] = []
    for project, conversation_count in result.all():
        payload = ProjectResponse.model_validate(project)
        payload.conversation_count = conversation_count or 0
        responses.append(payload)
    return responses


@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: ProjectCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = Project(user_id=user.id, name=body.name.strip())
    db.add(project)
    await db.flush()
    return ProjectResponse.model_validate(project)


@router.put("/{project_id}", response_model=ProjectResponse)
async def update_project(
    project_id: UUID,
    body: ProjectUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await _get_project_or_404(project_id, user, db)
    if body.name is not None:
        project.name = body.name.strip()
    await db.flush()
    return ProjectResponse.model_validate(project)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await _get_project_or_404(project_id, user, db)
    await db.execute(
        update(Conversation)
        .where(Conversation.project_id == project.id)
        .values(project_id=None)
    )
    await db.delete(project)
