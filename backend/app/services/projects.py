from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import Project
from app.models.user import User

DEFAULT_PROJECT_NAME = "General"


async def ensure_default_project(db: AsyncSession, user: User) -> Project:
    project = await db.scalar(
        select(Project).where(Project.user_id == user.id, Project.name == DEFAULT_PROJECT_NAME)
    )
    if project is not None:
        return project

    project = Project(user_id=user.id, name=DEFAULT_PROJECT_NAME)
    db.add(project)
    await db.flush()
    return project
