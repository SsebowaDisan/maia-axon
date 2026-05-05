"""Vision-based LaTeX extraction for equation regions.

The ingestion pipeline produces ``chunks.latex`` by copying the OCR'd plaintext
of equation regions, which mangles formulas (e.g. "Lw(f) = Kw(f) + 10 1g (11)").
This module re-extracts those regions with gpt-4o-mini's vision capability,
returning proper LaTeX that the frontend can render via KaTeX.

Used in two places:

- ``app.tasks.ingestion``: inline during new-document ingestion, replacing
  the OCR plaintext for each detected equation region.
- ``scripts/backfill_equation_latex.py``: one-shot pass over existing
  equation chunks to upgrade historical data.

The function returns ``None`` on any failure (network, malformed response,
"no equation visible"), and callers MUST fall back to the existing plaintext.
"""

from __future__ import annotations

import base64
import logging
from typing import Iterable

import fitz  # PyMuPDF
import openai

logger = logging.getLogger(__name__)

# 3.0 == ~216 DPI. High enough for reliable math OCR; low enough to keep
# image-token cost down (a typical equation crop ends up under 1k tokens).
_RENDER_ZOOM = 3.0

# Sentinel returned by the model when the cropped region contains no equation.
_NO_EQUATION_SENTINEL = "NO_EQUATION"

_PROMPT = (
    "The image is a region cropped from a printed textbook page. It should "
    "contain a mathematical equation or formula. Convert it to LaTeX.\n\n"
    "Rules:\n"
    "- Output ONLY the LaTeX expression. No prose, no $$ delimiters, no commentary.\n"
    "- Use standard LaTeX commands: \\frac{}{}, ^{}, _{}, \\rho, \\omega, \\Delta, "
    "\\sum, \\int, \\sqrt{}, \\cdot, \\approx, \\propto, etc.\n"
    "- For multi-line aligned equations, separate lines with \\\\ and use & for "
    "alignment markers.\n"
    "- Preserve equation numbers like (1), (2), (3) by appending them at the end: "
    "e.g. ' \\quad (1)'.\n"
    f"- If the image contains no math equation (only text, a figure, or a table), "
    f"output exactly: {_NO_EQUATION_SENTINEL}\n"
)


def _looks_like_latex(text: str) -> bool:
    """Cheap sanity check: did the model return something that resembles LaTeX?

    We accept anything containing a backslash command, a caret/underscore,
    or an equals-sign equation form. We reject the NO_EQUATION sentinel and
    pure prose. This gates the result before it overwrites existing data.
    """
    if not text:
        return False
    stripped = text.strip()
    if stripped == _NO_EQUATION_SENTINEL:
        return False
    if "\\" in stripped:
        return True
    if "^" in stripped or "_" in stripped:
        return True
    # Plain "X = Y" formula form is acceptable too.
    if "=" in stripped and any(ch.isalpha() for ch in stripped):
        return True
    return False


def _crop_region_to_png(
    page: fitz.Page,
    bboxes: Iterable[Iterable[float]],
) -> bytes | None:
    """Render the union of bboxes from a PDF page to a PNG byte string.

    Returns None if no usable bbox is provided. The union approach means a
    multi-line equation (which the indexer often splits into several adjacent
    bboxes) is captured as a single image — important because the model needs
    to see the full equation at once to produce coherent LaTeX.
    """
    valid: list[fitz.Rect] = []
    for raw in bboxes or []:
        try:
            x1, y1, x2, y2 = (float(v) for v in raw)
        except (TypeError, ValueError):
            continue
        if x2 <= x1 or y2 <= y1:
            continue
        valid.append(fitz.Rect(x1, y1, x2, y2))

    if not valid:
        return None

    union = valid[0]
    for rect in valid[1:]:
        union |= rect  # PyMuPDF Rect supports union via |=

    # Add a small margin so glyphs at the edge aren't clipped at high zoom.
    union = fitz.Rect(union.x0 - 2, union.y0 - 2, union.x1 + 2, union.y1 + 2)

    try:
        pixmap = page.get_pixmap(matrix=fitz.Matrix(_RENDER_ZOOM, _RENDER_ZOOM), clip=union)
        return pixmap.tobytes("png")
    except Exception as exc:
        logger.warning("Failed to render equation crop: %s", exc)
        return None


def extract_latex_from_region(
    client: openai.OpenAI,
    page: fitz.Page,
    bboxes: Iterable[Iterable[float]],
    ocr_hint: str | None = None,
    *,
    model: str = "gpt-4o-mini",
) -> str | None:
    """Render an equation region and ask the vision model for its LaTeX form.

    Returns the LaTeX string on success, or ``None`` if rendering failed,
    the model returned no equation, the API errored, or the result didn't
    pass the sanity check. Callers should keep the original plaintext when
    None is returned.
    """
    png_bytes = _crop_region_to_png(page, bboxes)
    if png_bytes is None:
        return None

    b64 = base64.b64encode(png_bytes).decode("ascii")
    prompt = _PROMPT
    if ocr_hint:
        prompt += (
            f"\nFor reference, the OCR plaintext of this region is (often garbled, "
            f"use only as a hint): {ocr_hint.strip()[:400]}\n"
        )

    try:
        response = client.chat.completions.create(
            model=model,
            max_tokens=400,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/png;base64,{b64}",
                                "detail": "high",
                            },
                        },
                    ],
                }
            ],
        )
    except Exception as exc:
        logger.warning("Vision call failed for equation region: %s", exc)
        return None

    raw = (response.choices[0].message.content or "").strip()

    # Strip code-fence wrappers if the model added them despite the prompt.
    if raw.startswith("```"):
        # Remove leading ``` or ```latex and trailing ```.
        first_newline = raw.find("\n")
        if first_newline != -1:
            raw = raw[first_newline + 1 :]
        if raw.endswith("```"):
            raw = raw[:-3]
        raw = raw.strip()

    # Strip $$ delimiters if added.
    if raw.startswith("$$") and raw.endswith("$$"):
        raw = raw[2:-2].strip()
    elif raw.startswith("$") and raw.endswith("$") and len(raw) > 2:
        raw = raw[1:-1].strip()

    if not _looks_like_latex(raw):
        return None
    return raw


def refresh_equation_chunks_for_document(
    document_id,
    db,
    openai_client: openai.OpenAI,
    *,
    pdf_bytes: bytes | None = None,
    model: str = "gpt-4o-mini",
) -> tuple[int, int]:
    """Re-extract LaTeX for every equation chunk in a document.

    Opens the original PDF once, walks each ``chunk_type='equation'`` chunk,
    crops its bbox region, runs vision extraction, and updates ``chunks.latex``
    when the result passes the sanity check. The original plaintext is kept
    on failure so the pipeline degrades gracefully.

    Returns ``(updated_count, total_equation_chunks)``.

    Used by:
    - The ingestion pipeline (passes ``pdf_bytes`` it already has in memory).
    - The one-shot backfill script (downloads ``pdf_bytes`` from object storage).
    """
    from sqlalchemy import select

    from app.core.storage import download_file
    from app.models.chunk import Chunk
    from app.models.document import Page

    if pdf_bytes is None:
        pdf_bytes = download_file(f"documents/{document_id}/original.pdf")

    pdf_doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        # Load equation chunks with their page numbers in one pass.
        rows = db.execute(
            select(Chunk, Page.page_number)
            .join(Page, Page.id == Chunk.page_id)
            .where(Chunk.document_id == document_id, Chunk.chunk_type == "equation")
            .order_by(Page.page_number, Chunk.id)
        ).all()

        updated = 0
        for chunk, page_number in rows:
            page_index = int(page_number) - 1
            if page_index < 0 or page_index >= len(pdf_doc):
                continue
            page = pdf_doc[page_index]
            ocr_hint = chunk.content_text or chunk.latex
            extracted = extract_latex_from_region(
                openai_client,
                page,
                chunk.bbox_references or [],
                ocr_hint=ocr_hint,
                model=model,
            )
            if not extracted:
                continue
            chunk.latex = extracted
            updated += 1

        db.commit()
        return updated, len(rows)
    finally:
        pdf_doc.close()
