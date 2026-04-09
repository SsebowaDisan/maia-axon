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
    "Attach inline citations as [N] immediately after the factual sentence or clause they support."
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
                        "Include a short section that explicitly lists the currently available books or PDFs when they are provided. "
                        "The tone must sound like a serious technical assistant, not marketing copy. "
                        "Do not mention today's date, training data cutoffs, knowledge cutoffs, model release dates, or any statement such as 'up to October 2023'. "
                        "Generate 5 to 7 suggested questions on the spot from the provided documents. "
                        "Do not hardcode generic sample questions unrelated to the supplied PDFs. "
                        "When the document titles suggest formulas, calculations, design methods, acoustics, fans, coating, or engineering processes, include calculation-style and engineering-style questions as appropriate. "
                        "Keep each suggested question concise, practical, and professional. "
                        "The intro_markdown must be valid Markdown and should preferably contain a short bullet list of the available books."
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

    doc_names = [
        str(doc.get("filename", "")).strip()
        for doc in documents
        if str(doc.get("filename", "")).strip()
    ]
    fallback_docs = ", ".join(doc_names[:4]) or "the uploaded technical documents"
    listed_books = "\n".join(f"- {name}" for name in doc_names[:6])
    fallback_questions: list[str] = []
    if doc_names:
        primary_name = doc_names[0]
        fallback_questions = [
            f"What are the main topics covered in {primary_name}?",
            f"Which formulas or engineering relationships are presented in {primary_name}?",
            f"Can you summarise one important calculation method from {primary_name}?",
            f"What practical design guidance does {primary_name} provide?",
            f"Which sections of {primary_name} are most relevant for troubleshooting?",
        ]
    return {
        "intro_markdown": (
            "Hi colleague,\n\n"
            "My name is **Maia AI**. I am an Axon Group AI assistant currently under development and being trained by Axon Group to support technical reasoning, document-grounded answers, calculations, and engineering analysis.\n\n"
            f"I can currently assist you with questions based on {fallback_docs}, as well as broader technical questions when needed.\n\n"
            "## Available technical books\n"
            f"{listed_books or '- No ready PDFs are available yet.'}"
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
) -> AnswerResponse:
    """Answer document Q&A questions with citations."""
    client = _get_client()
    language_instruction = language_instruction_for_query(query)
    citations = _build_citations(sources)
    sources_text = _format_sources_for_prompt(sources)

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
                "1. Ground your answer in the sources. Cite inline as [N].\n"
                "2. If you use knowledge not from the sources, clearly mark it as 'Based on general knowledge:'.\n"
            "3. If multiple sources give different information, present both and note the difference.\n"
            "4. If a source has LOW OCR CONFIDENCE, warn the user to verify visually.\n"
            "5. Be thorough and practically useful, not minimal.\n"
            "6. Explain ideas, not just labels. For each major point, add concrete detail, mechanism, implication, or example.\n"
            "7. If the topic supports it, add a short worked example, quick estimate, unit check, or mini-calculation.\n"
            "8. Unless the user asks for a short answer, prefer a fuller explanation over a terse list.\n"
            f"9. {STRUCTURED_RESPONSE_GUIDANCE}"
        ),
    })

    messages.insert(0, {
        "role": "system",
        "content": (
                "You are Maia Axon, a technical document assistant. You answer questions "
                "using uploaded PDFs as the primary source of truth. Always cite your sources. "
                f"{language_instruction} "
                "When information comes from the documents, use inline [N] citations. "
                "When you add your own knowledge, clearly separate it. "
                "Always sound like a mathematician, scientist, and engineer: rigorous, exact, and technically grounded. "
                "Look for chances to make the answer more useful with a compact example, quick calculation, "
                "or engineering sanity check when the material supports it. "
                f"{STRUCTURED_RESPONSE_GUIDANCE}"
            ),
    })

    response = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=4096,
        messages=messages,
    )

    answer_text = response.choices[0].message.content

    # Check for OCR warnings
    warnings = []
    for r in sources:
        if r.ocr_confidence and r.ocr_confidence < 0.7:
            warnings.append(
                f"Source from {r.document_name} page {r.page_number} has low OCR confidence "
                f"({r.ocr_confidence:.0%}) — verify the content visually."
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
                    '{"formulas": [{"source": "[N]", "latex": "...", "description": "..."}],\n'
                    ' "variables": [{"name": "...", "value": ..., "unit": "...", "source": "[N] or user"}],\n'
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
                "Reference [N] for any formula or value from the documents. "
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
        answer = qa_agent(query, sources, conversation_history)

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
