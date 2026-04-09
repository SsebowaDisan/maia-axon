"""
Retrieval service: hybrid search (vector + keyword) with group scoping.

Supports two modes:
- Library: search within group PDFs only
- Deep Search: search group PDFs + web
"""
import json
import logging
import re
from dataclasses import dataclass, field
from uuid import UUID

import openai
from sqlalchemy import Integer, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.chunk import Chunk, ChunkEmbedding
from app.models.document import Document, Page

logger = logging.getLogger(__name__)

STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "is",
    "it", "of", "on", "or", "that", "the", "this", "to", "what", "when", "where", "which",
    "who", "why", "with", "without", "you", "your",
}

@dataclass
class RetrievalResult:
    source_type: str  # "pdf" or "web"
    chunk_id: UUID | None = None
    document_id: UUID | None = None
    document_name: str = ""
    page_number: int = 0
    chunk_type: str = ""
    content: str = ""
    latex: str | None = None
    variables: dict | None = None
    bbox_references: list | None = None
    relevance_score: float = 0.0
    ocr_confidence: float | None = None
    # Web-specific
    url: str | None = None
    title: str | None = None


@dataclass
class RetrievalResponse:
    results: list[RetrievalResult] = field(default_factory=list)
    query_embedding: list[float] | None = None


@dataclass
class StructuralQueryPlan:
    route: str = "generic"
    topic_index: int | None = None
    page_number: int | None = None
    reference_label: str | None = None


def _fallback_topic_request(query: str) -> int | None:
    lowered = query.lower()
    if "last" in lowered:
        return -1
    match = re.search(r"\b(\d+)(?:st|nd|rd|th)?\s+(?:topic|chapter|section|part)\b", lowered)
    if match:
        return int(match.group(1))
    match = re.search(r"\b(?:topic|chapter|section|part)\s+(\d+)\b", lowered)
    if match:
        return int(match.group(1))
    return None


def _plan_topic_request_with_llm(query: str) -> int | None:
    client = _get_openai_client()
    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            max_tokens=80,
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Decide whether the user is asking for a document topic/chapter/section by order. "
                        "Return JSON with keys: is_topic_request (boolean) and topic_index (integer). "
                        "Use topic_index = -1 for 'last topic'. "
                        "If this is not a topic-order request, return is_topic_request=false and topic_index=0."
                    ),
                },
                {
                    "role": "user",
                    "content": query,
                },
            ],
        )
        payload = json.loads(response.choices[0].message.content or "{}")
        if payload.get("is_topic_request") is True:
            topic_index = int(payload.get("topic_index", 0))
            return topic_index if topic_index != 0 else None
    except Exception as exc:
        logger.debug("Topic planner fallback triggered: %s", exc)

    return _fallback_topic_request(query)


def _fallback_structural_query_plan(query: str) -> StructuralQueryPlan:
    topic_index = _fallback_topic_request(query)
    if topic_index is not None:
        return StructuralQueryPlan(route="topic_outline", topic_index=topic_index)

    page_match = re.search(r"\bpage\s+(\d{1,3})\b", query, flags=re.IGNORECASE)
    if page_match:
        return StructuralQueryPlan(route="page_target", page_number=int(page_match.group(1)))

    return StructuralQueryPlan(route="generic")


def _plan_structural_query_with_llm(query: str) -> StructuralQueryPlan:
    client = _get_openai_client()
    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            max_tokens=140,
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Classify this PDF question into one route. "
                        "Allowed routes: generic, document_overview, topic_outline, page_target, formula_lookup, figure_lookup. "
                        "Use topic_outline for questions like nth topic/last topic/chapter order/section order. "
                        "Use document_overview for questions asking what the PDF covers, its themes, topics, or structure overall. "
                        "Use page_target for page-specific questions. "
                        "Use formula_lookup for equations, formulas, variables, units, or calculations grounded in the PDF. "
                        "Use figure_lookup for figures, drawings, diagrams, tables, or visual items. "
                        "Return JSON with keys route, topic_index, page_number, reference_label. "
                        "Use topic_index=-1 for 'last topic'. Use 0 when absent."
                    ),
                },
                {"role": "user", "content": query},
            ],
        )
        payload = json.loads(response.choices[0].message.content or "{}")
        route = str(payload.get("route", "generic")).strip().lower()
        if route not in {"generic", "document_overview", "topic_outline", "page_target", "formula_lookup", "figure_lookup"}:
            route = "generic"
        topic_index = int(payload.get("topic_index", 0) or 0)
        page_number = int(payload.get("page_number", 0) or 0)
        reference_label = str(payload.get("reference_label", "") or "").strip() or None
        return StructuralQueryPlan(
            route=route,
            topic_index=topic_index if topic_index != 0 else None,
            page_number=page_number if page_number > 0 else None,
            reference_label=reference_label,
        )
    except Exception as exc:
        logger.debug("Structural query planner fallback triggered: %s", exc)
        return _fallback_structural_query_plan(query)


async def _get_ready_documents(
    db: AsyncSession,
    group_id: UUID,
    document_ids: list[UUID] | None,
):
    conditions = [Document.group_id == group_id, Document.status == "ready"]
    if document_ids:
        conditions.append(Document.id.in_(document_ids))
    result = await db.execute(
        select(Document.id, Document.filename, Document.page_count)
        .where(*conditions)
        .order_by(Document.created_at.desc())
    )
    return result.all()


def _page_number_from_metadata(metadata: dict | None) -> int:
    if not metadata:
        return 0
    try:
        return int(metadata.get("page_number", 0) or 0)
    except Exception:
        return 0


async def _load_document_chunks(
    db: AsyncSession,
    document_ids: list[UUID],
    chunk_types: list[str] | None = None,
):
    stmt = (
        select(
            Chunk.id,
            Chunk.document_id,
            Chunk.page_id,
            Chunk.chunk_type,
            Chunk.content_text,
            Chunk.latex,
            Chunk.variables,
            Chunk.bbox_references,
            Chunk.metadata_,
            Document.filename,
        )
        .join(Document, Document.id == Chunk.document_id)
        .where(Chunk.document_id.in_(document_ids))
    )
    if chunk_types:
        stmt = stmt.where(Chunk.chunk_type.in_(chunk_types))
    stmt = stmt.order_by(
        Document.filename.asc(),
        Chunk.metadata_["page_number"].astext.cast(Integer).asc(),
        Chunk.created_at.asc(),
    )
    result = await db.execute(stmt)
    return result.all()


def _row_to_result(row, score: float) -> RetrievalResult:
    return RetrievalResult(
        source_type="pdf",
        chunk_id=row.id,
        document_id=row.document_id,
        document_name=row.filename,
        page_number=_page_number_from_metadata(row.metadata_),
        chunk_type=row.chunk_type,
        content=row.content_text,
        latex=getattr(row, "latex", None),
        variables=getattr(row, "variables", None),
        bbox_references=row.bbox_references,
        relevance_score=score,
    )


def _rank_rows_by_query(query: str, rows: list, preferred_types: set[str] | None = None) -> list:
    preferred_types = preferred_types or set()
    scored = []
    for row in rows:
        candidate_text = " ".join(
            part for part in [
                getattr(row, "content_text", "") or "",
                getattr(row, "latex", "") or "",
                getattr(row, "filename", "") or "",
            ] if part
        )
        overlap = _query_overlap_ratio(query, candidate_text)
        bonus = _technical_term_bonus(query, candidate_text)
        if getattr(row, "chunk_type", "") in preferred_types:
            bonus += 0.15
        score = overlap + bonus
        if score <= 0 and preferred_types and getattr(row, "chunk_type", "") in preferred_types:
            score = 0.12
        if score > 0:
            scored.append((score, row))
    scored.sort(key=lambda item: item[0], reverse=True)
    return scored


_FORMULA_LINE_RE = re.compile(
    r"(?i)(=|formule|équation|equation|pression|rendement|efficiency|débit|power|puissance|qv|ap|eta|η|lw)"
)
_STRICT_EQUATION_RE = re.compile(
    r"(?i)([a-zα-ω]\s*=\s*|=\s*[a-z0-9(]|formule|équation|equation|\blw\b|\bqv\b|\bap\b|\bη\b|\beta\b)"
)
_FORMULA_PASSAGE_RE = re.compile(
    r"(?i)([a-zα-ω]\s*=\s*|=\s*[a-z0-9(]|l['’]équation|équation\s*\(\d+\)|formule|où\s+[a-z]{1,4}\b)"
)


def _extract_formula_passage(text: str) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    candidates = [line for line in lines if _FORMULA_LINE_RE.search(line)]
    if not candidates:
        return text[:800]

    picked: list[str] = []
    for line in candidates:
        if line not in picked:
            picked.append(line)
        if len(picked) >= 10:
            break
    return "\n".join(picked)


def _is_reference_like_text(text: str) -> bool:
    lowered = text.lower()
    if lowered.startswith("references") or lowered.startswith("références"):
        return True
    reference_markers = len(re.findall(r"\[\d+\]", text))
    if reference_markers >= 5:
        return True
    if lowered.count("proc.") >= 2 or lowered.count("journal") >= 2:
        return True
    return False


def _is_formula_like_text(text: str) -> bool:
    lowered = text.lower()
    if "too faint" in lowered or "not legible enough" in lowered:
        return False
    return _FORMULA_PASSAGE_RE.search(text) is not None


def _clean_topic_line(line: str) -> str:
    return " ".join(re.sub(r"[.\u2026]{2,}", " ", line).split()).strip()


def _looks_like_topic_label(label: str) -> bool:
    if not label:
        return False
    lowered = label.lower()
    if lowered in {"sommaire", "contents"}:
        return False
    if len(label) < 4:
        return False
    if "page" in lowered:
        return False
    return True


def _extract_topics_from_toc(text: str) -> list[dict]:
    topics = []
    for raw_line in text.splitlines():
        line = _clean_topic_line(raw_line)
        if not line:
            continue

        match = re.match(
            r"^(?P<label>(?:\d+(?:\.\d+)*)|ANNEXE\s+[A-Z]|R[ÉE]F[ÉE]RENCES|P[RÉE]FACE|AVANT-PROPOS)\s*(?P<title>.*?)(?P<page>\d{1,3})$",
            line,
            flags=re.IGNORECASE,
        )
        if not match:
            continue

        prefix = match.group("label").strip()
        title = match.group("title").strip(" -.:")
        page_number = int(match.group("page"))
        full_label = f"{prefix} {title}".strip()
        if not _looks_like_topic_label(full_label):
            continue

        topics.append({
            "title": full_label,
            "page_number": page_number,
        })

    deduped = []
    seen = set()
    for topic in topics:
        key = (topic["title"].lower(), topic["page_number"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(topic)
    return deduped


async def _topic_outline_search(
    db: AsyncSession,
    query: str,
    group_id: UUID,
    document_ids: list[UUID] | None,
    topic_index: int | None = None,
) -> list[RetrievalResult]:
    topic_index = topic_index if topic_index is not None else _plan_topic_request_with_llm(query)
    if topic_index is None:
        return []

    docs = await _get_ready_documents(db, group_id, document_ids)
    if not docs:
        return []

    target_doc_ids = [row.id for row in docs]
    section_rows = await _load_document_chunks(db, target_doc_ids, ["section"])
    if not section_rows:
        return []

    per_doc: dict[UUID, list] = {}
    for row in section_rows:
        per_doc.setdefault(row.document_id, []).append(row)

    results: list[RetrievalResult] = []
    for doc_id, rows in per_doc.items():
        toc_rows = [
            row for row in rows
            if any(marker in row.content_text.lower() for marker in ("sommaire", "contents", "table of contents"))
        ]
        if not toc_rows:
            continue

        topics: list[dict] = []
        toc_row = None
        for candidate in toc_rows:
            extracted = _extract_topics_from_toc(candidate.content_text)
            if extracted:
                topics = extracted
                toc_row = candidate
                break

        if not topics or toc_row is None:
            continue

        selected = topics[-1] if topic_index == -1 else (topics[topic_index - 1] if 0 < topic_index <= len(topics) else None)
        if selected is None:
            continue

        selected_pos = topics.index(selected)
        next_page = topics[selected_pos + 1]["page_number"] if selected_pos + 1 < len(topics) else None
        end_page = (next_page - 1) if next_page else (selected["page_number"] + 8)

        results.append(
            RetrievalResult(
                source_type="pdf",
                chunk_id=toc_row.id,
                document_id=doc_id,
                document_name=toc_row.filename,
                page_number=toc_row.metadata_.get("page_number", 0) if toc_row.metadata_ else 0,
                chunk_type="section",
                content=f"Table of contents entry: {selected['title']} (starts on page {selected['page_number']})",
                bbox_references=toc_row.bbox_references,
                relevance_score=1.0,
            )
        )

        matching_rows = [
            row for row in rows
            if selected["page_number"] <= (row.metadata_.get("page_number", 0) if row.metadata_ else 0) <= end_page
        ]
        for row in matching_rows[:8]:
            page_number = row.metadata_.get("page_number", 0) if row.metadata_ else 0
            results.append(
                RetrievalResult(
                    source_type="pdf",
                    chunk_id=row.id,
                    document_id=doc_id,
                    document_name=row.filename,
                    page_number=page_number,
                    chunk_type=row.chunk_type,
                    content=row.content_text,
                    bbox_references=row.bbox_references,
                    relevance_score=max(0.95 - (page_number - selected["page_number"]) * 0.02, 0.75),
                )
            )
        break

    return results


async def _document_overview_search(
    db: AsyncSession,
    group_id: UUID,
    document_ids: list[UUID] | None,
) -> list[RetrievalResult]:
    docs = await _get_ready_documents(db, group_id, document_ids)
    if not docs:
        return []

    rows = await _load_document_chunks(db, [row.id for row in docs], ["section"])
    if not rows:
        return []

    results: list[RetrievalResult] = []
    for doc in docs:
        doc_rows = [row for row in rows if row.document_id == doc.id]
        toc_rows = [
            row for row in doc_rows
            if _page_number_from_metadata(row.metadata_) <= 20
            and ("sommaire" in row.content_text.lower() or "contents" in row.content_text.lower())
        ]
        intro_rows = [
            row for row in doc_rows
            if 7 <= _page_number_from_metadata(row.metadata_) <= 15
            and len((row.content_text or "").strip()) > 180
        ]

        selected_rows = []
        if toc_rows:
            selected_rows.extend(toc_rows[:1])
        selected_rows.extend(intro_rows[:6])

        seen = set()
        for idx, row in enumerate(selected_rows):
            if row.id in seen:
                continue
            seen.add(row.id)
            results.append(_row_to_result(row, max(1.0 - idx * 0.04, 0.75)))
        if results:
            break

    return results[: settings.rerank_top_k]


async def _page_target_search(
    db: AsyncSession,
    group_id: UUID,
    document_ids: list[UUID] | None,
    page_number: int,
) -> list[RetrievalResult]:
    docs = await _get_ready_documents(db, group_id, document_ids)
    if not docs or page_number <= 0:
        return []

    rows = await _load_document_chunks(db, [row.id for row in docs], ["section", "equation", "table", "figure", "page"])
    targeted = [row for row in rows if _page_number_from_metadata(row.metadata_) == page_number]
    type_priority = {"section": 0.95, "equation": 0.94, "table": 0.93, "figure": 0.92, "page": 0.9}
    return [_row_to_result(row, type_priority.get(row.chunk_type, 0.85)) for row in targeted[: settings.rerank_top_k]]


async def _formula_lookup_search(
    db: AsyncSession,
    query: str,
    group_id: UUID,
    document_ids: list[UUID] | None,
) -> list[RetrievalResult]:
    docs = await _get_ready_documents(db, group_id, document_ids)
    if not docs:
        return []

    rows = await _load_document_chunks(db, [row.id for row in docs], ["equation", "section", "page"])

    supporting_rows = [
        row for row in rows
        if row.chunk_type in {"section", "page"}
        and _is_formula_like_text(row.content_text or "")
        and not _is_reference_like_text(row.content_text or "")
    ]
    ranked_support = _rank_rows_by_query(query, supporting_rows, preferred_types={"section", "page"})
    results: list[RetrievalResult] = []
    for score, row in ranked_support[: settings.rerank_top_k]:
        passage = _extract_formula_passage(row.content_text or "")
        bonus = 0.15 if _STRICT_EQUATION_RE.search(passage) else 0.0
        results.append(
            RetrievalResult(
                source_type="pdf",
                chunk_id=row.id,
                document_id=row.document_id,
                document_name=row.filename,
                page_number=_page_number_from_metadata(row.metadata_),
                chunk_type=row.chunk_type,
                content=passage,
                latex=getattr(row, "latex", None),
                variables=getattr(row, "variables", None),
                bbox_references=row.bbox_references,
                relevance_score=min(score + 0.75 + bonus, 1.0),
            )
        )
    return results


async def _figure_lookup_search(
    db: AsyncSession,
    query: str,
    group_id: UUID,
    document_ids: list[UUID] | None,
    reference_label: str | None = None,
) -> list[RetrievalResult]:
    docs = await _get_ready_documents(db, group_id, document_ids)
    if not docs:
        return []

    rows = await _load_document_chunks(db, [row.id for row in docs], ["figure", "table", "section", "page"])
    if reference_label:
        exact_matches = [
            row for row in rows
            if reference_label.lower() in (row.content_text or "").lower()
        ]
        if exact_matches:
            return [_row_to_result(row, max(0.98 - index * 0.03, 0.86)) for index, row in enumerate(exact_matches[: settings.rerank_top_k])]

    figure_query = f"{query} {reference_label or ''}".strip()
    ranked = _rank_rows_by_query(figure_query, rows, preferred_types={"figure", "table"})
    return [_row_to_result(row, min(score + 0.7, 1.0)) for score, row in ranked[: settings.rerank_top_k]]


# ---- Embedding ----


def _get_openai_client() -> openai.OpenAI:
    return openai.OpenAI(api_key=settings.openai_api_key)


async def _embed_query(query: str) -> list[float]:
    """Generate embedding for a query string."""
    client = _get_openai_client()
    response = client.embeddings.create(
        model=settings.embedding_model,
        input=query,
        dimensions=settings.embedding_dimensions,
    )
    return response.data[0].embedding


# ---- Vector search ----


async def _vector_search(
    db: AsyncSession,
    query_embedding: list[float],
    group_id: UUID,
    document_ids: list[UUID] | None,
    top_k: int,
) -> list[dict]:
    """Semantic similarity search using pgvector."""
    embedding_str = "[" + ",".join(str(x) for x in query_embedding) + "]"

    # Build filter conditions
    conditions = ["d.group_id = :group_id"]
    params: dict = {"group_id": str(group_id), "top_k": top_k, "embedding": embedding_str}

    if document_ids:
        placeholders = ", ".join(f":doc_{i}" for i in range(len(document_ids)))
        conditions.append(f"c.document_id IN ({placeholders})")
        for i, did in enumerate(document_ids):
            params[f"doc_{i}"] = str(did)

    where_clause = " AND ".join(conditions)

    query = text(f"""
        SELECT
            c.id as chunk_id,
            c.document_id,
            d.filename as document_name,
            c.chunk_type,
            c.content_text,
            c.latex,
            c.variables,
            c.bbox_references,
            c.metadata as chunk_metadata,
            p.ocr_confidence,
            ce.embedding <=> CAST(:embedding AS vector) as distance
        FROM chunk_embeddings ce
        JOIN chunks c ON c.id = ce.chunk_id
        JOIN documents d ON d.id = c.document_id
        JOIN pages p ON p.id = c.page_id
        WHERE {where_clause}
          AND d.status = 'ready'
        ORDER BY ce.embedding <=> CAST(:embedding AS vector)
        LIMIT :top_k
    """)

    result = await db.execute(query, params)
    rows = result.mappings().all()

    return [
        {
            "chunk_id": row["chunk_id"],
            "document_id": row["document_id"],
            "document_name": row["document_name"],
            "chunk_type": row["chunk_type"],
            "content": row["content_text"],
            "latex": row["latex"],
            "variables": row["variables"],
            "bbox_references": row["bbox_references"],
            "page_number": row["chunk_metadata"].get("page_number", 0) if row["chunk_metadata"] else 0,
            "ocr_confidence": row["ocr_confidence"],
            "score": 1.0 - float(row["distance"]),  # Convert distance to similarity
        }
        for row in rows
    ]


# ---- Keyword search (BM25-style via tsvector) ----


async def _keyword_search(
    db: AsyncSession,
    query: str,
    group_id: UUID,
    document_ids: list[UUID] | None,
    top_k: int,
) -> list[dict]:
    """Full-text search using PostgreSQL tsvector."""
    conditions = ["d.group_id = :group_id", "d.status = 'ready'"]
    params: dict = {"group_id": str(group_id), "top_k": top_k, "query": query}

    if document_ids:
        placeholders = ", ".join(f":doc_{i}" for i in range(len(document_ids)))
        conditions.append(f"c.document_id IN ({placeholders})")
        for i, did in enumerate(document_ids):
            params[f"doc_{i}"] = str(did)

    where_clause = " AND ".join(conditions)

    sql = text(f"""
        SELECT
            c.id as chunk_id,
            c.document_id,
            d.filename as document_name,
            c.chunk_type,
            c.content_text,
            c.latex,
            c.variables,
            c.bbox_references,
            c.metadata as chunk_metadata,
            p.ocr_confidence,
            ts_rank(
                to_tsvector('english', c.content_text),
                plainto_tsquery('english', :query)
            ) as score
        FROM chunks c
        JOIN documents d ON d.id = c.document_id
        JOIN pages p ON p.id = c.page_id
        WHERE {where_clause}
          AND to_tsvector('english', c.content_text) @@ plainto_tsquery('english', :query)
        ORDER BY score DESC
        LIMIT :top_k
    """)

    result = await db.execute(sql, params)
    rows = result.mappings().all()

    return [
        {
            "chunk_id": row["chunk_id"],
            "document_id": row["document_id"],
            "document_name": row["document_name"],
            "chunk_type": row["chunk_type"],
            "content": row["content_text"],
            "latex": row["latex"],
            "variables": row["variables"],
            "bbox_references": row["bbox_references"],
            "page_number": row["chunk_metadata"].get("page_number", 0) if row["chunk_metadata"] else 0,
            "ocr_confidence": row["ocr_confidence"],
            "score": float(row["score"]),
        }
        for row in rows
    ]


# ---- Reciprocal Rank Fusion ----


def _reciprocal_rank_fusion(
    vector_results: list[dict],
    keyword_results: list[dict],
    k: int = 60,
) -> list[dict]:
    """Merge vector and keyword results using Reciprocal Rank Fusion."""
    scores: dict[str, float] = {}
    result_map: dict[str, dict] = {}

    for rank, result in enumerate(vector_results):
        cid = str(result["chunk_id"])
        scores[cid] = scores.get(cid, 0) + 1.0 / (k + rank + 1)
        result_map[cid] = result

    for rank, result in enumerate(keyword_results):
        cid = str(result["chunk_id"])
        scores[cid] = scores.get(cid, 0) + 1.0 / (k + rank + 1)
        if cid not in result_map:
            result_map[cid] = result

    # Sort by fused score
    sorted_ids = sorted(scores.keys(), key=lambda x: scores[x], reverse=True)
    merged = []
    for cid in sorted_ids:
        result = result_map[cid]
        result["score"] = scores[cid]
        merged.append(result)

    return merged


# ---- Web search (OpenAI Responses API with web_search_preview) ----


async def _web_search(query: str, top_k: int = 5) -> list[RetrievalResult]:
    """Search the web using OpenAI's built-in web search tool."""
    try:
        client = _get_openai_client()
        response = client.responses.create(
            model="gpt-4o",
            tools=[{"type": "web_search_preview"}],
            input=f"Search the web for: {query}\n\nReturn the top {top_k} most relevant results with their URLs, titles, and key content.",
        )

        # Parse the response — extract web citations from the output
        results = []
        # The response contains output items, some of which are web search results
        for item in response.output:
            if item.type == "web_search_call":
                continue  # This is the search call itself, not results

            if item.type == "message":
                # Extract any URL citations from the message content
                for content_block in item.content:
                    if hasattr(content_block, "annotations"):
                        for annotation in content_block.annotations:
                            if annotation.type == "url_citation":
                                results.append(
                                    RetrievalResult(
                                        source_type="web",
                                        content=annotation.title or "",
                                        url=annotation.url,
                                        title=annotation.title,
                                        relevance_score=0.7,
                                    )
                                )

        # If we got citations, also include the full answer as context
        if not results:
            # Fallback: use the full text response as a single web result
            full_text = ""
            for item in response.output:
                if item.type == "message":
                    for content_block in item.content:
                        if hasattr(content_block, "text"):
                            full_text += content_block.text

            if full_text:
                results.append(
                    RetrievalResult(
                        source_type="web",
                        content=full_text[:2000],
                        url=None,
                        title="Web search results",
                        relevance_score=0.6,
                    )
                )

        return results[:top_k]
    except Exception as e:
        logger.error(f"Web search failed: {e}")
        return []


def _tokenize_for_overlap(text: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9]+", text.lower())
        if len(token) > 2 and token not in STOPWORDS
    }


def _query_overlap_ratio(query: str, candidate: str) -> float:
    query_terms = _tokenize_for_overlap(query)
    if not query_terms:
        return 0.0

    candidate_terms = _tokenize_for_overlap(candidate)
    if not candidate_terms:
        return 0.0

    overlap = len(query_terms & candidate_terms)
    return overlap / len(query_terms)


def _technical_query_terms(text: str) -> set[str]:
    return {
        token.lower()
        for token in re.findall(r"\b(?=\w*[A-Z])(?=\w*[a-z])\w+\b|\b\w*\d\w*\b", text)
        if len(token) > 1
    }


def _technical_term_bonus(query: str, candidate: str) -> float:
    technical_terms = _technical_query_terms(query)
    if not technical_terms:
        return 0.0

    candidate_terms = _tokenize_for_overlap(candidate)
    if technical_terms & candidate_terms:
        return 0.2
    return 0.0


def _deep_search_text(result: RetrievalResult) -> str:
    parts = [result.title or "", result.document_name, result.content, result.latex or ""]
    if result.variables:
        parts.append(" ".join(str(value) for value in result.variables.values()))
    return " ".join(part for part in parts if part)


def _rerank_deep_search_results(
    query: str,
    pdf_results: list[RetrievalResult],
    web_results: list[RetrievalResult],
    top_k: int,
) -> list[RetrievalResult]:
    ranked_entries: list[tuple[float, float, int, RetrievalResult]] = []

    max_pdf_overlap = max((_query_overlap_ratio(query, _deep_search_text(result)) for result in pdf_results), default=0.0)
    max_web_overlap = max((_query_overlap_ratio(query, _deep_search_text(result)) for result in web_results), default=0.0)
    prefer_web = bool(web_results) and max_pdf_overlap == 0.0 and max_web_overlap > 0.0
    pdf_has_technical_match = any(
        _technical_term_bonus(query, _deep_search_text(result)) > 0 for result in pdf_results
    )

    for rank, result in enumerate(pdf_results):
        candidate_text = _deep_search_text(result)
        overlap = _query_overlap_ratio(query, candidate_text)
        rank_bonus = 1.0 / (rank + 1)
        semantic_score = max(min(result.relevance_score, 1.0), 0.0)
        score = overlap * 0.60 + rank_bonus * 0.20 + semantic_score * 0.10
        score += _technical_term_bonus(query, candidate_text)
        if result.chunk_type == "equation" and overlap > 0:
            score += 0.03
        if prefer_web and overlap == 0.0:
            score -= 0.2
        ranked_entries.append((score, overlap, rank, result))

    for rank, result in enumerate(web_results):
        candidate_text = _deep_search_text(result)
        overlap = _query_overlap_ratio(query, candidate_text)
        rank_bonus = 1.0 / (rank + 1)
        web_score = max(min(result.relevance_score, 1.0), 0.0)
        technical_bonus = _technical_term_bonus(query, candidate_text)
        score = overlap * 0.60 + rank_bonus * 0.20 + web_score * 0.10 + 0.04
        score += technical_bonus
        if pdf_has_technical_match and technical_bonus == 0.0:
            score -= 0.18
        if pdf_has_technical_match and not result.url:
            score -= 0.12
        ranked_entries.append((score, overlap, rank, result))

    ranked_entries.sort(key=lambda item: (item[0], item[1], -item[2]), reverse=True)
    return [result for _, _, _, result in ranked_entries[:top_k]]


# ---- Public API ----


async def library_search(
    db: AsyncSession,
    query: str,
    group_id: UUID,
    document_ids: list[UUID] | None = None,
    top_k: int | None = None,
) -> RetrievalResponse:
    """
    Library search: hybrid retrieval within group PDFs only.
    Serves the Library mode in the + menu.
    """
    top_k = top_k or settings.retrieval_top_k
    plan = _plan_structural_query_with_llm(query)

    if plan.route == "document_overview":
        structural_results = await _document_overview_search(db, group_id, document_ids)
        if structural_results:
            return RetrievalResponse(results=structural_results[: settings.rerank_top_k], query_embedding=None)
    elif plan.route == "topic_outline":
        structural_results = await _topic_outline_search(db, query, group_id, document_ids, plan.topic_index)
        if structural_results:
            return RetrievalResponse(results=structural_results[: settings.rerank_top_k], query_embedding=None)
    elif plan.route == "page_target" and plan.page_number:
        structural_results = await _page_target_search(db, group_id, document_ids, plan.page_number)
        if structural_results:
            return RetrievalResponse(results=structural_results[: settings.rerank_top_k], query_embedding=None)
    elif plan.route == "formula_lookup":
        structural_results = await _formula_lookup_search(db, query, group_id, document_ids)
        if structural_results:
            return RetrievalResponse(results=structural_results[: settings.rerank_top_k], query_embedding=None)
    elif plan.route == "figure_lookup":
        structural_results = await _figure_lookup_search(db, query, group_id, document_ids, plan.reference_label)
        if structural_results:
            return RetrievalResponse(results=structural_results[: settings.rerank_top_k], query_embedding=None)

    # Generate query embedding
    query_embedding = await _embed_query(query)

    # Run vector and keyword search in parallel
    vector_results = await _vector_search(db, query_embedding, group_id, document_ids, top_k * 2)
    keyword_results = await _keyword_search(db, query, group_id, document_ids, top_k * 2)

    # Fuse results
    merged = _reciprocal_rank_fusion(vector_results, keyword_results)

    # Take top K
    top_results = merged[: settings.rerank_top_k]

    results = [
        RetrievalResult(
            source_type="pdf",
            chunk_id=UUID(r["chunk_id"]) if isinstance(r["chunk_id"], str) else r["chunk_id"],
            document_id=UUID(r["document_id"]) if isinstance(r["document_id"], str) else r["document_id"],
            document_name=r["document_name"],
            page_number=r["page_number"],
            chunk_type=r["chunk_type"],
            content=r["content"],
            latex=r.get("latex"),
            variables=r.get("variables"),
            bbox_references=r.get("bbox_references"),
            relevance_score=r["score"],
            ocr_confidence=r.get("ocr_confidence"),
        )
        for r in top_results
    ]

    return RetrievalResponse(results=results, query_embedding=query_embedding)


async def deep_search(
    db: AsyncSession,
    query: str,
    group_id: UUID,
    document_ids: list[UUID] | None = None,
    top_k: int | None = None,
) -> RetrievalResponse:
    """
    Deep search: hybrid retrieval across group PDFs + web.
    Serves the Deep Search mode in the + menu.
    """
    top_k = top_k or settings.rerank_top_k

    # Run library search and web search
    library_response = await library_search(db, query, group_id, document_ids, top_k)
    web_results = await _web_search(query, top_k=5)

    all_results = _rerank_deep_search_results(
        query=query,
        pdf_results=library_response.results,
        web_results=web_results,
        top_k=top_k,
    )

    return RetrievalResponse(
        results=all_results,
        query_embedding=library_response.query_embedding,
    )
