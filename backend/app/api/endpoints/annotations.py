"""Annotations API.

Highlight + comment storage with per-annotation visibility (``private``
vs ``group_shared``). The owning user always sees their own; other group
members see only ``group_shared`` ones. ``group_shared`` annotations are
also indexed by the retrieval layer so future Maia answers can quote
teammate insights — see ``app.services.retrieval`` for the wire-up.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.annotation import Annotation
from app.models.document import Document, Page
from app.models.user import User
from app.schemas.annotation import (
    AnnotationCreate,
    AnnotationResponse,
    AnnotationUpdate,
)

router = APIRouter(prefix="/annotations", tags=["annotations"])


async def _load_document_or_404(db: AsyncSession, document_id: UUID) -> Document:
    doc = await db.scalar(select(Document).where(Document.id == document_id))
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return doc


async def _resolve_page_id(db: AsyncSession, *, document_id: UUID, page_number: int) -> UUID:
    page_id = await db.scalar(
        select(Page.id).where(
            Page.document_id == document_id,
            Page.page_number == page_number,
        )
    )
    if page_id is None:
        raise HTTPException(status_code=404, detail=f"Page {page_number} not found")
    return page_id


def _annotation_to_response(annotation: Annotation, user: User | None) -> AnnotationResponse:
    boxes = annotation.bbox or []
    return AnnotationResponse(
        id=annotation.id,
        document_id=annotation.document_id,
        page_number=annotation.page_number,
        color=annotation.color,
        highlighted_text=annotation.highlighted_text,
        comment=annotation.comment,
        visibility=annotation.visibility,
        char_start=annotation.char_start,
        char_end=annotation.char_end,
        boxes=[list(box) for box in boxes],
        user_id=annotation.user_id,
        user_name=user.name if user else None,
        created_at=annotation.created_at,
        updated_at=annotation.updated_at,
    )


@router.post("", response_model=AnnotationResponse)
async def create_annotation(
    body: AnnotationCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    doc = await _load_document_or_404(db, body.document_id)
    page_id = await _resolve_page_id(
        db, document_id=doc.id, page_number=body.page_number
    )

    annotation = Annotation(
        user_id=user.id,
        group_id=doc.group_id,
        document_id=doc.id,
        page_id=page_id,
        page_number=body.page_number,
        color=body.color,
        highlighted_text=body.highlighted_text.strip(),
        comment=body.comment.strip() if body.comment else None,
        visibility=body.visibility,
        char_start=body.char_start,
        char_end=body.char_end,
        bbox=[list(box) for box in body.boxes] if body.boxes else None,
    )
    db.add(annotation)
    await db.flush()
    await db.refresh(annotation)
    return _annotation_to_response(annotation, user)


@router.get("", response_model=list[AnnotationResponse])
async def list_annotations(
    document_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return annotations the caller is allowed to see on this document.

    The caller always sees their own annotations regardless of
    visibility, plus any ``group_shared`` annotations from teammates in
    the document's group.
    """
    doc = await _load_document_or_404(db, document_id)

    rows = await db.execute(
        select(Annotation, User)
        .join(User, User.id == Annotation.user_id)
        .where(
            Annotation.document_id == doc.id,
            or_(
                Annotation.user_id == user.id,
                Annotation.visibility == "group_shared",
            ),
        )
        .order_by(Annotation.page_number.asc(), Annotation.created_at.asc())
    )
    return [_annotation_to_response(annotation, author) for annotation, author in rows.all()]


@router.patch("/{annotation_id}", response_model=AnnotationResponse)
async def update_annotation(
    annotation_id: UUID,
    body: AnnotationUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    annotation = await db.scalar(
        select(Annotation).where(Annotation.id == annotation_id)
    )
    if annotation is None:
        raise HTTPException(status_code=404, detail="Annotation not found")
    if annotation.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not your annotation")

    if body.color is not None:
        annotation.color = body.color
    if body.comment is not None:
        annotation.comment = body.comment.strip() or None
    if body.visibility is not None:
        annotation.visibility = body.visibility

    db.add(annotation)
    await db.flush()
    await db.refresh(annotation)
    return _annotation_to_response(annotation, user)


@router.delete("/{annotation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_annotation(
    annotation_id: UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    annotation = await db.scalar(
        select(Annotation).where(Annotation.id == annotation_id)
    )
    if annotation is None:
        raise HTTPException(status_code=404, detail="Annotation not found")
    if annotation.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not your annotation")

    await db.delete(annotation)
    await db.flush()
