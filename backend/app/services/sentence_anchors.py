"""Sentence-level anchor generation for NotebookLM-style citations.

Each text chunk emitted by ingestion is split into sentence anchors so the
answer model can cite at sentence granularity. The anchor format is
``{page_number}.{reading_order}`` (e.g. ``12.3``) and is embedded inline in
the chunk's ``content_text`` as ``<c>12.3</c>`` markers immediately before
each sentence. The model is instructed to return those ids in its citation
field; the backend then resolves each id to a sentence-level bounding box
stored alongside the chunk.

The bbox for a sentence is the union of the per-line bboxes whose lines
overlap that sentence's character span. When line-level bbox data is not
available (e.g. older GLM-OCR output), the parent chunk's bbox is used as
a fallback so the renderer still has *something* to highlight, just less
precise.

The splitter handles common abbreviations (etc., e.g., i.e., Dr., M.,
Fig., No., vol., etc.), decimal numbers (3.14, 9,81), parenthetical
punctuation, and equation references like (1.2) — splitting only on a
sentence-final period/question/exclamation followed by whitespace and a
capital letter, the start of a new line, or end-of-text.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable

# Name-prefix / label-prefix abbreviations: when one of these is followed
# by ``. <Capital>`` we MUST NOT split — the next capitalised word is part
# of the same sentence (e.g. ``Dr. Smith``, ``Fig. 5``, ``M. Dupont``).
# Trailing abbreviations like "etc." or "e.g." can legitimately end a
# sentence, so they're deliberately NOT in this set.
_NAME_PREFIX_ABBREVIATIONS = {
    "Dr",
    "Prof",
    "Mr",
    "Mrs",
    "Ms",
    "M",  # French "M." (Monsieur)
    "Mme",
    "St",  # Saint
    "av",  # avenue
    "p",  # "p. 12"
    "pp",
    "fig",
    "figs",
    "no",
    "vol",
    "ch",
    "ed",
    "eds",
    "ref",
    "refs",
    "eq",
    "eqs",
    "sec",
    "secs",
    "approx",
}

# Captures sentence-final punctuation followed by either whitespace + a
# capital letter (or digit), or the end of the text. We use lookahead so
# the punctuation stays attached to the preceding sentence and the space
# is consumed in the split.
_SENTENCE_END_RE = re.compile(
    r"(?<=[.!?])\s+(?=[A-ZÀ-ÖØ-Þ0-9])"
)
# A bare period/exclamation/question at end-of-string still terminates the
# last sentence; no split needed but the span runs to the end.

# Decimal numbers like ``3.14`` or ``9,81`` and equation refs like ``(1.2)``
# would be split by the naive regex if we didn't intercept. We pre-mask
# these substrings before splitting and restore them afterwards.
_DECIMAL_NUMBER_RE = re.compile(r"(\d)\s*[.,]\s*(\d)")
_EQUATION_REF_RE = re.compile(r"\((\d+)\.(\d+)\)")


@dataclass(frozen=True)
class SentenceSpan:
    """A single sentence within a chunk.

    Attributes:
        text: The sentence text, stripped.
        char_start: Inclusive character offset into the original chunk text.
        char_end: Exclusive character offset.
    """
    text: str
    char_start: int
    char_end: int


@dataclass(frozen=True)
class Anchor:
    """An anchor entry stored on a chunk.

    Format on the wire / in JSONB:
        ``{"id": "12.3", "bbox": [x1,y1,x2,y2], "char_start": int, "char_end": int}``
    """
    id: str
    bbox: list[float]
    char_start: int
    char_end: int

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "bbox": self.bbox,
            "char_start": self.char_start,
            "char_end": self.char_end,
        }


def _is_abbreviation_boundary(text: str, period_index: int) -> bool:
    """Was the period at ``period_index`` the end of an abbreviation?

    Walks backwards over word characters (and embedded periods like
    ``e.g.``) to extract the token, then checks against the abbreviation
    set. Used to decide whether a candidate split point should be skipped.
    """
    if period_index < 0 or period_index >= len(text) or text[period_index] != ".":
        return False
    end = period_index
    start = end - 1
    while start >= 0 and (text[start].isalnum() or text[start] == "."):
        start -= 1
    token = text[start + 1 : end]
    # Strip any leading dot from "e.g.", treat "e.g" as the comparison key.
    key = token.rstrip(".")
    # Only name-prefix abbreviations block a split. Trailing abbreviations
    # (etc., e.g., i.e.) can legitimately end a sentence and should split
    # when followed by a capitalised new clause.
    return key in _NAME_PREFIX_ABBREVIATIONS


def split_into_sentences(text: str) -> list[SentenceSpan]:
    """Split ``text`` into sentence spans with character offsets.

    Empty input returns an empty list. A single short text with no
    sentence-final punctuation returns one span covering the whole input.
    """
    if not text or not text.strip():
        return []

    # Mask spans that should NOT be considered sentence boundaries: decimal
    # numbers and equation references. We replace the periods with a marker
    # that won't appear in real text, run the splitter, then restore.
    placeholder = "\x00"

    def _mask(match: re.Match) -> str:
        return match.group(0).replace(".", placeholder).replace(",", placeholder)

    masked = _DECIMAL_NUMBER_RE.sub(_mask, text)
    masked = _EQUATION_REF_RE.sub(_mask, masked)

    spans: list[SentenceSpan] = []
    cursor = 0
    for match in _SENTENCE_END_RE.finditer(masked):
        # The character right before the match is the sentence-ending
        # punctuation. Make sure it isn't an abbreviation period.
        period_index = match.start() - 1
        while period_index > cursor and masked[period_index].isspace():
            period_index -= 1
        if masked[period_index] == "." and _is_abbreviation_boundary(masked, period_index):
            continue
        end = match.start()
        sentence_text = text[cursor:end].strip()
        if sentence_text:
            spans.append(
                SentenceSpan(
                    text=sentence_text,
                    char_start=cursor,
                    char_end=end,
                )
            )
        cursor = match.end()

    # Trailing sentence (no terminator after it).
    tail = text[cursor:].strip()
    if tail:
        spans.append(
            SentenceSpan(
                text=tail,
                char_start=cursor,
                char_end=len(text),
            )
        )

    return spans


def _bbox_union(boxes: Iterable[Iterable[float]]) -> list[float] | None:
    """Tightest enclosing bbox of a non-empty iterable of [x1,y1,x2,y2]."""
    xs1: list[float] = []
    ys1: list[float] = []
    xs2: list[float] = []
    ys2: list[float] = []
    for bb in boxes:
        try:
            x1, y1, x2, y2 = (float(v) for v in bb)
        except (TypeError, ValueError):
            continue
        if x2 <= x1 or y2 <= y1:
            continue
        xs1.append(x1)
        ys1.append(y1)
        xs2.append(x2)
        ys2.append(y2)
    if not xs1:
        return None
    return [round(min(xs1), 2), round(min(ys1), 2), round(max(xs2), 2), round(max(ys2), 2)]


def _resolve_sentence_bbox(
    sentence: SentenceSpan,
    lines: list[dict] | None,
    fallback_bbox: list[float] | None,
) -> list[float] | None:
    """Compute the bbox for a sentence given the chunk's per-line bboxes.

    ``lines`` is a list of dicts ``{"text": str, "bbox": [...]}`` covering
    the chunk content in reading order. We walk the lines, accumulating
    character offsets, and pick the bboxes that overlap the sentence's
    char range. When ``lines`` is missing/empty, we fall back to the
    chunk-level bbox so the renderer still has a target.
    """
    if not lines:
        return fallback_bbox

    overlapping: list[list[float]] = []
    cursor = 0
    for line in lines:
        line_text = str(line.get("text", ""))
        line_bbox = line.get("bbox")
        if not isinstance(line_bbox, list) or len(line_bbox) != 4:
            cursor += len(line_text) + 1  # +1 for the joining newline
            continue
        line_start = cursor
        line_end = cursor + len(line_text)
        # Lines and sentences overlap if their char ranges overlap.
        if line_start < sentence.char_end and line_end > sentence.char_start:
            overlapping.append(line_bbox)
        cursor = line_end + 1  # account for the "\n" we typically join with

    union = _bbox_union(overlapping) if overlapping else None
    return union or fallback_bbox


def annotate_with_anchors(
    text: str,
    *,
    page_number: int,
    starting_reading_order: int,
    chunk_bbox: list[float] | None = None,
    lines: list[dict] | None = None,
) -> tuple[str, list[Anchor], int]:
    """Split ``text`` into sentences, embed ``<c>page.order</c>`` markers, and emit anchors.

    Args:
        text: The raw chunk text (e.g. content_text before annotation).
        page_number: 1-indexed PDF page number, used as the prefix of each
            anchor id (matches what the user sees as the printed page label
            via ``page.page_number`` lookup).
        starting_reading_order: The next available reading-order index for
            this page. The function returns the updated counter so the
            caller can thread it across multiple chunks on the same page.
        chunk_bbox: Fallback bbox if a sentence cannot be tied to specific
            lines. Optional but recommended.
        lines: Optional list of ``{"text", "bbox"}`` per-line dicts in
            reading order, used to compute precise sentence bboxes.

    Returns:
        ``(annotated_text, anchors, next_reading_order)``.
        ``annotated_text`` has ``<c>{id}</c>`` markers inserted before each
        sentence. ``anchors`` is the list of ``Anchor`` objects to persist.
        ``next_reading_order`` is the counter to pass to the next chunk on
        the same page.

    On empty text, returns ``(text, [], starting_reading_order)``.
    """
    sentences = split_into_sentences(text)
    if not sentences:
        return text, [], starting_reading_order

    anchors: list[Anchor] = []
    rebuilt: list[str] = []
    last_end = 0
    order = starting_reading_order

    for sentence in sentences:
        # Carry over any inter-sentence whitespace verbatim.
        if sentence.char_start > last_end:
            rebuilt.append(text[last_end : sentence.char_start])

        anchor_id = f"{page_number}.{order}"
        bbox = _resolve_sentence_bbox(sentence, lines, chunk_bbox) or [0.0, 0.0, 0.0, 0.0]
        anchors.append(
            Anchor(
                id=anchor_id,
                bbox=bbox,
                char_start=sentence.char_start,
                char_end=sentence.char_end,
            )
        )
        rebuilt.append(f"<c>{anchor_id}</c>{sentence.text}")
        last_end = sentence.char_end
        order += 1

    if last_end < len(text):
        rebuilt.append(text[last_end:])

    return "".join(rebuilt), anchors, order
