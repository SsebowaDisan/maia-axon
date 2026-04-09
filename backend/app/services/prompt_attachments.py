import base64
import json
import tempfile
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4
from xml.etree import ElementTree

import fitz
from fastapi import HTTPException, UploadFile

ATTACHMENT_DIR = Path(tempfile.gettempdir()) / "maia_axon_prompt_attachments"
ATTACHMENT_DIR.mkdir(parents=True, exist_ok=True)

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
TEXT_EXTENSIONS = {".txt", ".md"}
PDF_EXTENSIONS = {".pdf"}
WORD_EXTENSIONS = {".docx"}
SUPPORTED_EXTENSIONS = IMAGE_EXTENSIONS | TEXT_EXTENSIONS | PDF_EXTENSIONS | WORD_EXTENSIONS


@dataclass
class PromptAttachment:
    id: str
    owner_user_id: str
    filename: str
    media_type: str
    extension: str
    size_bytes: int
    path: str


def _meta_path(attachment_id: str) -> Path:
    return ATTACHMENT_DIR / f"{attachment_id}.json"


def _file_path(attachment_id: str, extension: str) -> Path:
    return ATTACHMENT_DIR / f"{attachment_id}{extension}"


def _normalize_extension(filename: str) -> str:
    return Path(filename).suffix.lower()


async def save_prompt_attachment(file: UploadFile, user_id: UUID) -> PromptAttachment:
    extension = _normalize_extension(file.filename or "")
    if extension not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Unsupported attachment type. Use PDF, DOCX, TXT, Markdown, or image files.",
        )

    blob = await file.read()
    if not blob:
        raise HTTPException(status_code=400, detail="Attachment is empty")

    attachment_id = str(uuid4())
    path = _file_path(attachment_id, extension)
    path.write_bytes(blob)

    attachment = PromptAttachment(
        id=attachment_id,
        owner_user_id=str(user_id),
        filename=file.filename or f"attachment{extension}",
        media_type=file.content_type or "application/octet-stream",
        extension=extension,
        size_bytes=len(blob),
        path=str(path),
    )
    _meta_path(attachment_id).write_text(json.dumps(asdict(attachment)), encoding="utf-8")
    return attachment


def load_prompt_attachment(attachment_id: str, user_id: UUID) -> PromptAttachment:
    meta_file = _meta_path(attachment_id)
    if not meta_file.exists():
        raise HTTPException(status_code=404, detail="Prompt attachment not found")

    payload = json.loads(meta_file.read_text(encoding="utf-8"))
    attachment = PromptAttachment(**payload)
    if attachment.owner_user_id != str(user_id):
        raise HTTPException(status_code=403, detail="No access to this prompt attachment")
    if not Path(attachment.path).exists():
        raise HTTPException(status_code=404, detail="Prompt attachment file not found")
    return attachment


def _extract_pdf_text(path: Path, char_limit: int = 16000) -> str:
    parts: list[str] = []
    total = 0
    pdf_doc = fitz.open(path)
    try:
        for page_number, page in enumerate(pdf_doc, start=1):
            text = " ".join(page.get_text("text").split())
            if not text:
                continue
            snippet = f"[Page {page_number}] {text}"
            remaining = char_limit - total
            if remaining <= 0:
                break
            parts.append(snippet[:remaining])
            total += min(len(snippet), remaining)
    finally:
        pdf_doc.close()
    return "\n".join(parts).strip()


def _extract_docx_text(path: Path, char_limit: int = 16000) -> str:
    with zipfile.ZipFile(path) as archive:
        try:
            xml_bytes = archive.read("word/document.xml")
        except KeyError as exc:
            raise HTTPException(status_code=400, detail="Could not read DOCX document") from exc

    root = ElementTree.fromstring(xml_bytes)
    texts = [node.text for node in root.iter() if node.tag.endswith("}t") and node.text]
    return " ".join(" ".join(texts).split())[:char_limit]


def _extract_text_attachment(path: Path, char_limit: int = 16000) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")[:char_limit]


def build_attachment_context(
    attachments: list[PromptAttachment],
) -> tuple[str, list[dict[str, Any]], list[dict[str, Any]]]:
    text_blocks: list[str] = []
    image_parts: list[dict[str, Any]] = []
    attachment_descriptors: list[dict[str, Any]] = []

    for attachment in attachments:
        path = Path(attachment.path)
        attachment_descriptors.append(
            {
                "id": attachment.id,
                "filename": attachment.filename,
                "media_type": attachment.media_type,
                "size_bytes": attachment.size_bytes,
            }
        )

        if attachment.extension in IMAGE_EXTENSIONS:
            encoded = base64.b64encode(path.read_bytes()).decode("ascii")
            image_parts.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{attachment.media_type};base64,{encoded}",
                    },
                }
            )
            text_blocks.append(
                f"Attached image: {attachment.filename}. Use the image directly in the answer."
            )
            continue

        if attachment.extension in PDF_EXTENSIONS:
            extracted = _extract_pdf_text(path)
            kind = "PDF"
        elif attachment.extension in WORD_EXTENSIONS:
            extracted = _extract_docx_text(path)
            kind = "Word document"
        else:
            extracted = _extract_text_attachment(path)
            kind = "text document"

        if not extracted:
            extracted = "No extractable text was found in this attachment."

        text_blocks.append(
            f"Attached {kind}: {attachment.filename}\n"
            f"Use the following attachment content directly when answering:\n{extracted}"
        )

    return "\n\n".join(text_blocks).strip(), image_parts, attachment_descriptors
