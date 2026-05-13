"""Concept-graph builder.

Two passes:

1. ``build_concept_graph_for_document(db, doc_id)``
       Per-book pass. Reads the enriched ``document_sections`` for one
       document and writes Concept / ConceptIntroduction /
       ConceptApplication / ConceptEdge rows. Idempotent — wipes
       this document's prior contributions before rebuilding.

2. ``deduplicate_concepts_corpus(db)``
       Cross-book pass. Clusters concepts by embedding similarity,
       runs an LLM confirmation per cluster, merges duplicates into
       a single canonical concept, repoints introductions /
       applications / edges, and folds aliases.

Both passes share a small set of helpers (normalised-name lookup,
get-or-create with embedding) so the per-book run can safely create
new concepts and the cross-book run can merge them later without
data loss.

Why two passes rather than one global pass?
    Per-book runs cleanly as part of the Celery ingestion chain
    after section_mapping — bounded scope, bounded cost, one
    document at a time. Cross-book dedup needs the whole corpus
    in scope, takes a richer LLM prompt, and is fine to run as a
    separate one-shot CLI command (or scheduled job once we have
    many documents). Splitting them keeps the ingestion path
    fast and idempotent.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Iterable

import openai
from sqlalchemy import delete, select, text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.concept import (
    CONCEPT_EDGE_TYPES,
    Concept,
    ConceptApplication,
    ConceptEdge,
    ConceptEmbedding,
    ConceptIntroduction,
)
from app.models.document import DocumentSection

logger = logging.getLogger(__name__)


# Cosine-similarity threshold above which two concepts are *candidates*
# for a merge. The LLM still has to confirm — the threshold just
# prunes the search space. Empirically 0.88-0.93 catches the obvious
# aliases ("vector space" / "linear space") without flooding the LLM
# with noise.
_DEFAULT_DEDUP_SIMILARITY = 0.90

# When clustering for dedup, cap each cluster size. Larger clusters
# almost always indicate the threshold is too loose — better to spot-
# check than ship a 40-way merge.
_MAX_CLUSTER_SIZE = 8

# Batch size for concept embedding calls.
_EMBEDDING_BATCH = 64


# ---------------------------------------------------------------------------
# Normalisation
# ---------------------------------------------------------------------------


_WHITESPACE = re.compile(r"\s+")
_TRAILING_PUNCT = re.compile(r"[\s.,;:!?]+$")


def _normalise_concept_name(name: str) -> str:
    """Canonical form for the uniqueness check.

    Conservative — only lowercases, collapses whitespace, and strips
    trailing punctuation. We deliberately do not strip plurals or
    stem; those collapse meaning ("integrals" → "integral" is fine,
    but "groups" → "group" is dangerous because "group" is also a
    concept). The cross-book dedup pass uses embeddings + LLM
    confirmation for real synonymy detection.
    """
    cleaned = _WHITESPACE.sub(" ", name.strip().lower())
    cleaned = _TRAILING_PUNCT.sub("", cleaned)
    return cleaned


# ---------------------------------------------------------------------------
# OpenAI client (sync, same pattern as section_mapping)
# ---------------------------------------------------------------------------


def _get_openai_client() -> openai.OpenAI:
    return openai.OpenAI(api_key=settings.openai_api_key)


def _embedding_text(concept: Concept) -> str:
    """Text fed into the embeddings model for a concept.

    Concept embeddings answer "is this the same concept as another
    one in the corpus?" so we embed name + definition. Aliases are
    *not* embedded — by definition each alias resolves to the same
    canonical concept after dedup, so they'd just bias the vector
    toward the most-aliased nodes.
    """
    parts = [concept.canonical_name.strip()]
    if concept.canonical_definition:
        parts.append(concept.canonical_definition.strip())
    return " — ".join(parts)


def _create_embeddings(
    client: openai.OpenAI,
    concepts: list[Concept],
) -> dict[uuid.UUID, list[float]]:
    """Batched embedding generation. Returns concept_id → vector."""
    out: dict[uuid.UUID, list[float]] = {}
    if not concepts:
        return out
    for offset in range(0, len(concepts), _EMBEDDING_BATCH):
        batch = concepts[offset : offset + _EMBEDDING_BATCH]
        response = client.embeddings.create(
            model=settings.embedding_model,
            input=[_embedding_text(c) for c in batch],
            dimensions=settings.embedding_dimensions,
        )
        for concept, item in zip(batch, response.data):
            out[concept.id] = item.embedding
    return out


# ---------------------------------------------------------------------------
# Per-document build
# ---------------------------------------------------------------------------


@dataclass
class _DocumentBuildStats:
    sections_seen: int = 0
    concepts_created: int = 0
    concepts_reused: int = 0
    introductions: int = 0
    applications: int = 0
    edges: int = 0
    orphans_removed: int = 0
    # Concept-introduction entries skipped because the section
    # enricher could not back them with a verbatim source quote.
    # Surfaces in logs / CLI so unusually high skip rates flag a
    # book whose enrichment quality needs a closer look.
    skipped_unverified: int = 0


def _get_or_create_concept(
    db: Session,
    *,
    raw_name: str,
    raw_definition: str,
    difficulty: int | None,
    cache: dict[str, Concept],
    new_concepts: list[Concept],
) -> Concept:
    """Return a Concept row for this name, creating one if needed.

    Uses an in-process cache keyed by normalised name so a single
    build pass that sees the same concept many times doesn't issue
    a query per occurrence.

    ``difficulty`` is the minimum difficulty across sections that
    introduce this concept — i.e. concepts introduced in an easy
    section get a low difficulty tier, even if they're applied in
    harder sections later. This drives the "from-easy-to-hard"
    ordering in the path generator.
    """
    normalised = _normalise_concept_name(raw_name)
    if not normalised:
        raise ValueError(f"Concept name normalises to empty: {raw_name!r}")

    if normalised in cache:
        existing = cache[normalised]
        # Track the minimum difficulty across all sections that
        # introduce this concept (only meaningful for `introduce`
        # callers — we still cache the lookup either way).
        if difficulty is not None:
            existing.difficulty_tier = (
                difficulty
                if existing.difficulty_tier is None
                else min(existing.difficulty_tier, difficulty)
            )
        return existing

    existing = (
        db.query(Concept)
        .filter(Concept.canonical_name_normalised == normalised)
        .first()
    )
    if existing is not None:
        cache[normalised] = existing
        if difficulty is not None:
            existing.difficulty_tier = (
                difficulty
                if existing.difficulty_tier is None
                else min(existing.difficulty_tier, difficulty)
            )
        return existing

    concept = Concept(
        id=uuid.uuid4(),
        canonical_name=raw_name.strip(),
        canonical_name_normalised=normalised,
        canonical_definition=(raw_definition or "").strip()
        or f"(no definition yet — first seen for '{raw_name.strip()}')",
        aliases=[],
        difficulty_tier=difficulty,
        domain_tags=[],
    )
    db.add(concept)
    db.flush()  # need the id available for downstream foreign keys
    cache[normalised] = concept
    new_concepts.append(concept)
    return concept


def _delete_existing_contributions(db: Session, doc_id: uuid.UUID) -> None:
    """Wipe everything this document previously contributed to the
    graph. Lets the build pass run idempotently — re-running after
    a section_mapping rerun cleanly replaces, never duplicates.
    """
    # Find this document's section ids first so all the WHERE-IN
    # filters can use them.
    section_ids = [
        sid
        for (sid,) in db.execute(
            select(DocumentSection.id).where(
                DocumentSection.document_id == doc_id
            )
        )
    ]
    if not section_ids:
        return
    db.execute(
        delete(ConceptIntroduction).where(
            ConceptIntroduction.document_section_id.in_(section_ids)
        )
    )
    db.execute(
        delete(ConceptApplication).where(
            ConceptApplication.document_section_id.in_(section_ids)
        )
    )
    db.execute(
        delete(ConceptEdge).where(ConceptEdge.source_section_id.in_(section_ids))
    )
    db.flush()


def _sweep_orphan_concepts(db: Session, stats: _DocumentBuildStats) -> None:
    """Delete concepts that have no remaining introductions or
    applications. Necessary because per-document rebuilds remove
    this document's links but leave the Concept rows behind — over
    time they accumulate. Run at the end of every build pass.

    Embeddings cascade via the FK; edges referencing the deleted
    concept go too (FK CASCADE on both endpoints).
    """
    orphans = (
        db.query(Concept.id)
        .outerjoin(
            ConceptIntroduction,
            ConceptIntroduction.concept_id == Concept.id,
        )
        .outerjoin(
            ConceptApplication,
            ConceptApplication.concept_id == Concept.id,
        )
        .filter(ConceptIntroduction.id.is_(None))
        .filter(ConceptApplication.id.is_(None))
        .all()
    )
    if not orphans:
        return
    ids = [row.id for row in orphans]
    db.execute(delete(Concept).where(Concept.id.in_(ids)))
    stats.orphans_removed = len(ids)


def build_concept_graph_for_document(
    db: Session, doc_id: str
) -> dict[str, int]:
    """Rebuild this document's concept-graph contribution from its
    current section_mapping output.

    Side effects on the DB:
      * deletes prior ConceptIntroduction / ConceptApplication /
        ConceptEdge rows tied to any of this document's sections;
      * creates new Concept rows for any name not yet in the corpus
        (with an embedding) and reuses existing rows for names that
        already exist;
      * creates ConceptIntroduction rows for each section that
        introduces a concept;
      * creates ConceptApplication rows for each section's
        ``concepts_assumed`` entry;
      * creates prerequisite ConceptEdge rows for each
        (assumed, introduced) pair within a section;
      * sweeps orphan Concept rows (no remaining links).
    """
    document_uuid = uuid.UUID(doc_id)
    stats = _DocumentBuildStats()

    sections = (
        db.query(DocumentSection)
        .filter(DocumentSection.document_id == document_uuid)
        .filter(DocumentSection.kind == "headline")  # only leaves carry payloads
        .all()
    )
    if not sections:
        logger.warning(
            "[%s] concept_graph: no headlines found — section_mapping must run first",
            doc_id,
        )
        return {
            "sections_seen": 0,
            "concepts_created": 0,
            "concepts_reused": 0,
            "introductions": 0,
            "applications": 0,
            "edges": 0,
            "orphans_removed": 0,
        }

    _delete_existing_contributions(db, document_uuid)

    # In-memory cache: normalised name → Concept (already attached to
    # the session). Lets us reuse the same row when a concept appears
    # both as introduced (in section A) and assumed (in section B).
    cache: dict[str, Concept] = {}
    new_concepts: list[Concept] = []

    # Pass 1: introductions. Done first so the cache is warm with
    # canonical definitions before applications and edges look up the
    # same names — avoids creating a placeholder definition for a
    # concept that's about to be defined properly in this same pass.
    #
    # We skip entries the section-enrichment verifier could not back
    # with a verbatim source quote (``verified=false``). Those entries
    # are kept on the section payload for the admin review UI but
    # excluded from the corpus graph until a human approves them —
    # this keeps hallucinated concepts from propagating downstream.
    for section in sections:
        payload = section.content_json or {}
        difficulty = payload.get("difficulty")
        for entry in payload.get("concepts_introduced", []) or []:
            name = (entry.get("name") or "").strip()
            definition = (entry.get("definition") or "").strip()
            if not name:
                continue
            # Honour the section enricher's verified flag when present.
            # If the entry has no ``verified`` field (legacy payloads
            # from before the source-quote hardening), include it.
            if entry.get("verified") is False:
                stats.skipped_unverified += 1
                continue
            concept = _get_or_create_concept(
                db,
                raw_name=name,
                raw_definition=definition,
                difficulty=difficulty if isinstance(difficulty, int) else None,
                cache=cache,
                new_concepts=new_concepts,
            )
            # If this is a first introduction with a real definition,
            # upgrade the placeholder used during creation.
            if (
                definition
                and concept.canonical_definition.startswith(
                    "(no definition yet"
                )
            ):
                concept.canonical_definition = definition
            db.add(
                ConceptIntroduction(
                    id=uuid.uuid4(),
                    concept_id=concept.id,
                    document_section_id=section.id,
                    local_definition=definition or None,
                )
            )
            stats.introductions += 1

    # Pass 2: applications + prerequisite edges. We re-walk the same
    # sections; the cache is now populated so most lookups are O(1)
    # in-process.
    seen_edges: set[tuple[uuid.UUID, uuid.UUID, uuid.UUID]] = set()
    for section in sections:
        payload = section.content_json or {}
        assumed_names = [
            (n or "").strip()
            for n in (payload.get("concepts_assumed", []) or [])
            if (n or "").strip()
        ]
        introduced_names = [
            (entry.get("name") or "").strip()
            for entry in (payload.get("concepts_introduced", []) or [])
            if (entry.get("name") or "").strip()
            and entry.get("verified") is not False  # mirror Pass 1 filter
        ]

        # Build ConceptApplication rows for every assumed name.
        assumed_concepts: list[Concept] = []
        for name in assumed_names:
            concept = _get_or_create_concept(
                db,
                raw_name=name,
                raw_definition="",
                difficulty=None,  # difficulty only set by introducers
                cache=cache,
                new_concepts=new_concepts,
            )
            assumed_concepts.append(concept)
            db.add(
                ConceptApplication(
                    id=uuid.uuid4(),
                    concept_id=concept.id,
                    document_section_id=section.id,
                )
            )
            stats.applications += 1

        # Build prerequisite edges: every assumed concept → every
        # introduced concept in the same section.
        if assumed_concepts and introduced_names:
            for assumed in assumed_concepts:
                for intro_name in introduced_names:
                    introduced = cache.get(_normalise_concept_name(intro_name))
                    if introduced is None or introduced.id == assumed.id:
                        continue
                    key = (assumed.id, introduced.id, section.id)
                    if key in seen_edges:
                        continue
                    seen_edges.add(key)
                    db.add(
                        ConceptEdge(
                            id=uuid.uuid4(),
                            from_concept_id=assumed.id,
                            to_concept_id=introduced.id,
                            type="prerequisite",
                            strength=1.0,
                            source_section_id=section.id,
                        )
                    )
                    stats.edges += 1

        stats.sections_seen += 1

    # Embed any newly-created concepts so the cross-book dedup pass
    # can run later without a separate fixup. Reused concepts
    # already have embeddings.
    if new_concepts:
        client = _get_openai_client()
        embeddings = _create_embeddings(client, new_concepts)
        for concept in new_concepts:
            vec = embeddings.get(concept.id)
            if vec is not None:
                db.add(ConceptEmbedding(concept_id=concept.id, embedding=vec))
        stats.concepts_created = len(new_concepts)

    stats.concepts_reused = len(cache) - stats.concepts_created

    _sweep_orphan_concepts(db, stats)
    db.commit()

    logger.info(
        "[%s] concept_graph build: sections=%d new=%d reused=%d intros=%d apps=%d edges=%d orphans_removed=%d",
        doc_id,
        stats.sections_seen,
        stats.concepts_created,
        stats.concepts_reused,
        stats.introductions,
        stats.applications,
        stats.edges,
        stats.orphans_removed,
    )

    return {
        "sections_seen": stats.sections_seen,
        "concepts_created": stats.concepts_created,
        "concepts_reused": stats.concepts_reused,
        "introductions": stats.introductions,
        "applications": stats.applications,
        "edges": stats.edges,
        "orphans_removed": stats.orphans_removed,
    }


# ---------------------------------------------------------------------------
# Cross-book deduplication
# ---------------------------------------------------------------------------


_MERGE_CONFIRM_SYSTEM = """\
You are deciding whether several concept candidates from a technical \
corpus are the same concept (different names, plurals, abbreviations) \
or are genuinely distinct. Output STRICT JSON ONLY:

{
  "is_same_concept": <bool>,
  "canonical_name": <string, the name to use as the merged concept's display name>,
  "canonical_definition": <string, one sentence combining the best aspects of the candidate definitions>,
  "aliases": [<string>, ...]  // the OTHER names that map to the canonical
}

Rules:
  - Only return is_same_concept = true if the candidates *really* refer to the same idea.
    Two concepts with related-but-distinct meanings (e.g. "vector" and "vector space") are NOT the same.
  - Plurals, abbreviations, and synonyms ARE the same concept.
  - Pick canonical_name from the candidates; do not invent a new one.
  - Output ONLY the JSON object.\
"""


@dataclass
class _MergeCluster:
    concepts: list[Concept]


def _cluster_concepts_by_similarity(
    db: Session, threshold: float
) -> list[_MergeCluster]:
    """Find candidate merge clusters using a SQL self-join on the
    embeddings table with cosine-similarity threshold.

    Returns each cluster as a list of Concept rows. Singletons are
    not returned (no merge candidate).

    Implementation note: this builds the clusters via union-find
    over the pairs returned by SQL. For a corpus of ~1000 concepts
    that's a fraction of a second; we don't need a vector-DB-native
    clustering algorithm yet.
    """
    # Pairs where embedding similarity is >= threshold. Cosine
    # distance via pgvector is `<=>`; similarity = 1 - distance.
    # Raw SQL is the clearest way to express the pgvector operator
    # here. ``threshold`` is interpolated (not bound) because pgvector
    # versions on older Postgres can be finicky about bind parameters
    # inside operator positions. The value is a hard-coded float from
    # settings / CLI args, never user input.
    similarity_sql = text(
        f"""
        SELECT a.concept_id, b.concept_id, 1 - (a.embedding <=> b.embedding) AS similarity
        FROM concept_embeddings a
        JOIN concept_embeddings b ON b.concept_id > a.concept_id
        WHERE 1 - (a.embedding <=> b.embedding) >= {float(threshold)}
        ORDER BY a.concept_id, b.concept_id
        """
    )
    raw = db.execute(similarity_sql).all()

    # Union-find over the matched concept ids.
    parents: dict[uuid.UUID, uuid.UUID] = {}

    def find(x: uuid.UUID) -> uuid.UUID:
        while parents.get(x, x) != x:
            parents[x] = parents.get(parents.get(x, x), parents.get(x, x))
            x = parents.get(x, x)
        return x

    def union(a: uuid.UUID, b: uuid.UUID) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parents[ra] = rb

    for row in raw:
        a, b, _sim = row[0], row[1], row[2]
        parents.setdefault(a, a)
        parents.setdefault(b, b)
        union(a, b)

    if not parents:
        return []

    # Group by root parent.
    by_root: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    for member in parents:
        by_root[find(member)].append(member)
    cluster_ids = [members for members in by_root.values() if len(members) > 1]

    # Hydrate to Concept rows so the merge step has full context.
    clusters: list[_MergeCluster] = []
    for ids in cluster_ids:
        if len(ids) > _MAX_CLUSTER_SIZE:
            logger.warning(
                "concept_dedup: skipping cluster of size %d (> %d); "
                "lower the similarity threshold or break it up manually",
                len(ids),
                _MAX_CLUSTER_SIZE,
            )
            continue
        rows = db.query(Concept).filter(Concept.id.in_(ids)).all()
        if len(rows) >= 2:
            clusters.append(_MergeCluster(concepts=rows))
    return clusters


def _confirm_merge_with_llm(
    client: openai.OpenAI, cluster: _MergeCluster
) -> dict[str, Any] | None:
    """Ask gpt-4o whether the cluster members are the same concept.

    Returns the parsed JSON payload if confirmed, or ``None`` if the
    model says they're distinct / the response is malformed. The
    payload's ``canonical_name`` must match one of the candidates'
    canonical_name; if it doesn't, treat as malformed.
    """
    candidates = [
        {
            "id": str(c.id),
            "name": c.canonical_name,
            "definition": c.canonical_definition,
        }
        for c in cluster.concepts
    ]
    completion = client.chat.completions.create(
        model=settings.openai_reasoning_model,
        messages=[
            {"role": "system", "content": _MERGE_CONFIRM_SYSTEM},
            {
                "role": "user",
                "content": (
                    "Concept candidates:\n"
                    f"{json.dumps(candidates, ensure_ascii=False, indent=2)}"
                ),
            },
        ],
        response_format={"type": "json_object"},
        temperature=0,
    )
    raw = (completion.choices[0].message.content or "").strip()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("concept_dedup: malformed JSON response for cluster: %s", raw)
        return None
    if not parsed.get("is_same_concept"):
        return None
    canonical_name = (parsed.get("canonical_name") or "").strip()
    candidate_names = {c.canonical_name for c in cluster.concepts}
    if canonical_name not in candidate_names:
        logger.warning(
            "concept_dedup: model invented canonical_name %r; treating as malformed",
            canonical_name,
        )
        return None
    return parsed


def _merge_cluster(
    db: Session,
    cluster: _MergeCluster,
    payload: dict[str, Any],
) -> None:
    """Repoint introductions/applications/edges from each non-canonical
    member to the canonical one, fold member names into aliases,
    and delete the absorbed concepts."""
    canonical_name = payload["canonical_name"]
    canonical_definition = (payload.get("canonical_definition") or "").strip()
    extra_aliases = [str(a).strip() for a in (payload.get("aliases") or []) if str(a).strip()]

    survivor = next(c for c in cluster.concepts if c.canonical_name == canonical_name)
    if canonical_definition:
        survivor.canonical_definition = canonical_definition
    existing_aliases = set(survivor.aliases or [])
    for c in cluster.concepts:
        if c.id == survivor.id:
            continue
        existing_aliases.add(c.canonical_name)
    for alias in extra_aliases:
        existing_aliases.add(alias)
    # Don't list the canonical name as its own alias.
    existing_aliases.discard(survivor.canonical_name)
    survivor.aliases = sorted(existing_aliases)

    for absorbed in cluster.concepts:
        if absorbed.id == survivor.id:
            continue
        # Repoint introductions / applications. Use ON CONFLICT DO
        # NOTHING semantics via "merge if missing": the unique
        # constraints on (concept_id, document_section_id) mean a
        # section that introduced both A and B (already-absorbed)
        # would otherwise collide.
        db.execute(
            delete(ConceptIntroduction).where(
                ConceptIntroduction.concept_id == absorbed.id,
                ConceptIntroduction.document_section_id.in_(
                    select(ConceptIntroduction.document_section_id).where(
                        ConceptIntroduction.concept_id == survivor.id
                    )
                ),
            )
        )
        db.execute(
            delete(ConceptApplication).where(
                ConceptApplication.concept_id == absorbed.id,
                ConceptApplication.document_section_id.in_(
                    select(ConceptApplication.document_section_id).where(
                        ConceptApplication.concept_id == survivor.id
                    )
                ),
            )
        )
        db.execute(
            ConceptIntroduction.__table__.update()
            .where(ConceptIntroduction.concept_id == absorbed.id)
            .values(concept_id=survivor.id)
        )
        db.execute(
            ConceptApplication.__table__.update()
            .where(ConceptApplication.concept_id == absorbed.id)
            .values(concept_id=survivor.id)
        )
        # Repoint edges. Some of the absorbed concept's edges may
        # become self-loops (e.g. an edge A → B where A and B are
        # now both `survivor`); delete those instead of repointing.
        db.execute(
            delete(ConceptEdge).where(
                (
                    (ConceptEdge.from_concept_id == absorbed.id)
                    & (ConceptEdge.to_concept_id == survivor.id)
                )
                | (
                    (ConceptEdge.from_concept_id == survivor.id)
                    & (ConceptEdge.to_concept_id == absorbed.id)
                )
            )
        )
        db.execute(
            ConceptEdge.__table__.update()
            .where(ConceptEdge.from_concept_id == absorbed.id)
            .values(from_concept_id=survivor.id)
        )
        db.execute(
            ConceptEdge.__table__.update()
            .where(ConceptEdge.to_concept_id == absorbed.id)
            .values(to_concept_id=survivor.id)
        )
        # And finally drop the absorbed concept itself (embedding
        # cascades).
        db.execute(delete(Concept).where(Concept.id == absorbed.id))


def deduplicate_concepts_corpus(
    db: Session,
    similarity_threshold: float = _DEFAULT_DEDUP_SIMILARITY,
) -> dict[str, int]:
    """Cluster concepts by embedding similarity and merge confirmed
    duplicates. Returns stats.

    Safe to run repeatedly — already-merged concepts have no
    duplicates to find, so subsequent runs are near-no-ops.

    Runs the LLM confirmation per cluster. For a corpus that's been
    growing one book at a time, expect just a handful of clusters
    per run.
    """
    clusters = _cluster_concepts_by_similarity(db, similarity_threshold)
    if not clusters:
        logger.info(
            "concept_dedup: no merge clusters at similarity >= %s",
            similarity_threshold,
        )
        return {"clusters_examined": 0, "merges_performed": 0, "concepts_merged": 0}

    client = _get_openai_client()
    merges_performed = 0
    concepts_merged = 0

    for cluster in clusters:
        payload = _confirm_merge_with_llm(client, cluster)
        if payload is None:
            continue
        _merge_cluster(db, cluster, payload)
        merges_performed += 1
        concepts_merged += len(cluster.concepts) - 1

    db.commit()
    logger.info(
        "concept_dedup: clusters=%d merges=%d concepts_merged=%d",
        len(clusters),
        merges_performed,
        concepts_merged,
    )
    return {
        "clusters_examined": len(clusters),
        "merges_performed": merges_performed,
        "concepts_merged": concepts_merged,
    }


# ---------------------------------------------------------------------------
# Query helpers (used by the path generator)
# ---------------------------------------------------------------------------


def trace_prerequisites(
    db: Session,
    target_concept_id: uuid.UUID,
    known_concept_ids: Iterable[uuid.UUID] = (),
    *,
    max_depth: int = 10,
) -> list[uuid.UUID]:
    """Return the topologically-ordered prerequisite concept ids for
    a target concept, pruning out concepts already known.

    Walks ``concept_edges`` backward (``to_concept = target``) along
    ``type = 'prerequisite'`` edges. Breadth-first to keep the path
    short; depth-capped to bound runtime on pathological graphs.

    The returned list does NOT include ``target_concept_id`` itself
    — the caller is presumably planning to *cover* the target after
    its prerequisites, not as one of them.
    """
    known = set(known_concept_ids)
    visited: set[uuid.UUID] = {target_concept_id, *known}
    frontier: list[uuid.UUID] = [target_concept_id]
    ordered: list[uuid.UUID] = []
    for _ in range(max_depth):
        if not frontier:
            break
        edges = db.execute(
            select(ConceptEdge.from_concept_id)
            .where(ConceptEdge.to_concept_id.in_(frontier))
            .where(ConceptEdge.type == "prerequisite")
        )
        next_frontier: list[uuid.UUID] = []
        for (from_id,) in edges:
            if from_id in visited:
                continue
            visited.add(from_id)
            ordered.append(from_id)
            next_frontier.append(from_id)
        frontier = next_frontier

    # Topological-ish ordering: reverse the BFS frontier order so
    # foundational concepts come first.
    return list(reversed(ordered))


def compute_coverage(
    target_concept_ids: Iterable[uuid.UUID],
    known_concept_ids: Iterable[uuid.UUID],
) -> float:
    """Fraction of target concepts the user already knows. 0..1.

    Used for the "you're 60% of the way to your goal" progress UI.
    Pure function — operates on already-fetched id sets, no DB I/O.
    """
    targets = list(target_concept_ids)
    if not targets:
        return 1.0
    known = set(known_concept_ids)
    return sum(1 for t in targets if t in known) / len(targets)
