"""
Answer engine: LangGraph orchestrator with Q&A, Calculation, and Clarification agents.

Flow:
1. Classify intent (Q&A / Calculation / Ambiguous)
2. Route to appropriate agent
3. Build response with citations
4. Generate mindmap data
"""
import json
import logging
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Any, Literal
from uuid import UUID

import httpx
import openai

from app.core.config import settings
from app.services.retrieval import RetrievalResult
from app.services.sandbox import execute_calculation

logger = logging.getLogger(__name__)
AXON_GROUP_URL = "https://axongroup.com/"

AVA_PROFILE = {
    "name": "Ava Behrouzian",
    "company": "Axon Group",
    "role": "Project Manager | Mechanical & Process Engineer",
    "location": "Mouscron, Walloon Region, Belgium",
    "about": (
        "Ava is a Mechanical and Process Engineer with a project-manager mindset: "
        "practical, curious, and drawn to industrial projects where technical ideas "
        "become real operational solutions. She has a strong interest in technical "
        "applications, entrepreneurial thinking, and new technologies, and she is "
        "known for learning fast, improving continuously, and bringing structure to "
        "complex work without making it feel heavier than it needs to be. In short: "
        "she is the kind of person who can turn a messy project into a plan before "
        "the coffee has finished cooling."
    ),
    "fun_facts": [
        "In only 8 days, she picked up website development and Figma design. Most people need a course, a calendar, and three existential crises; Ava apparently just needed a week and a bit of focus.",
    ],
}

TITLE_ICON_OPTIONS = {
    "brain": "Reasoning, concepts, AI, learning, analysis",
    "sigma": "Math, formulas, calculations, engineering quantities",
    "file": "Document summary, PDF content, report reading, source review",
    "search": "Lookup, investigation, question answering, evidence finding",
    "globe": "Web or broad external topic",
    "chart": "Performance, trends, metrics, comparison, analytics",
    "wrench": "Troubleshooting, workflow, process, practical engineering",
    "message": "General discussion, explanation, conversation",
}

STRUCTURED_RESPONSE_GUIDANCE = (
    "Always answer in the same natural language the user used in the current question, unless the user explicitly asks for translation or another language. "
    "Write polished Markdown with the voice of a mathematician, scientist, and engineer. "
    "Be precise, analytical, technically disciplined, and professionally explanatory. "
    "Make assumptions explicit, respect units and definitions, and prefer defensible reasoning over casual phrasing. "
    "Default to depth unless the user explicitly asks for brevity. "
    "Start with a short direct answer. "
    "Then use clear sections when helpful, such as ## Answer, ## Key Points, "
    "## Explanation, ## Example, ## Calculation, ## Notes, or ## Next Step. "
    "After the direct answer, explain the idea in enough detail that a serious user understands "
    "what it is, how it works, why it matters, and where it applies. "
    "Do not stop at naming items; explain each item with at least one concrete detail, implication, or example. "
    "Prefer short paragraphs and flat bullet lists over long prose, but keep the content substantive. "
    "Keep the response scannable, similar to a high-quality assistant answer. "
    "When the sources or the question contain formulas, units, numeric values, engineering relationships, "
    "or any quantitative concept, include a short worked example, quick check, sanity check, or mini-calculation "
    "even if the user did not explicitly ask for one. "
    "If exact values are not available, provide a clearly labeled illustrative example and say it is illustrative. "
    "Write mathematical formulas, equations, and expressions as proper LaTeX math using inline $...$ or display $$...$$ notation. "
    "Do not leave equations as raw backslash text or plain prose when they can be formatted as math. "
    "Do not invent document facts or citations. "
    "Attach inline citations as numbered references like [1], [2], or [3] immediately after the factual sentence or clause they support."
)


@dataclass
class Citation:
    id: str
    source_type: str  # "pdf" or "web"
    document_id: UUID | None = None
    document_name: str = ""
    page: int = 0
    bbox: list | None = None
    boxes: list[list[float]] | None = None
    snippet: str = ""
    url: str | None = None
    title: str | None = None


@dataclass
class AnswerStep:
    step: str
    citation: Citation | None = None
    grounded: bool = False


@dataclass
class AnswerSection:
    type: str  # "explanation", "calculation", "clarification"
    content: str = ""
    steps: list[AnswerStep] = field(default_factory=list)
    grounded: bool = False


@dataclass
class MindmapNode:
    id: str
    label: str
    node_type: str  # "answer", "pdf_source", "web_source", "user_input", "model_reasoning"
    source: Citation | None = None
    children: list["MindmapNode"] = field(default_factory=list)


@dataclass
class AnswerResponse:
    text: str
    sections: list[AnswerSection] = field(default_factory=list)
    citations: list[Citation] = field(default_factory=list)
    visualizations: list[dict[str, Any]] = field(default_factory=list)
    mindmap: MindmapNode | None = None
    warnings: list[str] = field(default_factory=list)
    needs_clarification: bool = False
    clarification_question: str = ""


class _VisibleTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._skip_depth = 0
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in {"script", "style", "noscript"}:
            self._skip_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript"} and self._skip_depth:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        cleaned = " ".join(data.split())
        if cleaned:
            self._parts.append(cleaned)

    def text(self) -> str:
        seen: set[str] = set()
        ordered: list[str] = []
        for part in self._parts:
            if part not in seen:
                seen.add(part)
                ordered.append(part)
        return "\n".join(ordered)


def _get_client() -> openai.OpenAI:
    return openai.OpenAI(api_key=settings.openai_api_key)


def detect_query_language(query: str) -> str:
    client = _get_client()
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        max_tokens=20,
        messages=[
            {
                "role": "system",
                "content": (
                "Identify the primary natural language of the user's message. "
                "Reply with only the language name in English, such as English, Persian, German, Arabic, or French. "
                "Distinguish Persian from Arabic carefully. "
                "If the text is Persian/Farsi written in Persian script, return Persian, not Arabic. "
                "If the message is mixed, return the dominant language."
            ),
            },
            {"role": "user", "content": query},
        ],
    )
    language = (response.choices[0].message.content or "").strip()
    return language or "English"


def language_instruction_for_query(query: str) -> str:
    language = detect_query_language(query)
    if language.lower() == "persian":
        return (
            "The user's current question is written primarily in Persian (Farsi). "
            "Respond fully in Persian (Farsi). Do not switch to Arabic or English except for unavoidable proper nouns, formulas, or file names."
        )
    return (
        f"The user's current question is written primarily in {language}. "
        f"Respond fully in {language} unless the user explicitly asks for another language."
    )


def _normalize_bbox_references(bboxes: list[list[float]] | None) -> list[list[float]]:
    valid_bboxes = [
        bbox
        for bbox in (bboxes or [])
        if isinstance(bbox, list) and len(bbox) == 4
    ]
    return [
        [
            round(float(bbox[0]), 2),
            round(float(bbox[1]), 2),
            round(float(bbox[2]), 2),
            round(float(bbox[3]), 2),
        ]
        for bbox in valid_bboxes
    ]


def _merge_bbox_references(bboxes: list[list[float]] | None) -> list[float] | None:
    valid_bboxes = _normalize_bbox_references(bboxes)
    if not valid_bboxes:
        return None

    return [
        round(min(bbox[0] for bbox in valid_bboxes), 2),
        round(min(bbox[1] for bbox in valid_bboxes), 2),
        round(max(bbox[2] for bbox in valid_bboxes), 2),
        round(max(bbox[3] for bbox in valid_bboxes), 2),
    ]


def _build_citations(results: list[RetrievalResult]) -> list[Citation]:
    """Convert retrieval results to citation objects."""
    citations = []
    for i, r in enumerate(results):
        boxes = _normalize_bbox_references(r.bbox_references)
        cite = Citation(
            id=f"cite-{i + 1}",
            source_type=r.source_type,
            document_id=r.document_id,
            document_name=r.document_name,
            page=r.page_number,
            bbox=_merge_bbox_references(boxes),
            boxes=boxes or None,
            snippet=r.content[:200],
            url=r.url,
            title=r.title,
        )
        citations.append(cite)
    return citations


def _normalize_inline_citation_labels(text: str) -> str:
    normalized = text
    normalized = re.sub(r"\[(?:N|n)\]", "[1]", normalized)
    normalized = re.sub(r"\((?:N|n)\)", "[1]", normalized)
    normalized = re.sub(r"\bSource\s+(?:N|n)\b", "[1]", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"\[Source\s+(\d+)\]", r"[\1]", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"\(Source\s+(\d+)\)", r"[\1]", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"(?<!\[)\bSource\s+(\d+)\b", r"[\1]", normalized, flags=re.IGNORECASE)
    return normalized


def _strip_empty_missing_information_section(text: str) -> str:
    patterns = [
        r"(?is)\n{0,2}##\s*Missing information\s*\n+"
        r"(?:[-*]\s*)?(?:No additional information is required\.?|Missing information:\s*none identified.*?|"
        r"No missing information.*?|None identified\.?|No further information is required\.?)\s*",
        r"(?is)\n{0,2}###\s*Missing information\s*\n+"
        r"(?:[-*]\s*)?(?:No additional information is required\.?|Missing information:\s*none identified.*?|"
        r"No missing information.*?|None identified\.?|No further information is required\.?)\s*",
    ]
    cleaned = text
    for pattern in patterns:
        cleaned = re.sub(pattern, "\n\n", cleaned)
    return re.sub(r"\n{3,}", "\n\n", cleaned).strip()


def ensure_inline_citation_references(text: str, citations: list[Citation], max_refs: int = 4) -> str:
    if not citations:
        return text

    normalized = _normalize_inline_citation_labels(text)

    if re.search(r"\[\d+\]", normalized):
        return normalized

    refs = "".join(f"[{index}]" for index in range(1, min(len(citations), max_refs) + 1))
    stripped = normalized.rstrip()
    if not stripped:
        return stripped

    paragraph_break = stripped.find("\n\n")
    if paragraph_break != -1:
        head = stripped[:paragraph_break].rstrip()
        tail = stripped[paragraph_break:]
        return f"{head} {refs}{tail}"

    return f"{stripped} {refs}"


def _reindex_citation_references(
    text: str,
    citations: list[Citation],
    used_source_indices: list[int] | None,
) -> tuple[str, list[Citation]]:
    if not citations:
        return text, citations

    if not used_source_indices:
        return text, citations

    ordered_unique = []
    seen: set[int] = set()
    for raw_index in used_source_indices:
        try:
            index = int(raw_index)
        except Exception:
            continue
        if index < 1 or index > len(citations) or index in seen:
            continue
        seen.add(index)
        ordered_unique.append(index)

    if not ordered_unique:
        return text, citations

    index_map = {old_index: new_index for new_index, old_index in enumerate(ordered_unique, start=1)}
    remapped_text = text
    for old_index, new_index in sorted(index_map.items(), reverse=True):
        remapped_text = re.sub(rf"\[Source\s+{old_index}\]", f"[{new_index}]", remapped_text, flags=re.IGNORECASE)
        remapped_text = re.sub(rf"\(Source\s+{old_index}\)", f"[{new_index}]", remapped_text, flags=re.IGNORECASE)
        remapped_text = re.sub(rf"(?<!\[)\bSource\s+{old_index}\b", f"[{new_index}]", remapped_text, flags=re.IGNORECASE)
        remapped_text = re.sub(rf"\[{old_index}\]", f"[{new_index}]", remapped_text)

    remapped_citations = [citations[old_index - 1] for old_index in ordered_unique]
    return remapped_text, remapped_citations


def _citation_location_key(citation: Citation) -> tuple[str, str, int]:
    source_ref = ""
    if citation.source_type == "pdf":
        source_ref = str(citation.document_id or citation.document_name or "")
    else:
        source_ref = str(citation.url or citation.title or "")
    return (citation.source_type, source_ref, int(citation.page or 0))


def _merge_citation_pair(existing: Citation, incoming: Citation) -> Citation:
    merged_boxes = _normalize_bbox_references((existing.boxes or []) + (incoming.boxes or []))
    return Citation(
        id=existing.id,
        source_type=existing.source_type,
        document_id=existing.document_id or incoming.document_id,
        document_name=existing.document_name or incoming.document_name,
        page=existing.page or incoming.page,
        bbox=_merge_bbox_references(merged_boxes) or existing.bbox or incoming.bbox,
        boxes=merged_boxes or existing.boxes or incoming.boxes,
        snippet=existing.snippet if len(existing.snippet) >= len(incoming.snippet) else incoming.snippet,
        url=existing.url or incoming.url,
        title=existing.title or incoming.title,
    )


def _deduplicate_citation_references(text: str, citations: list[Citation]) -> tuple[str, list[Citation]]:
    if not citations:
        return text, citations

    deduped: list[Citation] = []
    key_to_new_index: dict[tuple[str, str, int], int] = {}
    old_to_new: dict[int, int] = {}

    for old_index, citation in enumerate(citations, start=1):
        key = _citation_location_key(citation)
        existing_index = key_to_new_index.get(key)
        if existing_index is None:
            next_index = len(deduped) + 1
            key_to_new_index[key] = next_index
            old_to_new[old_index] = next_index
            deduped.append(citation)
            continue

        old_to_new[old_index] = existing_index
        deduped[existing_index - 1] = _merge_citation_pair(deduped[existing_index - 1], citation)

    remapped_text = text
    for old_index in range(len(citations), 0, -1):
        new_index = old_to_new[old_index]
        remapped_text = re.sub(rf"\[{old_index}\]", f"[{new_index}]", remapped_text)

    remapped_text = re.sub(r"(\[(\d+)\])(?:\s*\[\2\])+", r"\1", remapped_text)
    remapped_text = re.sub(r"(\[(\d+)\])(?:\s*,\s*\[\2\])+", r"\1", remapped_text)
    remapped_text = re.sub(r"\s{2,}", " ", remapped_text)

    for new_index, citation in enumerate(deduped, start=1):
        citation.id = f"cite-{new_index}"

    return remapped_text, deduped


def _sanitize_conversation_title(title: str, fallback_query: str) -> str:
    cleaned = " ".join((title or "").replace("\n", " ").split()).strip(" -:.,")
    if cleaned:
        return cleaned[:48]
    fallback = " ".join(fallback_query.split()).strip(" -:.,")
    return (fallback[:48] or "New chat")


def generate_conversation_metadata(query: str, mode: str) -> tuple[str, str]:
    client = _get_client()
    options_text = "\n".join(f"- {key}: {description}" for key, description in TITLE_ICON_OPTIONS.items())
    response = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=120,
        messages=[
            {
                "role": "system",
                "content": (
                    "Create a very short chat title and choose one icon key for a sidebar. "
                    "The title must be 2 to 5 words, specific, professional, and not a copy of the full question. "
                    "Avoid punctuation unless necessary. "
                    "Reply only as JSON with keys title and icon."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Mode: {mode}\n"
                    f"Question: {query}\n\n"
                    "Allowed icon keys:\n"
                    f"{options_text}"
                ),
            },
        ],
    )

    title = ""
    icon = "message"

    try:
        content = response.choices[0].message.content or ""
        json_str = content[content.index("{"):content.rindex("}") + 1]
        payload = json.loads(json_str)
        title = _sanitize_conversation_title(str(payload.get("title", "")), query)
        candidate_icon = str(payload.get("icon", "")).strip().lower()
        if candidate_icon in TITLE_ICON_OPTIONS:
            icon = candidate_icon
    except Exception:
        title = _sanitize_conversation_title("", query)
        if any(token in query.lower() for token in ("calculate", "equation", "formula", "pressure", "flow")):
            icon = "sigma"
        elif mode == "deep_search":
            icon = "globe"
        elif any(token in query.lower() for token in ("pdf", "document", "report", "file")):
            icon = "file"
        elif any(token in query.lower() for token in ("why", "how", "explain", "what")):
            icon = "brain"

    return title, icon


def generate_welcome_payload(
    *,
    group_name: str | None,
    documents: list[dict[str, Any]],
) -> dict[str, Any]:
    def _sanitize_welcome_intro(text: str) -> str:
        cleaned = text
        # Remove cutoff/date-style capability disclaimers from onboarding copy.
        cleaned = re.sub(
            r"(?im)^.*?(training data|trained up to|knowledge cutoff|capabilities are aligned.*?up to|up to\s+[A-Z][a-z]+\s+\d{4}).*$\n?",
            "",
            cleaned,
        )
        cleaned = re.sub(
            r"(?is)\b(?:Please note that\s+)?Maia AI'?s capabilities.*?(?:October|November|December|January|February|March|April|May|June|July|August|September)\s+\d{4}\.?",
            "",
            cleaned,
        )
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
        return cleaned.strip()

    client = _get_client()
    prompt_payload = {
        "group_name": group_name,
        "documents": documents,
    }

    try:
        response = client.chat.completions.create(
            model="gpt-4o",
            max_tokens=1200,
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are Maia AI's onboarding writer for an Axon Group engineering workspace. "
                        "Return valid JSON with keys intro_markdown and suggested_questions. "
                        "Write professionally and clearly. "
                        "The introduction must briefly explain that Maia AI is being developed and trained by Axon Group to assist with technical questions grounded in uploaded documents and general technical reasoning. "
                        "The introduction must act as onboarding, not as a library summary. "
                        "Teach the user how to use Maia: how to choose a group with #, how to target specific PDFs with @, how to open Library and upload files, and that documents should be Ready before grounded questions are asked. "
                        "Teach the user how to ask good first questions, such as definitions, summaries, calculations, comparisons, troubleshooting, formulas, and source-backed questions. "
                        "Do not summarise the available books or PDFs. "
                        "Do not produce per-book bullets or one-sentence book descriptions. "
                        "You may mention the active group name and how many ready PDFs are available. "
                        "The tone must sound like a serious technical assistant, not marketing copy. "
                        "Do not mention today's date, training data cutoffs, knowledge cutoffs, model release dates, or any statement such as 'up to October 2023'. "
                        "Generate 5 to 7 suggested first questions that help a user start using Maia well in this workspace. "
                        "Keep them document-grounded and practical. "
                        "Keep each suggested question concise, practical, and professional. "
                        "The intro_markdown must be valid Markdown and should preferably contain short paragraphs plus a short bullet list of usage guidance."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        "Generate the welcome payload for this workspace state as JSON.\n\n"
                        f"{json.dumps(prompt_payload, indent=2)}"
                    ),
                },
            ],
        )
        payload = json.loads(response.choices[0].message.content or "{}")
        intro = str(payload.get("intro_markdown", "") or "").strip()
        questions = [
            str(item).strip()
            for item in payload.get("suggested_questions", [])
            if isinstance(item, str) and str(item).strip()
        ]
        intro = _sanitize_welcome_intro(intro)
        if intro and questions:
            return {
                "intro_markdown": intro,
                "suggested_questions": questions[:7],
            }
    except Exception as exc:
        logger.warning("Failed to generate welcome payload with LLM: %s", exc)

    document_count = len(documents)
    fallback_questions = [
        "What is the best way to ask you a document-grounded question in this workspace?",
        "Which PDF should I target first for this topic?",
        "Summarise this document section and cite the pages you used.",
        "What formula or engineering relationship is most relevant here?",
        "Compare the approaches described in these PDFs and cite the evidence.",
        "What should I read first if I am new to this topic?",
    ]
    return {
        "intro_markdown": (
            f"Welcome to the Axon Group engineering workspace"
            f"{f' for {group_name}' if group_name else ''}.\n\n"
            "Maia AI is being developed and trained by Axon Group to support technical reasoning, "
            "document-grounded answers, calculations, and engineering analysis.\n\n"
            "### How to use Maia\n"
            "- Use `#` in the composer to choose the right group before asking document-grounded questions.\n"
            "- Use `@` after selecting a group to target one or more specific PDFs.\n"
            "- Open **Library** to upload PDFs, organize groups, and review what is available.\n"
            "- Wait until a document shows **Ready** before relying on it for grounded answers.\n"
            "- Ask clear questions such as definitions, summaries, comparisons, calculations, troubleshooting, or \"show me the supporting pages\".\n\n"
            "### Good first questions\n"
            "- What does this document say about this topic, and which pages support it?\n"
            "- Summarise this section and cite the pages you used.\n"
            "- Compare the methods described in these PDFs.\n"
            "- Show me the formula, variables, and assumptions for this calculation.\n"
            "- Which part of the library should I read first for this question?\n\n"
            f"There {'is' if document_count == 1 else 'are'} currently **{document_count}** ready PDF{'s' if document_count != 1 else ''} available in this workspace."
        ),
        "suggested_questions": fallback_questions,
    }


def is_structural_listing_sources(sources: list[RetrievalResult]) -> bool:
    if not sources:
        return False
    return all(source.chunk_type in {"toc_entry", "index_entry"} for source in sources)


def structural_listing_agent(sources: list[RetrievalResult]) -> AnswerResponse:
    citations = _build_citations(sources)
    first = sources[0]
    is_toc = first.chunk_type == "toc_entry"
    heading = "Table of Contents" if is_toc else "Index"
    intro = f"## {heading}\nFrom **{first.document_name}**.\n"
    lines = []
    for source, citation in zip(sources, citations, strict=False):
        label = source.content.strip()
        lines.append(f"- {label} - [{citation.page}](citation:{citation.id})")

    body = "\n".join(lines)
    return AnswerResponse(
        text=f"{intro}\n{body}".strip(),
        sections=[AnswerSection(type="explanation", content=body, grounded=True)],
        citations=citations,
    )


def _format_sources_for_prompt(results: list[RetrievalResult]) -> str:
    """Format retrieval results as context for the LLM prompt."""
    parts = []
    for i, r in enumerate(results):
        header = f"[{i + 1}]"
        if r.source_type == "pdf":
            header += f" {r.document_name}, page {r.page_number}"
            if r.ocr_confidence and r.ocr_confidence < 0.7:
                header += " (LOW OCR CONFIDENCE)"
        else:
            header += f" {r.title} ({r.url})"

        content = r.content
        if r.latex:
            content += f"\nLaTeX: {r.latex}"
        if r.variables:
            content += f"\nVariables: {json.dumps(r.variables)}"

        parts.append(f"{header}\n{content}")

    return "\n\n---\n\n".join(parts)


def _verify_grounded_answer(
    *,
    query: str,
    answer_text: str,
    sources: list[RetrievalResult],
    search_mode: str,
) -> tuple[list[int], list[str]]:
    if not sources or not answer_text.strip():
        return [], []

    client = _get_client()
    verification_sources = _format_sources_for_prompt(sources)
    mode_policy = (
        "In Library mode, keep only claims that are directly supported by the provided PDF sources."
        if search_mode == "library"
        else "In Deep Search mode, keep only claims that are directly supported by the provided PDF or web sources."
    )

    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            max_tokens=500,
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a grounding verifier. "
                        f"{mode_policy} "
                        "Return valid JSON with keys verified_sources and unsupported_claims. "
                        "verified_sources must be an array of source numbers that truly support the answer text. "
                        "unsupported_claims must be an array of short claim summaries that are not adequately supported. "
                        "Be strict. Do not include weakly related sources."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"QUESTION:\n{query}\n\n"
                        f"ANSWER:\n{answer_text}\n\n"
                        f"SOURCES:\n{verification_sources}"
                    ),
                },
            ],
        )
        payload = json.loads(response.choices[0].message.content or "{}")
        verified_sources = [
            int(item)
            for item in payload.get("verified_sources", [])
            if str(item).strip().isdigit()
        ]
        unsupported_claims = [
            str(item).strip()
            for item in payload.get("unsupported_claims", [])
            if str(item).strip()
        ]
        return verified_sources, unsupported_claims
    except Exception:
        return [], []


# ---- Intent Classification ----


def classify_intent(
    query: str, sources: list[RetrievalResult]
) -> Literal["qa", "calculation", "ambiguous"]:
    """Classify user intent: Q&A, Calculation, or Ambiguous."""
    client = _get_client()

    has_equations = any(r.chunk_type == "equation" for r in sources)
    source_summary = f"Sources contain {'equations/formulas' if has_equations else 'text/tables/figures'}"

    response = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=50,
        messages=[{
            "role": "user",
            "content": (
                f"Classify this question into exactly one category.\n\n"
                f"Question: {query}\n"
                f"{source_summary}\n\n"
                "Categories:\n"
                "- 'qa' = user wants information, explanation, or lookup\n"
                "- 'calculation' = user wants a numeric computation using formulas or values\n"
                "- 'ambiguous' = question is unclear or missing critical information\n\n"
                "Reply with ONLY the category name, nothing else."
            ),
        }],
    )

    intent = response.choices[0].message.content.strip().lower().strip("'\"")
    if intent not in ("qa", "calculation", "ambiguous"):
        intent = "qa"
    return intent


def classify_ava_question(query: str, conversation_history: list[dict] | None = None) -> bool:
    """Detect questions about Ava Behrouzian from Maia's internal people knowledge."""
    normalized = query.lower()
    if re.search(r"\bava(?:\s+behrouzian)?\b", normalized):
        return True

    recent_context = " ".join(
        str(message.get("content", ""))
        for message in (conversation_history or [])[-4:]
    ).lower()
    if "ava" not in recent_context:
        return False

    return bool(
        re.search(
            r"\b(?:who is she|what does she do|what is her role|where is she|her job|her position|does she)\b",
            normalized,
        )
    )


def classify_identity_question(query: str) -> bool:
    """Use the LLM to detect identity/about/capability questions about Maia/Axon."""
    client = _get_client()
    response = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=10,
        messages=[{
            "role": "system",
            "content": (
                "Decide whether the user is asking an identity question about the assistant. "
                "Identity questions include who you are, what you are, your role, your purpose, "
                "what you can help with, who made you, or what company you belong to. "
                "The user's question may be written in any language, including Persian. "
                "Examples of identity questions include phrases equivalent to 'who are you', 'what are you', "
                "'what can you help with', or 'who built you'. "
                "Persian examples that should count as YES include phrases equivalent to 'تو کی هستی', "
                "'شما چه کاری می توانید انجام دهید', or 'چه کسی تو را ساخته است'. "
                "If the user is directly addressing you with second-person wording and asking about identity, role, capability, creator, or affiliation, answer YES. "
                "Only answer YES if the question is explicitly about the assistant, Maia, you as the assistant, "
                "or Axon Group in relation to the assistant. "
                "Generic prompts such as 'what is this', 'what is in this image', 'who is this', "
                "'explain this', or questions about an attached file, PDF, image, or external subject are NO. "
                "Reply with only YES or NO."
            ),
        }, {
            "role": "user",
            "content": query,
        }],
    )
    decision = (response.choices[0].message.content or "").strip().upper()
    return decision == "YES"


def classify_axon_group_question(query: str) -> bool:
    client = _get_client()
    response = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=10,
        messages=[{
            "role": "system",
            "content": (
                "Decide whether the user is specifically asking about Axon Group as a company or organization. "
                "Examples: what is Axon Group, tell me about Axon Group, what does Axon Group do, "
                "describe Axon Group, who is Axon Group. "
                "Reply with only YES or NO."
            ),
        }, {
            "role": "user",
            "content": query,
        }],
    )
    decision = (response.choices[0].message.content or "").strip().upper()
    return decision == "YES"


def _fetch_axon_group_site_text() -> tuple[str, str]:
    response = httpx.get(
        AXON_GROUP_URL,
        headers={"User-Agent": "Maia-Axon/1.0"},
        timeout=20.0,
        follow_redirects=True,
    )
    response.raise_for_status()
    parser = _VisibleTextExtractor()
    parser.feed(response.text)
    parser.close()
    page_text = parser.text()
    return page_text[:12000], response.url.__str__()


def axon_group_agent(query: str, conversation_history: list[dict]) -> AnswerResponse:
    client = _get_client()
    language_instruction = language_instruction_for_query(query)
    page_text, resolved_url = _fetch_axon_group_site_text()
    citation = Citation(
        id="cite-1",
        source_type="web",
        url=resolved_url,
        title="Axon Group | Industrial solutions square",
        snippet=page_text[:200],
    )

    messages = []
    for msg in conversation_history[-6:]:
        messages.append({"role": msg["role"], "content": msg["content"]})
    messages.append({"role": "user", "content": query})

    response = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=700,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are Maia Axon. Answer questions about Axon Group using only the supplied official website content. "
                    f"{language_instruction} "
                    "Write professionally, like a mathematician, scientist, and engineer would: precise, structured, and factual. "
                    "Do not invent facts beyond the website text. "
                    "Use inline citation [1] for factual claims drawn from the official site."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"OFFICIAL AXON GROUP WEBSITE CONTENT:\n{page_text}\n\n"
                    f"QUESTION: {query}"
                ),
            },
            *messages,
        ],
    )

    answer_text = ensure_inline_citation_references(
        (response.choices[0].message.content or "").strip(),
        [citation],
        max_refs=1,
    )
    return AnswerResponse(
        text=answer_text,
        sections=[AnswerSection(type="explanation", content=answer_text, grounded=True)],
        citations=[citation],
    )


def ava_agent(query: str, conversation_history: list[dict]) -> AnswerResponse:
    """Answer questions about Ava Behrouzian from the internal profile provided to Maia."""
    client = _get_client()
    language_instruction = language_instruction_for_query(query)
    messages = []
    for msg in conversation_history[-6:]:
        messages.append({"role": msg["role"], "content": msg["content"]})
    messages.append({"role": "user", "content": query})

    response = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=500,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are Maia Axon. Answer questions about Ava Behrouzian using only the internal profile below. "
                    f"{language_instruction} "
                    "If the user asks who Ava is, explain her role at Axon Group and summarize her professional background. "
                    "If the user asks what she does, describe her as a Project Manager and Mechanical & Process Engineer. "
                    "Make the phrasing polished, catchy, and human, while staying professional. "
                    "Use a funny, witty tone when it fits naturally, but keep it respectful, kind, and workplace-appropriate. "
                    "A good answer can include one or two playful lines about her fast learning, project-manager energy, curiosity, or technical mindset. "
                    "Do not make jokes about appearance, nationality, personal life, stereotypes, or anything sensitive. "
                    "If the user asks for details not present in the profile, say that Maia only has the current profile details. "
                    "Do not invent career history, contact details, personal information, or claims beyond the profile. "
                    "Do not use citations. Keep the answer concise, professional, and useful.\n\n"
                    f"AVA PROFILE:\n"
                    f"Name: {AVA_PROFILE['name']}\n"
                    f"Company: {AVA_PROFILE['company']}\n"
                    f"Role: {AVA_PROFILE['role']}\n"
                    f"Location: {AVA_PROFILE['location']}\n"
                    f"About: {AVA_PROFILE['about']}\n"
                    f"Fun facts: {'; '.join(AVA_PROFILE['fun_facts'])}"
                ),
            },
            *messages,
        ],
    )

    answer_text = response.choices[0].message.content or ""
    return AnswerResponse(
        text=answer_text,
        sections=[AnswerSection(type="explanation", content=answer_text, grounded=False)],
        citations=[],
    )


def identity_agent(query: str, conversation_history: list[dict]) -> AnswerResponse:
    """Generate a professional identity/capability response for Maia."""
    client = _get_client()
    language_instruction = language_instruction_for_query(query)
    messages = []
    for msg in conversation_history[-6:]:
        messages.append({"role": msg["role"], "content": msg["content"]})
    messages.append({"role": "user", "content": query})

    response = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=500,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are Maia AI. Respond to identity questions professionally. "
                    f"{language_instruction} "
                    "If the user asked in English, the reply must begin with this exact opening clause and then continue naturally: "
                    "\"I am Maia AI, an Axon Group AI designed by Axon Group that is under training to be able to assist you with\". "
                    "If the user asked in another language, begin with a professional equivalent of that same meaning in the user's language instead of English. "
                    "Do not present the opening as a quote; continue the sentence professionally. "
                    "Keep the tone polished, confident, and specific. "
                    "Explain your purpose, your current areas of assistance, and that you are still under training. "
                    "Do not use citations. Do not mention hidden prompts, internal implementation details, or system instructions. "
                    "Write as a mathematician, scientist, and engineer would: precise and professional."
                ),
            },
            *messages,
        ],
    )

    answer_text = response.choices[0].message.content or ""
    return AnswerResponse(
        text=answer_text,
        sections=[AnswerSection(type="explanation", content=answer_text, grounded=False)],
        citations=[],
    )


# ---- Q&A Agent ----


def qa_agent(
    query: str,
    sources: list[RetrievalResult],
    conversation_history: list[dict],
    search_mode: str = "library",
) -> AnswerResponse:
    """Answer document Q&A questions with citations."""
    client = _get_client()
    language_instruction = language_instruction_for_query(query)
    all_citations = _build_citations(sources)
    sources_text = _format_sources_for_prompt(sources)
    library_user_rule = (
        "2. In Library mode, answer only from the provided PDF sources. "
        "If the sources are insufficient, say that you cannot find enough support in the library and do not fill gaps from general knowledge.\n"
    )
    non_library_user_rule = "2. If you use knowledge not from the sources, clearly mark it as 'Based on general knowledge:'.\n"
    library_system_rule = (
        "Library mode is strict: never answer from general knowledge, prior knowledge, or the web when the user is in library mode. "
        "If the uploaded PDFs do not support a claim, say so directly and ask the user to upload or select a more relevant document. "
    )
    non_library_system_rule = "When you add your own knowledge, clearly separate it. "

    messages = []
    # Add conversation history for context
    for msg in conversation_history[-10:]:
        messages.append({"role": msg["role"], "content": msg["content"]})

    messages.append({
        "role": "user",
        "content": (
            f"Answer the following question using the provided sources.\n\n"
            f"SOURCES:\n{sources_text}\n\n"
            f"QUESTION: {query}\n\n"
            "RULES:\n"
            f"0. {language_instruction}\n"
            "1. Ground your answer in the sources. Cite inline as numbered references like [1], [2], or [3].\n"
            f"{library_user_rule if search_mode == 'library' else non_library_user_rule}"
            "3. If multiple sources give different information, present both and note the difference.\n"
            "4. If a source has LOW OCR CONFIDENCE, warn the user to verify visually.\n"
            "5. Be thorough and practically useful, not minimal.\n"
            "6. Explain ideas, not just labels. For each major point, add concrete detail, mechanism, implication, or example.\n"
            "7. If the topic supports it, add a short worked example, quick estimate, unit check, or mini-calculation.\n"
            "8. Unless the user asks for a short answer, prefer a fuller explanation over a terse list.\n"
            "9. Only cite a source section if that exact retrieved section supports the sentence.\n"
            "10. Do not cite unused sources. Do not guess where support came from.\n"
            f"11. {STRUCTURED_RESPONSE_GUIDANCE}"
        ),
    })

    messages.insert(0, {
        "role": "system",
        "content": (
            "You are Maia Axon, a technical document assistant. You answer questions "
            "using uploaded PDFs as the primary source of truth. Always cite your sources. "
            f"{language_instruction} "
            "When information comes from the documents, use inline numbered citations like [1], [2], or [3]. "
            f"{library_system_rule if search_mode == 'library' else non_library_system_rule}"
            "Always sound like a mathematician, scientist, and engineer: rigorous, exact, and technically grounded. "
            "Look for chances to make the answer more useful with a compact example, quick calculation, "
            "or engineering sanity check when the material supports it. "
            "You must be able to account for every citation you output. "
            f"{STRUCTURED_RESPONSE_GUIDANCE}"
        ),
    })

    response = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=4096,
        response_format={"type": "json_object"},
        messages=messages + [
            {
                "role": "assistant",
                "content": (
                    "Return valid JSON with keys answer_markdown, used_sources, and unsupported_claims. "
                    "answer_markdown must contain the final user-visible answer in Markdown. "
                    "used_sources must be an array of source numbers actually used in the answer, such as [1, 3]. "
                    "unsupported_claims must list any parts of the user's request that were not fully supported by the sources. "
                    "Do not include a source number unless the answer really used that source."
                ),
            }
        ],
    )

    raw_content = response.choices[0].message.content or ""
    try:
        payload = json.loads(raw_content)
        answer_text = str(payload.get("answer_markdown", "") or "").strip()
        used_sources = payload.get("used_sources", [])
        unsupported_claims = [
            str(item).strip()
            for item in payload.get("unsupported_claims", [])
            if str(item).strip()
        ]
    except Exception:
        answer_text = raw_content.strip()
        used_sources = []
        unsupported_claims = []

    answer_text, citations = _reindex_citation_references(answer_text, all_citations, used_sources)
    verified_sources, verifier_unsupported_claims = _verify_grounded_answer(
        query=query,
        answer_text=answer_text,
        sources=[
            sources[index - 1]
            for index in used_sources
            if isinstance(index, int) and 1 <= index <= len(sources)
        ] or sources,
        search_mode=search_mode,
    )
    if verified_sources:
        answer_text, citations = _reindex_citation_references(answer_text, citations, verified_sources)
    unsupported_claims.extend(
        claim for claim in verifier_unsupported_claims if claim not in unsupported_claims
    )
    answer_text, citations = _deduplicate_citation_references(answer_text, citations)
    answer_text = ensure_inline_citation_references(answer_text, citations)

    # Check for OCR warnings
    warnings = []
    for citation in citations:
        matching_source = next(
            (
                source
                for source in sources
                if source.document_id == citation.document_id and source.page_number == citation.page
            ),
            None,
        )
        if matching_source and matching_source.ocr_confidence and matching_source.ocr_confidence < 0.7:
            warnings.append(
                f"Source from {matching_source.document_name} page {matching_source.page_number} has low OCR confidence "
                f"({matching_source.ocr_confidence:.0%}) — verify the content visually."
            )
    if unsupported_claims:
        warnings.append(
            "Some parts of the answer could not be fully supported from the selected sources."
        )

    return AnswerResponse(
        text=answer_text,
        sections=[AnswerSection(type="explanation", content=answer_text, grounded=True)],
        citations=citations,
        warnings=warnings,
    )


# ---- Calculation Agent ----


def calculation_agent(
    query: str,
    sources: list[RetrievalResult],
    conversation_history: list[dict],
) -> AnswerResponse:
    """Handle calculation questions: extract formulas, identify variables, compute."""
    client = _get_client()
    language_instruction = language_instruction_for_query(query)
    citations = _build_citations(sources)
    sources_text = _format_sources_for_prompt(sources)

    # Step 1: Ask LLM to set up the calculation
    setup_response = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=4096,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a technical calculation assistant with the mindset of a mathematician, scientist, and engineer. Your job is to:\n"
                    f"{language_instruction}\n"
                    "1. Identify the relevant formula(s) from the sources\n"
                    "2. List all variables needed\n"
                    "3. Match variables to values from the user's question\n"
                    "4. If multiple methods exist in different sources, note all of them\n"
                    "5. If any required value is missing, say MISSING: <variable name>\n"
                    "6. Write Python code to perform the calculation\n\n"
                    "Respond in this JSON format:\n"
                    '{"formulas": [{"source": "[1]", "latex": "...", "description": "..."}],\n'
                    ' "variables": [{"name": "...", "value": ..., "unit": "...", "source": "[1] or user"}],\n'
                    ' "missing_variables": ["var1", "var2"],\n'
                    ' "python_code": "# calculation code\\nresult = ...",\n'
                    ' "multiple_methods": false,\n'
                    ' "method_comparison": ""}'
                ),
            },
            {
                "role": "user",
                "content": (
                    f"SOURCES:\n{sources_text}\n\n"
                    f"QUESTION: {query}\n\n"
                    "Set up the calculation. Use formulas from the sources. "
                    "Use values from the user's question. Flag any missing values."
                ),
            },
        ],
    )

    setup_text = setup_response.choices[0].message.content.strip()

    # Parse the setup
    try:
        if "{" in setup_text:
            json_str = setup_text[setup_text.index("{"):setup_text.rindex("}") + 1]
            setup = json.loads(json_str)
        else:
            setup = {"python_code": "", "missing_variables": [], "formulas": []}
    except json.JSONDecodeError:
        setup = {"python_code": "", "missing_variables": [], "formulas": []}

    def _format_formula_items() -> list[dict[str, str]]:
        items = []
        for formula in setup.get("formulas", []):
            items.append({
                "formula": formula.get("latex") or formula.get("description") or "Relevant formula",
                "source": formula.get("source", ""),
                "description": formula.get("description", ""),
            })
        return items

    def _format_variable_items() -> list[dict[str, str]]:
        items = []
        for var in setup.get("variables", []):
            items.append({
                "name": str(var.get("name", "variable")),
                "value": str(var.get("value", "?")),
                "unit": str(var.get("unit", "")),
                "source": str(var.get("source", "")),
            })
        return items

    def _generate_calculation_fallback(
        *,
        mode: str,
        blocker: str,
        missing_variables: list[str],
    ) -> str:
        fallback_payload = {
            "question": query,
            "mode": mode,
            "formulas": _format_formula_items(),
            "variables": _format_variable_items(),
            "missing_variables": missing_variables,
            "blocker": blocker,
        }

        response = client.chat.completions.create(
            model="gpt-4o",
            max_tokens=1200,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are Maia Axon, a professional technical calculation assistant. "
                        f"{language_instruction} "
                        "Write like a mathematician, scientist, and engineer: rigorous, exact, and technically clear. "
                        "Write a polished response based on the provided calculation state. "
                        "Do not use canned phrasing or generic filler. "
                        "Explain only what is actually supported by the extracted formulas and values. "
                        "If formulas were not extracted, say that directly. "
                        "If values were not extracted, say that directly. "
                        "Do not claim a calculation can proceed if the setup is not sufficient. "
                        "Keep the tone professional and specific. "
                        "Use clear Markdown headings when helpful. "
                        "Only add a final section about missing information if the user must still provide concrete missing inputs. "
                        "If there is no missing user input, do not add a 'Missing information' section. "
                        "If there is an internal execution blocker, explain it briefly in professional prose instead of creating a separate missing-information heading. "
                        "Do not invent formulas, numbers, or worked examples."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        "Write the response from this calculation state as JSON-free Markdown.\n\n"
                        f"{json.dumps(fallback_payload, indent=2)}"
                    ),
                },
            ],
        )

        return _strip_empty_missing_information_section(response.choices[0].message.content.strip())

    # Step 2: Check for missing variables
    missing = setup.get("missing_variables", [])
    if missing:
        missing_answer = _generate_calculation_fallback(
            mode="missing_variables",
            blocker="Required inputs are missing, so no exact numeric result can be produced yet.",
            missing_variables=missing,
        )
        return AnswerResponse(
            text=ensure_inline_citation_references(missing_answer, citations),
            citations=citations,
        )

    # Step 3: Execute calculation in sandbox
    python_code = setup.get("python_code", "")
    calc_result = None
    if python_code:
        calc_result = execute_calculation(python_code)

    # Step 4: Format the step-by-step answer
    steps = []

    # Formula step
    for formula in setup.get("formulas", []):
        steps.append(AnswerStep(
            step=f"Formula: {formula.get('latex', formula.get('description', 'N/A'))}",
            citation=_find_citation(citations, formula.get("source", "")),
            grounded=True,
        ))

    # Variables step
    for var in setup.get("variables", []):
        source = var.get("source", "")
        grounded = "source" in source.lower() or "page" in source.lower()
        steps.append(AnswerStep(
            step=f"{var['name']} = {var.get('value', '?')} {var.get('unit', '')} (from {source})",
            citation=_find_citation(citations, source) if grounded else None,
            grounded=grounded,
        ))

    # Computation result
    if calc_result and calc_result["success"]:
        steps.append(AnswerStep(
            step=f"Result: {calc_result['result']}",
            grounded=False,
        ))
        result_text = calc_result["result"]
    else:
        error = calc_result["error"] if calc_result else "No calculation code generated"
        steps.append(AnswerStep(step=f"Calculation error: {error}", grounded=False))
        result_text = f"Calculation could not be completed: {error}"

    # Step 5: If the calculation could not run, stay honest and concise.
    if not calc_result or not calc_result.get("success"):
        error = calc_result["error"] if calc_result else "No calculation code generated"
        failure_answer = _generate_calculation_fallback(
            mode="execution_blocked",
            blocker=error,
            missing_variables=[],
        )

        warnings = []
        for r in sources:
            if r.ocr_confidence and r.ocr_confidence < 0.7:
                warnings.append(
                    f"Formula source from {r.document_name} page {r.page_number} has low OCR confidence "
                    f"({r.ocr_confidence:.0%}) â€” verify the formula visually."
                )

        if setup.get("multiple_methods"):
            warnings.append(
                f"Multiple calculation methods found. {setup.get('method_comparison', '')}"
            )

        return AnswerResponse(
            text=ensure_inline_citation_references(failure_answer, citations),
            sections=[AnswerSection(type="explanation", content=failure_answer, grounded=True)],
            citations=citations,
            warnings=warnings,
        )

    # Step 6: Generate natural language explanation
    explain_response = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=2048,
        messages=[{
            "role": "system",
            "content": (
                "You are Maia Axon, a professional technical calculation assistant. "
                f"{language_instruction} "
                "Write like a mathematician, scientist, and engineer: rigorous, exact, and technically clear."
            ),
        }, {
            "role": "user",
            "content": (
                f"Given this calculation setup:\n{json.dumps(setup, indent=2)}\n\n"
                f"And this result: {result_text}\n\n"
                "Write a clear, step-by-step explanation of the calculation. "
                "Reference numbered citations like [1] for any formula or value from the documents. "
                "Show: formula -> variable definitions -> substitution -> result. "
                "Then add a short interpretation of what the result means in practice, and if useful include "
                "one quick comparison, sensitivity note, or sanity check. "
                "Be detailed enough that a technical user can follow the reasoning without guessing missing steps. "
                "Use clean Markdown headings and bullets so the response feels polished and easy to scan. "
                "Do not invent fallback formulas, illustrative numbers, or hypothetical examples unless they are explicitly labeled illustrative and clearly separated from the grounded result. "
                "If the setup is incomplete, say so directly instead of padding the answer. "
                "End with a short section titled '## Missing information' only if specific user-supplied inputs are truly missing. "
                "If nothing is missing, do not include that section at all."
            ),
        }],
    )

    answer_text = ensure_inline_citation_references(
        _strip_empty_missing_information_section(explain_response.choices[0].message.content),
        citations,
    )

    # Warnings
    warnings = []
    for r in sources:
        if r.ocr_confidence and r.ocr_confidence < 0.7:
            warnings.append(
                f"Formula source from {r.document_name} page {r.page_number} has low OCR confidence "
                f"({r.ocr_confidence:.0%}) — verify the formula visually."
            )

    if setup.get("multiple_methods"):
        warnings.append(
            f"Multiple calculation methods found. {setup.get('method_comparison', '')}"
        )

    return AnswerResponse(
        text=answer_text,
        sections=[
            AnswerSection(type="calculation", steps=steps, grounded=True),
            AnswerSection(type="explanation", content=answer_text, grounded=True),
        ],
        citations=citations,
        warnings=warnings,
    )


def _find_citation(citations: list[Citation], source_ref: str) -> Citation | None:
    """Find a citation matching a source reference like '[1]' or 'Source 1'."""
    if not source_ref:
        return None
    match = re.search(r"(\d+)", source_ref)
    if not match:
        return None
    wanted = match.group(1)
    for cite in citations:
        if cite.id.replace("cite-", "") == wanted:
            return cite
    return None


# ---- Clarification Agent ----


def clarification_agent(
    query: str,
    sources: list[RetrievalResult],
) -> AnswerResponse:
    """Answer broadly, then include a short clarification note at the bottom if needed."""
    client = _get_client()
    language_instruction = language_instruction_for_query(query)
    sources_text = _format_sources_for_prompt(sources)

    response = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=1200,
        messages=[{
            "role": "system",
            "content": (
                "You are Maia Axon, a technical document assistant. "
                f"{language_instruction} "
                "Always answer like a mathematician, scientist, and engineer: precise, rigorous, and technically grounded. "
                "Do not stop with a standalone clarification question. "
                "Give the user the best useful answer you can from the sources right now. "
                "Then, only if narrowing would improve precision, add a final short section titled "
                "'## If you want, I can narrow this further' with one concise follow-up question or option."
            ),
        }, {
            "role": "user",
            "content": (
                f"SOURCES:\n{sources_text[:3000]}\n\n"
                f"QUESTION: {query}\n\n"
                "The question is somewhat ambiguous. "
                "Answer it at a sensible high level using the sources. "
                "Do not ask the user to clarify before answering. "
                "End with a short optional clarification note only if it would help narrow the scope."
            ),
        }],
    )

    citations = _build_citations(sources)
    return AnswerResponse(
        text=ensure_inline_citation_references(response.choices[0].message.content, citations),
        citations=citations,
    )


def standard_agent(
    query: str,
    conversation_history: list[dict],
) -> AnswerResponse:
    """Direct LLM response without retrieval or citations."""
    client = _get_client()
    language_instruction = language_instruction_for_query(query)

    messages = []
    for msg in conversation_history[-10:]:
        messages.append({"role": msg["role"], "content": msg["content"]})

    messages.insert(0, {
        "role": "system",
        "content": (
            "You are Maia Axon, a precise technical assistant. Respond directly to the user. "
            f"{language_instruction} "
            "Always sound like a mathematician, scientist, and engineer. "
            "This mode does not use retrieval, so do not invent citations or claim document grounding. "
            "Use polished Markdown. Default to detailed explanations unless the user asks for brevity. "
            "Start with a direct answer, then explain the concept in depth: what it is, how it works, why it matters, "
            "common applications, limitations, and practical implications when relevant. "
            "Do not give shallow label-only bullet lists. "
            "Use sections or bullets when they improve clarity. "
            "When the topic supports it, include a short worked example, mini-calculation, or practical numeric illustration "
            "even if the user did not explicitly request one. "
            "If the example is illustrative rather than derived from user-provided values, label it clearly."
        ),
    })
    if not conversation_history or conversation_history[-1]["role"] != "user" or conversation_history[-1]["content"] != query:
        messages.append({"role": "user", "content": query})

    response = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=4096,
        messages=messages,
    )

    answer_text = response.choices[0].message.content

    return AnswerResponse(
        text=answer_text,
        sections=[AnswerSection(type="explanation", content=answer_text, grounded=False)],
    )


# ---- Main orchestrator ----


async def generate_answer(
    query: str,
    sources: list[RetrievalResult],
    conversation_history: list[dict],
    search_mode: str = "library",
) -> AnswerResponse:
    """
    Main answer generation orchestrator.

    1. Classify intent
    2. Route to appropriate agent
    3. Build mindmap
    4. Return structured response
    """
    if classify_ava_question(query, conversation_history):
        answer = ava_agent(query, conversation_history)
        answer.mindmap = _build_mindmap(answer)
        return answer

    if classify_axon_group_question(query):
        answer = axon_group_agent(query, conversation_history)
        answer.mindmap = _build_mindmap(answer)
        return answer

    if classify_identity_question(query):
        answer = identity_agent(query, conversation_history)
        answer.mindmap = _build_mindmap(answer)
        return answer

    if search_mode == "standard":
        answer = standard_agent(query, conversation_history)
        answer.mindmap = _build_mindmap(answer)
        return answer

    if not sources:
        return AnswerResponse(
            text="I couldn't find any relevant information in the selected group's documents. "
            "Try rephrasing your question or selecting a different group.",
            warnings=["No sources found for this query."],
        )

    # Step 1: Classify intent
    intent = classify_intent(query, sources)
    logger.info(f"Classified intent: {intent}")

    # Step 2: Route to agent
    if intent == "ambiguous":
        answer = clarification_agent(query, sources)
    elif intent == "calculation":
        answer = calculation_agent(query, sources, conversation_history)
    else:
        answer = qa_agent(query, sources, conversation_history, search_mode=search_mode)

    # Step 3: Build mindmap (if not a clarification)
    if not answer.needs_clarification:
        answer.mindmap = _build_mindmap(answer)

    return answer


def _build_mindmap(answer: AnswerResponse) -> MindmapNode:
    """Build a mindmap showing how the answer was constructed from sources."""
    root = MindmapNode(
        id="root",
        label=answer.text[:100] + "..." if len(answer.text) > 100 else answer.text,
        node_type="answer",
    )

    # Add source nodes
    seen_sources = set()
    for cite in answer.citations:
        if cite.id in seen_sources:
            continue
        seen_sources.add(cite.id)

        if cite.source_type == "pdf":
            node = MindmapNode(
                id=cite.id,
                label=f"{cite.document_name}, p.{cite.page}",
                node_type="pdf_source",
                source=cite,
            )
        else:
            node = MindmapNode(
                id=cite.id,
                label=cite.title or cite.url or "Web source",
                node_type="web_source",
                source=cite,
            )
        root.children.append(node)

    # Add model reasoning node if any section is ungrounded
    has_ungrounded = any(
        not s.grounded
        for section in answer.sections
        for s in (section.steps if section.steps else [AnswerStep(step="", grounded=section.grounded)])
    )
    if has_ungrounded:
        root.children.append(MindmapNode(
            id="model-reasoning",
            label="Model reasoning (uncited)",
            node_type="model_reasoning",
        ))

    return root
