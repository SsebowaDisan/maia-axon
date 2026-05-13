"""Concept-neighbour lookup used by the not-in-document pivot.

When retrieval fails to answer the user's question against a document
we want to suggest the closest topics the document DOES cover. The
concept-graph already stores per-concept embeddings and bridges them
back to their introducing sections; this module wraps the query
flow as a single helper the answer engine can call.

Why pgvector cosine here, not BM25 or semantic search over chunks?
Concepts are intentionally short, canonical labels — comparing the
user's query embedding to the concept embedding gives a much
cleaner pivot suggestion ("closest topic: 'centrifugal fan
performance curves'") than against arbitrary 800-token chunks.
"""

from __future__ import annotations

import logging
import uuid
from typing import Iterable

import openai
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.services.answer_engine import NeighborConcept

logger = logging.getLogger(__name__)


def _embed_query_sync(client: openai.OpenAI, query: str) -> list[float] | None:
    """Embed the user's query using the same model as the corpus.

    Synchronous because the OpenAI client doesn't expose a useful
    async embedding API for our use case and the call is fast (~80 ms).
    """
    try:
        response = client.embeddings.create(
            model=settings.embedding_model,
            input=query[:2000],
            dimensions=settings.embedding_dimensions,
        )
        return list(response.data[0].embedding)
    except Exception as exc:  # noqa: BLE001
        logger.warning("concept_neighbor_embed_failed: %s", exc)
        return None


async def find_neighbor_concepts(
    db: AsyncSession,
    *,
    query: str,
    document_ids: Iterable[uuid.UUID],
    limit: int = 4,
) -> list[NeighborConcept]:
    """Top-N concept neighbours within the given documents.

    Returns the closest concepts by cosine similarity to the query,
    each annotated with the section that introduces it (so the
    pivot response can cite a page). Concepts that aren't
    introduced anywhere in the given documents are filtered out —
    we never want to suggest a topic from a different book the
    user can't navigate to.
    """
    document_ids = list(document_ids)
    if not document_ids:
        return []
    client = openai.OpenAI(api_key=settings.openai_api_key)
    query_vec = _embed_query_sync(client, query)
    if not query_vec:
        return []

    # Raw SQL because pgvector's ``<=>`` (cosine distance) operator
    # is awkward to express via the ORM. We:
    #   1. join concepts to their embeddings
    #   2. order by cosine distance to the query vector
    #   3. keep only concepts introduced by sections of the given
    #      documents
    #   4. pick the first introducing section per concept for the
    #      page reference (using DISTINCT ON, smallest page_start)
    vector_literal = "[" + ",".join(f"{v:.7f}" for v in query_vec) + "]"
    sql = text(
        """
        WITH ranked_concepts AS (
            SELECT
                c.id AS concept_id,
                c.canonical_name,
                (ce.embedding <=> CAST(:qvec AS vector)) AS distance
            FROM concepts c
            JOIN concept_embeddings ce ON ce.concept_id = c.id
            WHERE c.id IN (
                SELECT DISTINCT ci.concept_id
                FROM concept_introductions ci
                JOIN document_sections ds
                  ON ds.id = ci.document_section_id
                WHERE ds.document_id = ANY(:doc_ids)
            )
            ORDER BY distance ASC
            LIMIT :neighbor_limit
        )
        SELECT
            rc.concept_id,
            rc.canonical_name,
            rc.distance,
            sect.title AS section_title,
            sect.kind AS section_kind,
            sect.page_start AS page_start
        FROM ranked_concepts rc
        LEFT JOIN LATERAL (
            SELECT ds.title, ds.kind, ds.page_start
            FROM concept_introductions ci
            JOIN document_sections ds
              ON ds.id = ci.document_section_id
            WHERE ci.concept_id = rc.concept_id
              AND ds.document_id = ANY(:doc_ids)
            ORDER BY ds.page_start ASC NULLS LAST
            LIMIT 1
        ) sect ON TRUE
        ORDER BY rc.distance ASC
        """
    )
    try:
        result = await db.execute(
            sql,
            {
                "qvec": vector_literal,
                "doc_ids": document_ids,
                "neighbor_limit": int(limit),
            },
        )
        rows = result.all()
    except Exception as exc:  # noqa: BLE001
        logger.warning("concept_neighbor_query_failed: %s", exc)
        return []

    return [
        NeighborConcept(
            concept_name=row.canonical_name,
            section_title=row.section_title,
            section_kind=row.section_kind,
            page_start=row.page_start,
        )
        for row in rows
    ]
