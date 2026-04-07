"""
Retrieval service: hybrid search (vector + keyword) with group scoping.

Supports two modes:
- Library: search within group PDFs only
- Deep Search: search group PDFs + web
"""
import logging
from dataclasses import dataclass, field
from uuid import UUID

import openai
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.chunk import Chunk, ChunkEmbedding
from app.models.document import Document, Page

logger = logging.getLogger(__name__)


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
            ce.embedding <=> :embedding::vector as distance
        FROM chunk_embeddings ce
        JOIN chunks c ON c.id = ce.chunk_id
        JOIN documents d ON d.id = c.document_id
        JOIN pages p ON p.id = c.page_id
        WHERE {where_clause}
          AND d.status = 'ready'
        ORDER BY ce.embedding <=> :embedding::vector
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
    # Run library search and web search
    library_response = await library_search(db, query, group_id, document_ids, top_k)
    web_results = await _web_search(query, top_k=5)

    # Merge: PDF results first, then web results
    all_results = library_response.results + web_results

    return RetrievalResponse(
        results=all_results,
        query_embedding=library_response.query_embedding,
    )
