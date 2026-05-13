from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

AnnotationVisibility = Literal["private", "group_shared"]
AnnotationColor = Literal["yellow", "green", "blue", "pink", "orange"]


# Each box: [x1, y1, x2, y2] in the PDF page's native coordinate space
# (origin top-left, units = PDF points). A multi-line selection produces
# one box per visual line so the frontend can paint each line strip
# without merging across line breaks.
Bbox4 = tuple[float, float, float, float]


class AnnotationCreate(BaseModel):
    document_id: UUID
    page_number: int = Field(ge=1)
    highlighted_text: str = Field(min_length=1, max_length=8000)
    color: AnnotationColor = "yellow"
    comment: str | None = Field(default=None, max_length=4000)
    visibility: AnnotationVisibility = "private"
    char_start: int | None = Field(default=None, ge=0)
    char_end: int | None = Field(default=None, ge=0)
    # The frontend emits one box per character-cluster rect that
    # ``range.getClientRects()`` produces — empirically anywhere from
    # one (a single word) up to several hundred (a multi-paragraph
    # justified selection). The previous 64 cap was hit constantly,
    # the backend returned 422, and the frontend store silently
    # swallowed the error leaving the user with a stuck popover and
    # no saved highlight. 4096 keeps the row-size predictable while
    # comfortably covering even page-spanning highlights.
    boxes: list[Bbox4] = Field(default_factory=list, max_length=4096)


class AnnotationUpdate(BaseModel):
    color: AnnotationColor | None = None
    comment: str | None = Field(default=None, max_length=4000)
    visibility: AnnotationVisibility | None = None


class AnnotationResponse(BaseModel):
    id: UUID
    document_id: UUID
    page_number: int
    color: str
    highlighted_text: str
    comment: str | None
    visibility: str
    char_start: int | None
    char_end: int | None
    boxes: list[list[float]]
    user_id: UUID
    user_name: str | None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
