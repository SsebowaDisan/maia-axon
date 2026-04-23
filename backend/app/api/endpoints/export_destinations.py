from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.config import settings
from app.core.database import get_db
from app.models.company import UserExportDestination
from app.models.user import User
from app.schemas.export_destination import (
    ExportDestinationCreate,
    ExportDestinationInfoResponse,
    ExportDestinationResponse,
    ExportWriteRequest,
    ExportWriteResponse,
)
from app.services.google_workspace import (
    append_report_to_google_doc,
    verify_google_destination,
    write_report_to_google_sheet,
)

router = APIRouter(prefix="/export-destinations", tags=["export-destinations"])


@router.get("/info", response_model=ExportDestinationInfoResponse)
async def export_destination_info(
    user: User = Depends(get_current_user),
):
    return ExportDestinationInfoResponse(
        service_account_email=settings.google_service_account_email,
    )


@router.get("", response_model=list[ExportDestinationResponse])
async def list_export_destinations(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(UserExportDestination)
        .where(UserExportDestination.user_id == user.id)
        .order_by(UserExportDestination.updated_at.desc(), UserExportDestination.created_at.desc())
    )
    return result.scalars().all()


@router.post("", response_model=ExportDestinationResponse, status_code=201)
async def create_export_destination(
    body: ExportDestinationCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    verified = verify_google_destination(body.url)
    if body.type != verified["type"]:
        raise HTTPException(status_code=400, detail="The link does not match the selected destination type")

    existing = await db.scalar(
        select(UserExportDestination).where(
            UserExportDestination.user_id == user.id,
            UserExportDestination.file_id == verified["file_id"],
            UserExportDestination.type == verified["type"],
        )
    )

    if existing is None:
        destination = UserExportDestination(
            user_id=user.id,
            company_id=body.company_id,
            type=verified["type"],
            title=(body.title or verified["title"]).strip(),
            url=body.url.strip(),
            file_id=verified["file_id"],
            status=verified["status"],
            last_verified_at=verified["last_verified_at"],
        )
        db.add(destination)
        await db.commit()
        await db.refresh(destination)
        return destination

    existing.company_id = body.company_id
    existing.title = (body.title or verified["title"]).strip()
    existing.url = body.url.strip()
    existing.status = verified["status"]
    existing.last_verified_at = verified["last_verified_at"]
    await db.commit()
    await db.refresh(existing)
    return existing


@router.delete("/{destination_id}", status_code=204)
async def delete_export_destination(
    destination_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    destination = await db.scalar(
        select(UserExportDestination).where(
            UserExportDestination.id == destination_id,
            UserExportDestination.user_id == user.id,
        )
    )
    if destination is None:
        raise HTTPException(status_code=404, detail="Export destination not found")

    await db.delete(destination)
    await db.commit()


@router.post("/write", response_model=ExportWriteResponse)
async def write_export_destination(
    body: ExportWriteRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    destination = await db.scalar(
        select(UserExportDestination).where(
            UserExportDestination.id == body.destination_id,
            UserExportDestination.user_id == user.id,
        )
    )
    if destination is None:
        raise HTTPException(status_code=404, detail="Export destination not found")

    try:
        if destination.type == "google_doc":
            append_report_to_google_doc(
                document_id=destination.file_id,
                title=body.title,
                content=body.content,
                visualizations=body.visualizations,
                company_name=body.company_name,
                search_mode=body.search_mode,
            )
        elif destination.type == "google_sheet":
            write_report_to_google_sheet(
                spreadsheet_id=destination.file_id,
                title=body.title,
                content=body.content,
                visualizations=body.visualizations,
                company_name=body.company_name,
                search_mode=body.search_mode,
            )
        else:
            raise HTTPException(status_code=400, detail="Unsupported export destination type")
    except ValueError as exc:
        destination.status = "failed"
        await db.commit()
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    destination.status = "verified"
    destination.last_verified_at = datetime.now(timezone.utc)
    await db.commit()

    return ExportWriteResponse(
        destination_id=destination.id,
        destination_type=destination.type,
        title=body.title,
        status="written",
        written_at=datetime.now(timezone.utc),
    )
