"""Section enrichment pipeline.

Reads an already-OCR'd document and produces the
``book → topic → subtopic → headline`` tree that powers learn mode.
Each headline gets a strict-JSON enrichment payload (summary,
concepts introduced/assumed, key equations, outcomes, difficulty,
type, estimated minutes, hooks); each topic/subtopic gets a derived
rollup summary; each headline gets a semantic embedding for the
path-generation matcher.

This is the most important offline pass in the system — quality of
the section index is the upper bound on every learn-mode feature
that follows. So this module deliberately:

* uses ``gpt-4o`` (not ``mini``) for headline enrichment;
* validates every JSON response against a strict schema, with up to
  three corrective retries quoting the previous broken output;
* stores the entire tree in one transaction so a half-built tree
  never leaks into the application.

Entry points
------------
``run_section_mapping(db, doc_id)``
    Synchronous orchestrator. Used by the CLI command and by the
    Celery stage wrapper. Idempotent — re-running on a document
    wipes the previous tree and rebuilds.

``run_section_mapping_stage(self, doc_id)``
    Celery task that wraps ``run_section_mapping`` with status
    updates, retry behaviour, and the chain-forward to the next
    stage (``caption_document``).

Pipeline placement
------------------
Sits between ``run_ocr_stage`` and ``caption_document``. Section
mapping needs the cleaner ``page.markdown`` text the OCR stage
populates, but doesn't depend on figure captions or chunk
embeddings — so it slots in as soon as text content is available.
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable

import fitz  # PyMuPDF
import openai
from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.storage import download_file
from app.models.document import (
    Document,
    DocumentSection,
    DocumentSectionEmbedding,
    Page,
    SECTION_KINDS,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tuning constants
# ---------------------------------------------------------------------------

# Cap retries when the LLM returns invalid JSON or fails schema check.
# Three attempts is enough to absorb transient model drift; more than
# that and we're papering over a prompt that needs to be rewritten.
_MAX_CORRECTIVE_RETRIES = 3

# Input cap per headline enrichment call. gpt-4o has a 128k context
# window, but very long sections also produce diluted summaries — if a
# headline is 50k characters of body text, the answer rarely improves
# past this cap.
_HEADLINE_TEXT_MAX_CHARS = 60_000

# Default estimated-minutes when the model fails to provide one and
# the section is short enough that we'd rather backfill than retry.
_ESTIMATE_MINUTES_FALLBACK = 10

# Acceptable values for the headline enrichment payload's ``type`` key.
_VALID_HEADLINE_TYPES = ("foundational", "application", "optional")

# Maximum payload section title length we'll surface in the rollup
# prompt — keeps a wildly long subsection title from blowing the
# rollup call's token budget.
_TITLE_TRIM_CHARS = 200

# Embedding-model name. Mirrors the existing chunk embedding pipeline
# so the section vectors are queryable with the same machinery.
_EMBEDDING_MODEL = settings.embedding_model


# ---------------------------------------------------------------------------
# Skeleton dataclasses (the structural tree before LLM enrichment)
# ---------------------------------------------------------------------------


@dataclass
class SkeletonNode:
    """One node in the as-yet-unenriched book hierarchy.

    Built from PyMuPDF's outline (or, if the outline is missing,
    falls back to the ``nav_link`` regions persisted by the OCR
    stage). After enrichment, ``content_json`` carries the LLM
    payload for headlines or the derived rollup for topics /
    subtopics.
    """

    title: str
    kind: str  # 'topic' | 'subtopic' | 'headline'
    page_start: int
    page_end: int
    ordinal: int
    children: list["SkeletonNode"] = field(default_factory=list)
    content_json: dict[str, Any] | None = None
    # Filled in late, only for headlines, only after the OpenAI
    # embeddings call succeeds. Kept on the node so the persistence
    # step can write tree + vectors in one transaction.
    embedding: list[float] | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_openai_client() -> openai.OpenAI:
    """Same constructor pattern as ingestion.py — one client per call."""
    return openai.OpenAI(api_key=settings.openai_api_key)


def _trim_title(title: str) -> str:
    """Strip whitespace, drop trailing dots / numerals, cap length.

    PyMuPDF TOC titles often arrive with trailing dot-leaders (a
    legacy of TOC typesetting) and stray whitespace. The model is
    less prone to schema drift when titles are clean.
    """
    cleaned = " ".join(title.split())
    while cleaned.endswith((".", " ")):
        cleaned = cleaned[:-1]
    if len(cleaned) > _TITLE_TRIM_CHARS:
        cleaned = cleaned[: _TITLE_TRIM_CHARS - 1] + "…"
    return cleaned.strip()


def _page_text(page: Page) -> str:
    """Pick the cleaner of the two OCR outputs for a page.

    Prefers ``markdown`` because the OCR stage already structured
    headings and equations there. Falls back to ``ocr_text`` if the
    markdown is missing for any reason.
    """
    return (page.markdown or page.ocr_text or "").strip()


# ---------------------------------------------------------------------------
# Structural extraction
# ---------------------------------------------------------------------------


# Regex that matches a leading chapter prefix on a TOC line, e.g.
# "1.", "1.3.", "1.3.1.", "A.", "II.". The chapter prefix's dot-depth
# tells us the hierarchy level much more reliably than OCR's guess at
# the link's visual role. Groups: (numbering, rest).
_CHAPTER_PREFIX = __import__("re").compile(
    r"^\s*(?P<num>(?:\d+|[A-Z]|[IVX]+))(?:\.(?:\d+|[A-Z]|[IVX]+))*\.?\s+(?P<rest>\S.*)$"
)

# Address-shaped lines: a number followed by a comma and a postal code
# or city ("Rollnerstraße 111,8500 Nürnberg"). The OCR step occasionally
# tags these as nav_links because they sit in headers/footers.
_ADDRESS_LIKE = __import__("re").compile(
    r"\d{2,}\s*,\s*\d{2,}\s*[A-ZÄÖÜ][a-zäöüß]+", __import__("re").UNICODE
)

# Phone / fax numbers — never section titles.
_PHONE_LIKE = __import__("re").compile(r"\(\d{2,5}\)\s*\d{3,}|Fax\s*\d")

# Tabular row content that looks like a dimension or sizing entry,
# e.g. "160 mm", "1250 mm", "84 85", "800 900". These crowd parts-list
# pages and OCR tags them as nav_links.
_TABLE_ROW_LIKE = __import__("re").compile(
    r"^\s*(?:\d{2,5}\s*(?:mm|cm|kW|kg|Hz)?|\d{2,5}(?:[.,]\d+)?(?:\s+\d{2,5}(?:[.,]\d+)?){0,3})\s*$"
)

# Standards references ("DIN 45 635, Teil 2", "VDI 3731, Blatt 2",
# "Schallschutz im Hochbau, Blatt 1, 2, 3, 4 und 5").
_STANDARD_LIKE = __import__("re").compile(
    r"^(?:DIN|VDI|ISO|EN|VDE)\s*\d|Blatt\s*\d+(?:\s*,\s*\d+)+",
    __import__("re").IGNORECASE,
)

# Generic dot-leader detritus left over from typeset TOC pages —
# "Drossellinie .......................................17".
_DOT_LEADER = __import__("re").compile(r"\.{4,}")


def _looks_like_garbage_entry(title: str) -> bool:
    """Return True for nav-link content that almost certainly isn't a
    section title — addresses, phone numbers, table cells, standards
    references, or dot-leader artefacts.

    Conservative on purpose: when in doubt, keep the entry. Filtering
    too aggressively risks dropping real chapters whose titles happen
    to look numeric (e.g. "160 mm Lüfter" — but a real section would
    keep going past the dimension).
    """
    t = (title or "").strip()
    if len(t) < 4:
        return True
    # Pure punctuation / dot leaders aren't titles.
    alpha = sum(1 for ch in t if ch.isalpha())
    if alpha < 3:
        return True
    if _ADDRESS_LIKE.search(t):
        return True
    if _PHONE_LIKE.search(t):
        return True
    if _TABLE_ROW_LIKE.match(t):
        return True
    if _STANDARD_LIKE.search(t):
        return True
    if _DOT_LEADER.search(t) and len(t) - len(_DOT_LEADER.sub("", t)) > 6:
        # Dot leaders survive in well-formed TOC entries too, but those
        # always have a substantial alpha body before the dots. We only
        # filter when the leader takes over the line.
        body_alpha = sum(1 for ch in _DOT_LEADER.sub("", t) if ch.isalpha())
        if body_alpha < 8:
            return True
    # Lines that are mostly digits + spaces + punctuation (table row
    # remnants like "okt_____ 105,5" or "800 900").
    digit_share = sum(1 for ch in t if ch.isdigit()) / max(len(t), 1)
    if digit_share > 0.55 and alpha < 8:
        return True
    return False


def _chapter_level_from_title(title: str) -> int | None:
    """When a title starts with a chapter prefix like "1.", "1.3.",
    "1.3.1.", count the numbering segments to infer hierarchy level
    (1=topic, 2=subtopic, 3+=headline). Returns None when no clean
    prefix is present.
    """
    if not title:
        return None
    if not _CHAPTER_PREFIX.match(title):
        return None
    # Pull the numbering portion ("1.3.1.") off the front. Walk until
    # we hit whitespace; the prefix is whatever came before.
    leading = title.lstrip()
    space_idx = leading.find(" ")
    if space_idx == -1:
        return None
    prefix = leading[:space_idx].rstrip(".")
    if not prefix:
        return None
    # Each dot-separated chunk is one hierarchy step.
    parts = [p for p in prefix.split(".") if p]
    if not parts:
        return None
    # Reject prefixes whose first token is purely digit AND a single
    # huge number (a stray page-number caught at the start of a line);
    # real chapters always have a sub-token or alpha content after.
    if len(parts) == 1 and parts[0].isdigit() and len(parts[0]) >= 4:
        return None
    return min(len(parts), 4)


def _depth_to_kind(level: int, max_depth: int) -> str:
    """Decide whether a TOC entry at this depth becomes a topic,
    subtopic, or headline.

    The mapping depends on how deep the TOC actually goes:

    * 1 level only → every entry is a headline under one synthetic
      "Content" topic (built by the caller).
    * 2 levels → depth 1 = topic, depth 2 = headline (no subtopic
      layer).
    * 3+ levels → depth 1 = topic, depth 2 = subtopic, depth 3+ =
      headline. Anything deeper than 3 still maps to headline so the
      tree never grows beyond the canonical four levels.
    """
    if max_depth <= 1:
        return "headline"
    if max_depth == 2:
        return "topic" if level == 1 else "headline"
    if level == 1:
        return "topic"
    if level == 2:
        return "subtopic"
    return "headline"


def _extract_skeleton_from_toc(
    pdf_bytes: bytes,
    page_count: int,
) -> list[SkeletonNode]:
    """Build the structural tree from the PDF's embedded outline.

    Raises ``ValueError`` if the PDF has no outline (caller can then
    try a different source).
    """
    pdf_doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        toc = pdf_doc.get_toc()  # [[level, title, page (1-indexed)], ...]
    finally:
        pdf_doc.close()
    if not toc:
        raise ValueError("PDF has no embedded outline")
    return _build_tree_from_entries(toc, page_count)


def _extract_skeleton_from_nav_links(
    pages: Iterable[Page],
    page_count: int,
) -> list[SkeletonNode]:
    """Fallback: derive the tree from ``nav_link`` regions that the
    OCR stage parsed out of the printed table of contents.

    Two passes of cleanup before the entries reach the tree builder:

    1. Drop entries that look like noise — addresses, phone numbers,
       standard references, dot-leader remnants, and table-row cell
       values (parts-list dimensions, page-label fragments). These
       are surprisingly common when the OCR stage tags column headers
       and table values as nav_links.

    2. When a title carries a chapter prefix ("1.", "1.3.", "1.3.1."),
       trust the prefix's dot-depth over the OCR's "page" / "section"
       classification — it's much more reliable than the visual
       heuristic the OCR uses, especially for German technical books
       that don't typeset chapters as larger headers.

    Returns ``[]`` if no usable nav_links remain after filtering.
    """
    # Collect candidate nav-links twice: first into a "with-prefix"
    # bucket and a "no-prefix" bucket. We use only the with-prefix
    # entries when the document has enough of them to form a tree.
    # That elides the OCR-tagged noise (addresses, table cells, dot-
    # leader fragments) that don't carry chapter numbers.
    with_prefix: list[tuple[int, str, int]] = []
    no_prefix: list[tuple[int, str, int]] = []
    seen_titles: set[tuple[int, str]] = set()
    for page in pages:
        for region in page.regions or []:
            if region.get("type") != "nav_link":
                continue
            target_page = region.get("target_page_number")
            content = (region.get("content") or "").strip()
            if not content or not isinstance(target_page, int):
                continue
            # Filter obvious noise.
            if _looks_like_garbage_entry(content):
                continue
            chapter_level = _chapter_level_from_title(content)
            if chapter_level is not None:
                level = chapter_level
                bucket = with_prefix
            else:
                # OCR's nav_entry_kind is unreliable for unnumbered
                # entries; default conservatively to level 2.
                kind = region.get("nav_entry_kind") or "section"
                level = 1 if kind == "page" else 2
                bucket = no_prefix
            key = (level, content)
            if key in seen_titles:
                continue
            seen_titles.add(key)
            bucket.append((level, content, target_page))

    # If the book has a useful body of chapter-numbered entries, that
    # is our skeleton. Don't dilute it with the unnumbered residue —
    # the residue is overwhelmingly noise (address blocks, parts-list
    # rows, math fragments) on books where the typesetter relied on
    # numbered headings. We require at least 6 numbered entries to
    # avoid a misleading skeleton built from a handful of accidents.
    if len(with_prefix) >= 6:
        entries = with_prefix
    else:
        entries = with_prefix + no_prefix

    if not entries:
        return []
    # Sort by target page so the structural builder sees them in
    # reading order.
    entries.sort(key=lambda e: (e[2], e[0]))
    return _build_tree_from_entries(entries, page_count)


def _build_tree_from_entries(
    entries: list[tuple[int, str, int]] | list[list[Any]],
    page_count: int,
) -> list[SkeletonNode]:
    """Turn a flat ``[(level, title, page)]`` list into a SkeletonNode
    tree with kinds assigned and page ranges computed.

    Walking rules:
      * Each entry's ``page_end`` runs up to the page *before* the
        next entry at the same or shallower level (or to the last
        page of the book for the final entry).
      * Parent for entry N is the most recent prior entry with a
        strictly shallower level. Entries with no such parent become
        top-level (topics).
      * Kinds derived from ``_depth_to_kind`` based on the overall
        max-depth of the TOC.
    """
    if not entries:
        return []

    # Normalise: PyMuPDF returns lists, our fallback returns tuples.
    normalised: list[tuple[int, str, int]] = [
        (int(e[0]), _trim_title(str(e[1])), max(1, int(e[2])))
        for e in entries
    ]
    max_depth = max(e[0] for e in normalised)

    # Compute page_end for each entry: page-before-next-same-or-shallower.
    page_ends: list[int] = []
    for i, (level, _title, page) in enumerate(normalised):
        next_page = page_count
        for j in range(i + 1, len(normalised)):
            next_level, _, next_p = normalised[j]
            if next_level <= level:
                next_page = max(page, next_p - 1)
                break
        page_ends.append(next_page)

    # Build the nesting. Stack of (node, level) — pop until the top of
    # the stack has a strictly shallower level than the current entry,
    # then attach.
    roots: list[SkeletonNode] = []
    stack: list[tuple[SkeletonNode, int]] = []
    ordinal_at_level: dict[int, int] = {}

    for (level, title, page), page_end in zip(normalised, page_ends):
        kind = _depth_to_kind(level, max_depth)
        # Strip stack entries that are at this depth or deeper.
        while stack and stack[-1][1] >= level:
            stack.pop()
        ordinal_key = stack[-1][1] if stack else 0
        ordinal = ordinal_at_level.get((ordinal_key, level), 0)
        ordinal_at_level[(ordinal_key, level)] = ordinal + 1

        node = SkeletonNode(
            title=title,
            kind=kind,
            page_start=page,
            page_end=page_end,
            ordinal=ordinal,
        )
        if stack:
            stack[-1][0].children.append(node)
        else:
            roots.append(node)
        stack.append((node, level))

    # If max_depth was 1, every entry was a headline — but a headline
    # cannot be a root in our schema. Wrap them in a synthetic topic.
    if max_depth == 1:
        synthetic = SkeletonNode(
            title="Content",
            kind="topic",
            page_start=roots[0].page_start if roots else 1,
            page_end=roots[-1].page_end if roots else page_count,
            ordinal=0,
            children=roots,
        )
        return [synthetic]

    return roots


def _iter_headlines(roots: Iterable[SkeletonNode]) -> Iterable[SkeletonNode]:
    """Yield every headline (leaf) node in reading order."""
    for root in roots:
        if root.kind == "headline":
            yield root
            continue
        yield from _iter_headlines(root.children)


def _iter_non_headlines(roots: Iterable[SkeletonNode]) -> Iterable[SkeletonNode]:
    """Yield every topic/subtopic node — i.e. internal tree nodes."""
    for root in roots:
        if root.kind != "headline":
            yield root
            yield from _iter_non_headlines(root.children)


# ---------------------------------------------------------------------------
# Per-headline enrichment (the OpenAI gpt-4o call)
# ---------------------------------------------------------------------------


_HEADLINE_ENRICHMENT_SYSTEM = """\
You are analysing one section of a technical book to build a learning index. \
Read the section text carefully and output STRICT JSON ONLY — no commentary, \
no markdown fences, no prose outside the JSON object.

The JSON object must match this exact schema:

{
  "summary": <string, one plain sentence describing what the section teaches>,
  "concepts_introduced": [
    {
      "name": <string>,
      "definition": <string, one sentence>,
      "source_quote": <string, a SHORT verbatim quote (≤200 chars) from the section text where this concept is introduced or defined>
    }
  ],
  "concepts_assumed": [<string>, ...],
  "key_equations": [
    {
      "latex": <string, LaTeX>,
      "name": <string, short label>,
      "page": <int>,
      "source_quote": <string, a SHORT verbatim quote (≤200 chars) from the section text containing or describing the equation>
    }
  ],
  "difficulty": <int 1..5>,
  "type": <"foundational" | "application" | "optional">,
  "outcomes": [<string starting with an action verb, e.g. "Compute ..." / "Recognise ...">],
  "estimated_minutes": <int, realistic minutes for a beginner to read + work through>,
  "hooks": [<string, a curiosity-driving question the section answers>],
  "confidence": {
    "summary":             <int 0..3, 0=guess, 1=weak, 2=solid, 3=verbatim in text>,
    "concepts_introduced": <int 0..3>,
    "key_equations":       <int 0..3>,
    "difficulty":          <int 0..3>
  }
}

Rules:
  - "summary": exactly one sentence, plain language, no jargon unless the section itself defines it.
  - "concepts_introduced": only concepts this section actively teaches. Skip ones merely mentioned. EVERY entry MUST include a "source_quote" that is a VERBATIM substring of the section text (do not paraphrase the quote). If you cannot find a verbatim quote, drop the concept entirely — do NOT invent a quote.
  - "concepts_assumed": concepts the section uses without explaining. Be generous — anything a beginner might not know.
  - "key_equations": up to FIVE most important equations. Skip trivial intermediate steps. Use VALID LaTeX (parseable by KaTeX). Every entry MUST include a "source_quote" that is a verbatim substring of the section text containing the equation or its description. Omit any equation you cannot quote.
  - "difficulty": 1 introductory, 5 advanced research.
  - "type": "foundational" if the section defines new concepts, "application" if it applies prior concepts, "optional" if it's an aside / historical note / advanced extension.
  - "outcomes": concrete capabilities phrased as "verb ...". 1-6 entries. Skip vague outcomes like "understand X".
  - "hooks": 1-3 entries. Skip if the section is purely mechanical.
  - "confidence": honest self-rating. Use 3 ONLY when a verbatim quote backs the claim; use 0 when you are guessing from context.
  - All arrays may be empty if genuinely none apply. PREFER EMPTINESS to invention — a missing concept is fine, a hallucinated one is not.

Output ONLY the JSON object.\
"""


def _build_headline_enrichment_user_prompt(
    *,
    title: str,
    page_start: int,
    page_end: int,
    section_text: str,
) -> str:
    return (
        f"Section title: {title}\n"
        f"Page range in book: {page_start}–{page_end}\n\n"
        f"Section text:\n{section_text}"
    )


class HeadlineSchemaError(ValueError):
    """Raised when the LLM's headline JSON fails schema validation."""


_QUOTE_NORMALIZE_RE = None  # populated lazily; see _normalize_for_quote_match


def _normalize_for_quote_match(text: str) -> str:
    """Normalise for verbatim quote checks.

    OCR output and the LLM's quote often differ in whitespace,
    ligatures, smart quotes, soft hyphens, and line breaks. We
    collapse to lowercase ASCII letters and digits so the match
    survives those differences while still catching genuinely
    hallucinated quotes.
    """
    import re

    global _QUOTE_NORMALIZE_RE
    if _QUOTE_NORMALIZE_RE is None:
        _QUOTE_NORMALIZE_RE = re.compile(r"[^a-z0-9]+")
    # Cheap unicode normalisation: replace common typographic chars.
    swapped = (
        text.replace("’", "'")
        .replace("‘", "'")
        .replace("“", '"')
        .replace("”", '"')
        .replace("–", "-")
        .replace("—", "-")
        .replace("­", "")  # soft hyphen
        .replace("ﬁ", "fi")
        .replace("ﬂ", "fl")
    )
    return _QUOTE_NORMALIZE_RE.sub(" ", swapped.lower()).strip()


def _quote_appears_in(quote: str, section_text: str) -> bool:
    """True when ``quote`` appears verbatim (modulo whitespace /
    punctuation / case) in ``section_text``. Short quotes (< 12
    normalised chars) are rejected because they match anywhere."""
    norm_quote = _normalize_for_quote_match(quote)
    if len(norm_quote) < 12:
        return False
    return norm_quote in _normalize_for_quote_match(section_text)


def _validate_headline_payload(payload: Any) -> None:
    """Strict schema check. Raises HeadlineSchemaError on any
    violation; the caller uses the message as the corrective-retry
    prompt so the model knows what specifically went wrong."""

    if not isinstance(payload, dict):
        raise HeadlineSchemaError("top-level value must be a JSON object")

    # Required keys with type rules.
    summary = payload.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        raise HeadlineSchemaError("'summary' must be a non-empty string")
    if len(summary) > 400:
        raise HeadlineSchemaError(
            f"'summary' is {len(summary)} chars; must be a single sentence ≤ 400 chars"
        )

    introduced = payload.get("concepts_introduced", [])
    if not isinstance(introduced, list):
        raise HeadlineSchemaError("'concepts_introduced' must be a list")
    for i, item in enumerate(introduced):
        if not isinstance(item, dict):
            raise HeadlineSchemaError(
                f"'concepts_introduced[{i}]' must be an object with 'name' and 'definition'"
            )
        if not isinstance(item.get("name"), str) or not item["name"].strip():
            raise HeadlineSchemaError(
                f"'concepts_introduced[{i}].name' must be a non-empty string"
            )
        if not isinstance(item.get("definition"), str) or not item["definition"].strip():
            raise HeadlineSchemaError(
                f"'concepts_introduced[{i}].definition' must be a non-empty string"
            )
        # source_quote is optional in the schema (so the verifier
        # can mark missing entries as low-confidence rather than
        # forcing a retry), but if present must be a string.
        sq = item.get("source_quote")
        if sq is not None and not isinstance(sq, str):
            raise HeadlineSchemaError(
                f"'concepts_introduced[{i}].source_quote' must be a string when provided"
            )

    assumed = payload.get("concepts_assumed", [])
    if not isinstance(assumed, list) or not all(isinstance(x, str) for x in assumed):
        raise HeadlineSchemaError("'concepts_assumed' must be a list of strings")

    equations = payload.get("key_equations", [])
    if not isinstance(equations, list):
        raise HeadlineSchemaError("'key_equations' must be a list (or omitted)")
    for i, eq in enumerate(equations):
        if not isinstance(eq, dict):
            raise HeadlineSchemaError(f"'key_equations[{i}]' must be an object")
        if not isinstance(eq.get("latex"), str) or not eq["latex"].strip():
            raise HeadlineSchemaError(
                f"'key_equations[{i}].latex' must be a non-empty string"
            )
        if not isinstance(eq.get("name"), str):
            raise HeadlineSchemaError(f"'key_equations[{i}].name' must be a string")
        if not isinstance(eq.get("page"), int):
            raise HeadlineSchemaError(
                f"'key_equations[{i}].page' must be an integer"
            )
        sq = eq.get("source_quote")
        if sq is not None and not isinstance(sq, str):
            raise HeadlineSchemaError(
                f"'key_equations[{i}].source_quote' must be a string when provided"
            )

    difficulty = payload.get("difficulty")
    if not isinstance(difficulty, int) or not 1 <= difficulty <= 5:
        raise HeadlineSchemaError("'difficulty' must be an integer 1..5")

    type_value = payload.get("type")
    if type_value not in _VALID_HEADLINE_TYPES:
        raise HeadlineSchemaError(
            f"'type' must be one of {_VALID_HEADLINE_TYPES}, got {type_value!r}"
        )

    outcomes = payload.get("outcomes", [])
    if not isinstance(outcomes, list) or not all(isinstance(x, str) for x in outcomes):
        raise HeadlineSchemaError("'outcomes' must be a list of strings")

    minutes = payload.get("estimated_minutes")
    if not isinstance(minutes, int) or minutes <= 0:
        raise HeadlineSchemaError("'estimated_minutes' must be a positive integer")

    hooks = payload.get("hooks", [])
    if not isinstance(hooks, list) or not all(isinstance(x, str) for x in hooks):
        raise HeadlineSchemaError("'hooks' must be a list of strings")

    confidence = payload.get("confidence")
    if confidence is not None:
        if not isinstance(confidence, dict):
            raise HeadlineSchemaError("'confidence' must be an object when provided")
        for key, value in confidence.items():
            if not isinstance(value, int) or not 0 <= value <= 3:
                raise HeadlineSchemaError(
                    f"'confidence.{key}' must be an int in 0..3"
                )


def _verify_section_payload_against_source(
    payload: dict[str, Any], section_text: str
) -> dict[str, Any]:
    """Run deterministic checks against the source text and annotate
    the payload in place. Adds:

    * ``concepts_introduced[i].verified``: True when source_quote
      appears verbatim in section_text. Entries that fail this are
      not deleted (the admin tools may want to review them) but the
      flag drives downstream filtering (concept-graph build skips
      unverified concepts) and surfaces them in review queues.
    * ``key_equations[i].verified``: same idea.
    * top-level ``review_flags``: list of human-readable reasons the
      section needs admin attention (e.g. "2 unverified concepts").
    """
    flags: list[str] = []

    def _stamp(items: list[Any], label: str) -> int:
        unverified = 0
        for item in items:
            if not isinstance(item, dict):
                continue
            quote = item.get("source_quote") or ""
            verified = bool(quote) and _quote_appears_in(quote, section_text)
            item["verified"] = verified
            if not verified:
                unverified += 1
        if unverified:
            flags.append(f"{unverified} unverified {label}")
        return unverified

    _stamp(payload.get("concepts_introduced", []) or [], "concept(s)")
    _stamp(payload.get("key_equations", []) or [], "equation(s)")

    # Low-confidence summary or difficulty also surfaces for review.
    conf = payload.get("confidence") or {}
    if isinstance(conf, dict):
        low = [k for k, v in conf.items() if isinstance(v, int) and v <= 1]
        if low:
            flags.append("low confidence: " + ", ".join(sorted(low)))

    payload["review_flags"] = flags
    return payload


def _enrich_headline(
    client: openai.OpenAI,
    *,
    title: str,
    page_start: int,
    page_end: int,
    section_text: str,
) -> dict[str, Any]:
    """Run the gpt-4o JSON call with schema validation + corrective
    retries. Returns the validated payload."""

    if len(section_text) > _HEADLINE_TEXT_MAX_CHARS:
        section_text = section_text[: _HEADLINE_TEXT_MAX_CHARS]
        logger.warning(
            "section text truncated to %d chars for headline %r",
            _HEADLINE_TEXT_MAX_CHARS,
            title,
        )

    base_user_prompt = _build_headline_enrichment_user_prompt(
        title=title,
        page_start=page_start,
        page_end=page_end,
        section_text=section_text,
    )

    last_error: str | None = None
    last_raw: str | None = None

    for attempt in range(_MAX_CORRECTIVE_RETRIES + 1):
        if attempt == 0:
            user_prompt = base_user_prompt
        else:
            # Corrective retry. Quote the previous broken output back
            # to the model so it stops repeating the same mistake.
            user_prompt = (
                "Your previous response was invalid: "
                f"{last_error}\n\n"
                f"Previous response (DO NOT REPEAT THE SAME MISTAKE):\n{last_raw}\n\n"
                "Re-run the original task and output ONLY a corrected "
                "JSON object. Original task input:\n\n"
                f"{base_user_prompt}"
            )

        completion = client.chat.completions.create(
            model=settings.openai_reasoning_model,
            messages=[
                {"role": "system", "content": _HEADLINE_ENRICHMENT_SYSTEM},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0,
        )
        last_raw = (completion.choices[0].message.content or "").strip()

        try:
            payload = json.loads(last_raw)
        except json.JSONDecodeError as exc:
            last_error = f"output was not valid JSON ({exc.msg} at char {exc.pos})"
            logger.warning(
                "headline_enrichment_parse_failed attempt=%d title=%r error=%s",
                attempt,
                title,
                last_error,
            )
            continue

        try:
            _validate_headline_payload(payload)
        except HeadlineSchemaError as exc:
            last_error = str(exc)
            logger.warning(
                "headline_enrichment_schema_failed attempt=%d title=%r error=%s",
                attempt,
                title,
                last_error,
            )
            continue

        # Verify quotes against the source text. This never fails the
        # call — instead it annotates entries with verified=true/false
        # and accumulates a review_flags list the admin tools can use
        # to triage what needs human attention. Verified=false entries
        # are filtered out of the concept-graph build downstream so
        # hallucinated concepts don't pollute the corpus graph.
        _verify_section_payload_against_source(payload, section_text)
        return payload

    raise RuntimeError(
        f"Headline enrichment failed for {title!r} after "
        f"{_MAX_CORRECTIVE_RETRIES + 1} attempts. Last error: {last_error}. "
        f"Final raw response was: {last_raw!r}"
    )


# ---------------------------------------------------------------------------
# Topic / subtopic rollup
# ---------------------------------------------------------------------------


_ROLLUP_SYSTEM = """\
You are summarising one part of a technical book. You will be given a parent \
section title and the JSON-style summaries of its child sections, in reading \
order. Produce STRICT JSON ONLY with this schema:

{"summary": <string, one or two plain sentences describing what this part of the book covers, written for a learner who hasn't read it yet>}

Rules:
  - Use the children's summaries as your only source. Do not invent content.
  - One or two sentences total. No bullet points.
  - Plain language. Mention the most important concepts the children introduce, by name.
  - Output ONLY the JSON object.\
"""


def _rollup_node(
    client: openai.OpenAI,
    node: SkeletonNode,
) -> dict[str, Any]:
    """Build the topic/subtopic ``content_json`` from its enriched
    children. One LLM call for the prose summary; everything else is
    deterministic aggregation."""

    if not node.children:
        # Empty branch — synthesise an honest empty payload.
        return {
            "summary": f"{node.title} (no sections indexed).",
            "child_count": 0,
            "estimated_minutes": 0,
            "outcomes": [],
            "concepts_introduced": [],
        }

    # Aggregate cheap stuff first.
    estimated_minutes = 0
    outcomes_seen: list[str] = []
    concepts_seen: list[dict[str, str]] = []
    concepts_seen_names: set[str] = set()

    def _walk(child: SkeletonNode) -> None:
        nonlocal estimated_minutes
        payload = child.content_json or {}
        if child.kind == "headline":
            estimated_minutes += int(payload.get("estimated_minutes", 0) or 0)
            for outcome in payload.get("outcomes", []) or []:
                if outcome not in outcomes_seen:
                    outcomes_seen.append(outcome)
            for concept in payload.get("concepts_introduced", []) or []:
                name = concept.get("name", "").strip()
                if name and name not in concepts_seen_names:
                    concepts_seen_names.add(name)
                    concepts_seen.append(concept)
        else:
            # For nested non-headlines, recurse to pick up grand-children.
            for grandchild in child.children:
                _walk(grandchild)

    for child in node.children:
        _walk(child)

    # LLM summary over child titles + child summaries (shallow only).
    child_briefs = []
    for child in node.children:
        summary = (child.content_json or {}).get("summary", "").strip()
        child_briefs.append(
            {"title": child.title, "summary": summary or "(no summary)"}
        )
    user_prompt = (
        f"Parent title: {node.title}\n\n"
        f"Children (in reading order):\n{json.dumps(child_briefs, ensure_ascii=False, indent=2)}"
    )
    completion = client.chat.completions.create(
        model=settings.openai_reasoning_model,
        messages=[
            {"role": "system", "content": _ROLLUP_SYSTEM},
            {"role": "user", "content": user_prompt},
        ],
        response_format={"type": "json_object"},
        temperature=0,
    )
    raw = (completion.choices[0].message.content or "").strip()
    try:
        parsed = json.loads(raw)
        summary = parsed.get("summary")
        if not isinstance(summary, str) or not summary.strip():
            summary = f"This part covers {len(node.children)} sections in {node.title}."
    except json.JSONDecodeError:
        summary = f"This part covers {len(node.children)} sections in {node.title}."

    return {
        "summary": summary,
        "child_count": len(node.children),
        "estimated_minutes": estimated_minutes or _ESTIMATE_MINUTES_FALLBACK,
        "outcomes": outcomes_seen[:8],
        "concepts_introduced": concepts_seen[:20],
    }


# ---------------------------------------------------------------------------
# Embeddings
# ---------------------------------------------------------------------------


def _embedding_input_for_headline(node: SkeletonNode) -> str:
    """Build the text we embed for semantic search.

    Goal: a user types "I want to learn X" — we match that against
    *what each section teaches*, not raw page text. So we embed:
    title + summary + concept names + outcomes. Compact and focused.
    """
    payload = node.content_json or {}
    pieces: list[str] = [node.title]
    summary = (payload.get("summary") or "").strip()
    if summary:
        pieces.append(summary)
    concept_names = [
        concept.get("name", "").strip()
        for concept in payload.get("concepts_introduced", []) or []
        if concept.get("name", "").strip()
    ]
    if concept_names:
        pieces.append("Concepts: " + ", ".join(concept_names))
    outcomes = payload.get("outcomes", []) or []
    if outcomes:
        pieces.append("Outcomes: " + "; ".join(outcomes))
    return "\n".join(pieces)


def _generate_embeddings(
    client: openai.OpenAI,
    headlines: list[SkeletonNode],
) -> None:
    """Populate each headline's ``.embedding`` field in place.

    Batches up to 50 headlines per OpenAI call — the embeddings
    endpoint takes an array and amortises overhead nicely.
    """
    if not headlines:
        return
    BATCH = 50
    for offset in range(0, len(headlines), BATCH):
        batch = headlines[offset : offset + BATCH]
        inputs = [_embedding_input_for_headline(node) for node in batch]
        response = client.embeddings.create(
            model=_EMBEDDING_MODEL,
            input=inputs,
            dimensions=settings.embedding_dimensions,
        )
        for node, item in zip(batch, response.data):
            node.embedding = item.embedding


# ---------------------------------------------------------------------------
# Thematic chapter grouping
# ---------------------------------------------------------------------------


_CHAPTER_GROUPING_SYSTEM = """\
You are organising the chapters of a technical book into a small \
number of thematic groups so a reader can see the book's structure \
at a glance.

You will receive a list of top-level chapters, each with a title and \
a short summary. Cluster them into 3-6 thematic groups. Output STRICT \
JSON ONLY in this exact shape:

{
  "groups": [
    {
      "name": <string, 2-5 words, sentence case, no numbering>,
      "rationale": <string, one short sentence explaining what unites these chapters>,
      "section_ids": [<string uuid>, ...]
    },
    ...
  ]
}

Rules:
  - EVERY input chapter id MUST appear in exactly one group. No duplicates, no omissions.
  - Aim for 3-6 groups. With only 4-5 chapters, prefer 2-3 groups.
  - Group names should be substantive and specific to the book — "Acoustics" is good, "Topics A" is not.
  - Order groups by reading order: the group whose earliest chapter comes first in the book goes first.
  - Within each group, order section_ids by reading order (lowest page first).
  - rationale stays one sentence, no Markdown.

Output ONLY the JSON object.\
"""


def _generate_chapter_groups(
    client: openai.OpenAI,
    roots: list[SkeletonNode],
    root_ids: dict[int, str],
) -> list[dict[str, Any]]:
    """Cluster top-level chapters into thematic groups using one LLM call.

    ``root_ids`` is a positional → uuid map filled in by the caller
    after persistence (the SkeletonNode tree doesn't know its DB ids
    until ``_persist_tree`` runs). Returns the validated group list
    or ``[]`` when grouping is skipped (too few chapters, validator
    rejects, retries exhausted).
    """
    if len(roots) < 4:
        # Two or three chapters is below the threshold where grouping
        # adds clarity — render them flat under the book root.
        return []

    chapters: list[dict[str, Any]] = []
    for idx, node in enumerate(roots):
        node_id = root_ids.get(idx)
        if not node_id:
            continue
        summary = ""
        if isinstance(node.content_json, dict):
            summary = (node.content_json.get("summary") or "").strip()
        chapters.append(
            {
                "id": node_id,
                "title": node.title[:200],
                "summary": summary[:400] or "(no summary)",
                "page_start": node.page_start,
            }
        )

    if not chapters:
        return []

    user_prompt = (
        f"Chapters (in reading order, {len(chapters)} total):\n"
        f"{json.dumps(chapters, ensure_ascii=False, indent=2)}"
    )

    valid_ids = {c["id"] for c in chapters}
    last_error: str | None = None
    last_raw: str | None = None

    for attempt in range(_MAX_CORRECTIVE_RETRIES + 1):
        prompt = user_prompt
        if attempt > 0:
            prompt = (
                "Your previous response was invalid: "
                f"{last_error}\n\n"
                f"Previous response (DO NOT REPEAT THE SAME MISTAKE):\n{last_raw}\n\n"
                "Re-run the original task and output ONLY a corrected "
                "JSON object. Original task input:\n\n"
                f"{user_prompt}"
            )
        try:
            completion = client.chat.completions.create(
                model=settings.openai_reasoning_model,
                messages=[
                    {"role": "system", "content": _CHAPTER_GROUPING_SYSTEM},
                    {"role": "user", "content": prompt},
                ],
                response_format={"type": "json_object"},
                temperature=0,
            )
        except Exception as exc:  # noqa: BLE001
            last_error = f"openai call failed: {exc}"
            logger.warning("chapter_groups_call_failed attempt=%d %s", attempt, exc)
            continue

        last_raw = (completion.choices[0].message.content or "").strip()
        try:
            payload = json.loads(last_raw)
        except json.JSONDecodeError as exc:
            last_error = f"output was not valid JSON ({exc.msg})"
            continue

        groups = payload.get("groups") if isinstance(payload, dict) else None
        if not isinstance(groups, list) or not groups:
            last_error = "'groups' must be a non-empty list"
            continue

        seen_ids: set[str] = set()
        normalised: list[dict[str, Any]] = []
        ok = True
        for i, g in enumerate(groups):
            if not isinstance(g, dict):
                last_error = f"groups[{i}] must be an object"
                ok = False
                break
            name = (g.get("name") or "").strip()
            rationale = (g.get("rationale") or "").strip()
            section_ids = g.get("section_ids")
            if not name:
                last_error = f"groups[{i}].name is required"
                ok = False
                break
            if not isinstance(section_ids, list) or not section_ids:
                last_error = f"groups[{i}].section_ids must be a non-empty list"
                ok = False
                break
            cleaned_ids: list[str] = []
            for sid in section_ids:
                if not isinstance(sid, str) or sid not in valid_ids:
                    last_error = (
                        f"groups[{i}] references unknown section id {sid!r}"
                    )
                    ok = False
                    break
                if sid in seen_ids:
                    last_error = (
                        f"groups[{i}] duplicates section id {sid!r} already in another group"
                    )
                    ok = False
                    break
                seen_ids.add(sid)
                cleaned_ids.append(sid)
            if not ok:
                break
            normalised.append(
                {"name": name, "rationale": rationale, "section_ids": cleaned_ids}
            )
        if not ok:
            continue

        missing = valid_ids - seen_ids
        if missing:
            last_error = (
                f"{len(missing)} chapter(s) were not assigned to any group"
            )
            continue

        return normalised

    logger.warning(
        "chapter grouping failed after %d attempts: %s",
        _MAX_CORRECTIVE_RETRIES + 1,
        last_error,
    )
    return []


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------


def _persist_tree(
    db: Session,
    doc_id: str,
    roots: list[SkeletonNode],
) -> dict[int, str]:
    """Replace any existing sections for this document with the new
    tree. One transaction — partial trees never reach the DB.

    Returns a positional → uuid map for the top-level (root) nodes
    so the caller can pass it into the chapter-grouping pass.
    """

    document_uuid = uuid.UUID(doc_id)
    # Delete the previous tree wholesale. CASCADE on the FK takes care
    # of orphaned embeddings.
    db.execute(
        delete(DocumentSection).where(DocumentSection.document_id == document_uuid)
    )

    # Two-pass insert: nodes first (with parent FKs), embeddings
    # after (only on headlines that received a vector).
    def _insert(node: SkeletonNode, parent_uuid: uuid.UUID | None) -> uuid.UUID:
        row = DocumentSection(
            id=uuid.uuid4(),
            document_id=document_uuid,
            parent_id=parent_uuid,
            kind=node.kind,
            title=node.title,
            page_start=node.page_start,
            page_end=node.page_end,
            ordinal=node.ordinal,
            content_json=node.content_json,
        )
        db.add(row)
        db.flush()  # need id available for children's parent_id
        # If this is a headline that got an embedding, write the vector.
        if node.kind == "headline" and node.embedding is not None:
            db.add(
                DocumentSectionEmbedding(
                    section_id=row.id,
                    embedding=node.embedding,
                )
            )
        for child in node.children:
            _insert(child, row.id)
        return row.id

    root_ids: dict[int, str] = {}
    for idx, root in enumerate(roots):
        row_id = _insert(root, None)
        root_ids[idx] = str(row_id)
    db.commit()
    return root_ids


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


def run_section_mapping(db: Session, doc_id: str) -> dict[str, int]:
    """End-to-end enrichment for one document.

    Synchronous. Used by both the Celery stage and the CLI. Returns a
    small stats dict useful for logging / progress reporting.

    Sequence:
      1. Pull the document and its OCR'd pages from the DB.
      2. Build the structural skeleton from the PDF outline (fallback
         to ``nav_link`` regions).
      3. For each headline, gather page text and enrich with gpt-4o.
      4. Roll up topic / subtopic summaries from enriched children.
      5. Embed every headline's summary.
      6. Persist the whole tree in one transaction.
    """
    document = db.query(Document).filter(Document.id == uuid.UUID(doc_id)).first()
    if document is None:
        raise ValueError(f"Document {doc_id} not found")

    pages = (
        db.query(Page)
        .filter(Page.document_id == uuid.UUID(doc_id))
        .order_by(Page.page_number.asc())
        .all()
    )
    if not pages:
        raise ValueError(f"Document {doc_id} has no pages — run ingestion first")

    page_count = max(page.page_number for page in pages)
    text_by_page: dict[int, str] = {p.page_number: _page_text(p) for p in pages}

    # Step 1: skeleton from PDF outline, fallback to nav_link regions.
    try:
        pdf_bytes = download_file(f"documents/{doc_id}/original.pdf")
        roots = _extract_skeleton_from_toc(pdf_bytes, page_count)
        logger.info(
            "[%s] section skeleton built from PDF outline (%d roots)",
            doc_id,
            len(roots),
        )
    except ValueError:
        roots = _extract_skeleton_from_nav_links(pages, page_count)
        if roots:
            logger.info(
                "[%s] section skeleton built from nav_link regions (%d roots)",
                doc_id,
                len(roots),
            )
        else:
            raise RuntimeError(
                f"Document {doc_id} has neither an embedded outline nor parseable "
                "nav_link regions — section mapping cannot proceed. Re-run OCR "
                "with TOC detection or provide a manual outline."
            )

    headlines = list(_iter_headlines(roots))
    non_headlines = list(_iter_non_headlines(roots))
    logger.info(
        "[%s] section tree: %d headlines, %d topics+subtopics",
        doc_id,
        len(headlines),
        len(non_headlines),
    )

    client = _get_openai_client()

    # Step 2: enrich every headline.
    for index, headline in enumerate(headlines, start=1):
        text_lines: list[str] = []
        for page_number in range(headline.page_start, headline.page_end + 1):
            page_text = text_by_page.get(page_number, "")
            if page_text:
                text_lines.append(f"[page {page_number}]\n{page_text}")
        section_text = "\n\n".join(text_lines).strip()
        if not section_text:
            logger.warning(
                "[%s] headline %d/%d has no text content — skipping enrichment for %r",
                doc_id,
                index,
                len(headlines),
                headline.title,
            )
            headline.content_json = {
                "summary": f"{headline.title} (no readable text found).",
                "concepts_introduced": [],
                "concepts_assumed": [],
                "key_equations": [],
                "difficulty": 1,
                "type": "optional",
                "outcomes": [],
                "estimated_minutes": _ESTIMATE_MINUTES_FALLBACK,
                "hooks": [],
            }
            continue

        logger.info(
            "[%s] enriching headline %d/%d: %r (pp. %d–%d)",
            doc_id,
            index,
            len(headlines),
            headline.title,
            headline.page_start,
            headline.page_end,
        )
        headline.content_json = _enrich_headline(
            client,
            title=headline.title,
            page_start=headline.page_start,
            page_end=headline.page_end,
            section_text=section_text,
        )

    # Step 3: roll up topic / subtopic summaries (deepest first, so a
    # subtopic's rollup is available when its parent topic rolls up).
    def _rollup_recurse(node: SkeletonNode) -> None:
        for child in node.children:
            if child.kind != "headline":
                _rollup_recurse(child)
        if node.kind != "headline":
            node.content_json = _rollup_node(client, node)

    for root in roots:
        _rollup_recurse(root)

    # Step 4: embeddings for every headline.
    logger.info("[%s] generating embeddings for %d headlines", doc_id, len(headlines))
    _generate_embeddings(client, headlines)

    # Step 5: persist the full tree in one transaction.
    root_ids = _persist_tree(db, doc_id, roots)
    logger.info("[%s] section_mapping complete: tree persisted", doc_id)

    # Step 6: thematic chapter grouping. One extra LLM call clusters
    # the top-level chapters into 3-6 named groups so the mindmap can
    # render Book → Group → Chapter → Subtopic → Headline. Failure
    # here is non-fatal: the mindmap falls back to Book → Chapter.
    chapter_groups = _generate_chapter_groups(client, roots, root_ids)
    if chapter_groups:
        document.chapter_groups_json = chapter_groups
        db.commit()
        logger.info(
            "[%s] generated %d chapter group(s): %s",
            doc_id,
            len(chapter_groups),
            ", ".join(g["name"] for g in chapter_groups),
        )

    return {
        "headlines": len(headlines),
        "topics_and_subtopics": len(non_headlines),
        "embeddings": sum(1 for h in headlines if h.embedding is not None),
        "chapter_groups": len(chapter_groups),
    }
