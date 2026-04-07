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
from dataclasses import dataclass, field
from typing import Any, Literal
from uuid import UUID

import openai

from app.core.config import settings
from app.services.retrieval import RetrievalResult
from app.services.sandbox import execute_calculation

logger = logging.getLogger(__name__)


@dataclass
class Citation:
    id: str
    source_type: str  # "pdf" or "web"
    document_id: UUID | None = None
    document_name: str = ""
    page: int = 0
    bbox: list | None = None
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


def _get_client() -> openai.OpenAI:
    return openai.OpenAI(api_key=settings.openai_api_key)


def _build_citations(results: list[RetrievalResult]) -> list[Citation]:
    """Convert retrieval results to citation objects."""
    citations = []
    for i, r in enumerate(results):
        cite = Citation(
            id=f"cite-{i + 1}",
            source_type=r.source_type,
            document_id=r.document_id,
            document_name=r.document_name,
            page=r.page_number,
            bbox=r.bbox_references[0] if r.bbox_references else None,
            snippet=r.content[:200],
            url=r.url,
            title=r.title,
        )
        citations.append(cite)
    return citations


def _format_sources_for_prompt(results: list[RetrievalResult]) -> str:
    """Format retrieval results as context for the LLM prompt."""
    parts = []
    for i, r in enumerate(results):
        header = f"[Source {i + 1}]"
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


# ---- Q&A Agent ----


def qa_agent(
    query: str,
    sources: list[RetrievalResult],
    conversation_history: list[dict],
) -> AnswerResponse:
    """Answer document Q&A questions with citations."""
    client = _get_client()
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
            "1. Ground your answer in the sources. Cite sources as [Source N].\n"
            "2. If you use knowledge not from the sources, clearly mark it as 'Based on general knowledge:'.\n"
            "3. If multiple sources give different information, present both and note the difference.\n"
            "4. If a source has LOW OCR CONFIDENCE, warn the user to verify visually.\n"
            "5. Be concise but thorough."
        ),
    })

    messages.insert(0, {
        "role": "system",
        "content": (
            "You are Maia Axon, a technical document assistant. You answer questions "
            "using uploaded PDFs as the primary source of truth. Always cite your sources. "
            "When information comes from the documents, use [Source N] citations. "
            "When you add your own knowledge, clearly separate it."
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
                    "You are a technical calculation assistant. Your job is to:\n"
                    "1. Identify the relevant formula(s) from the sources\n"
                    "2. List all variables needed\n"
                    "3. Match variables to values from the user's question\n"
                    "4. If multiple methods exist in different sources, note all of them\n"
                    "5. If any required value is missing, say MISSING: <variable name>\n"
                    "6. Write Python code to perform the calculation\n\n"
                    "Respond in this JSON format:\n"
                    '{"formulas": [{"source": "Source N", "latex": "...", "description": "..."}],\n'
                    ' "variables": [{"name": "...", "value": ..., "unit": "...", "source": "Source N or user"}],\n'
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

    # Step 2: Check for missing variables
    missing = setup.get("missing_variables", [])
    if missing:
        return AnswerResponse(
            text="",
            needs_clarification=True,
            clarification_question=(
                f"To complete this calculation, I need the following values:\n"
                + "\n".join(f"- **{v}**" for v in missing)
                + "\n\nPlease provide these values."
            ),
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

    # Step 5: Generate natural language explanation
    explain_response = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=2048,
        messages=[{
            "role": "user",
            "content": (
                f"Given this calculation setup:\n{json.dumps(setup, indent=2)}\n\n"
                f"And this result: {result_text}\n\n"
                "Write a clear, step-by-step explanation of the calculation. "
                "Reference [Source N] for any formula or value from the documents. "
                "Show: formula → variable definitions → substitution → result."
            ),
        }],
    )

    answer_text = explain_response.choices[0].message.content

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
    """Find a citation matching a source reference like 'Source 1'."""
    if not source_ref:
        return None
    for cite in citations:
        if cite.id.replace("cite-", "") in source_ref.replace("Source ", ""):
            return cite
    return None


# ---- Clarification Agent ----


def clarification_agent(
    query: str,
    sources: list[RetrievalResult],
) -> AnswerResponse:
    """Generate a clarifying question when the user's intent is ambiguous."""
    client = _get_client()
    sources_text = _format_sources_for_prompt(sources)

    response = client.chat.completions.create(
        model="gpt-4o",
        max_tokens=500,
        messages=[{
            "role": "user",
            "content": (
                f"The user asked: {query}\n\n"
                f"Available sources cover:\n{sources_text[:2000]}\n\n"
                "The question is ambiguous. Generate a helpful clarifying question "
                "that will help you give a precise answer. Be concise."
            ),
        }],
    )

    return AnswerResponse(
        text="",
        needs_clarification=True,
        clarification_question=response.choices[0].message.content,
        citations=_build_citations(sources),
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
