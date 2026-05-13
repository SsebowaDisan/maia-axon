"""Per-section question bank generator.

For each enriched headline in a document, asks gpt-4o to produce a
mixed bank of check-in questions (recognition / application /
explanation), validates each one against a strict schema, runs math
questions through the SymPy grader to confirm the stored answer
actually solves them, and persists the survivors as ``section_questions``
rows.

Sits in the ingestion chain after ``run_section_mapping_stage`` so
section enrichment + concept graph + question bank can all be derived
from the same offline pass. Wired separately so it can be re-run
in isolation when iterating on the question prompt.

Why per-section caching, not on-demand?
    Each section's questions are generated once at ingestion and
    cached. At check-in time we just read them — no LLM latency in
    the user-facing path. The trade-off is upfront cost
    (~6-8 generation calls per section, plus a few math validations)
    against repeatable, fast, deterministic check-ins forever after.
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass
from typing import Any

import openai
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.concept import Concept
from app.models.document import DocumentSection
from app.models.question import QUESTION_TYPES, SectionQuestion
from app.services.grading import (
    GraderError,
    grade_numeric,
    grade_symbolic,
)

logger = logging.getLogger(__name__)


# Per-headline retry cap (mirrors section_mapping).
_MAX_CORRECTIVE_RETRIES = 2

# Hard target for how many questions per section. The prompt asks
# for 6-8 across types; we accept anything in [4, 10] to absorb
# model variance.
_MIN_QUESTIONS = 4
_MAX_QUESTIONS = 10

# Cap on raw text included in the prompt — same reasoning as in
# section_mapping; the structured enrichment payload carries most
# of the signal.
_SECTION_TEXT_MAX_CHARS = 8_000


# ---------------------------------------------------------------------------
# Generator prompt
# ---------------------------------------------------------------------------


_QUESTION_GEN_SYSTEM = """\
You are generating check-in questions for ONE section of a technical book.

Output STRICT JSON ONLY with this shape:

{
  "questions": [
    {
      "question_type": "mcq" | "numeric" | "symbolic" | "free_text" | "counterexample",
      "stem": <string>,
      "concept_names": [<string>, ...],
      "difficulty": <int 1..5>,
      "estimated_seconds": <int>,
      "explanation": <string, shown after grading>,
      "source_quote": <string, a SHORT verbatim quote (≤200 chars) from the section's enrichment payload — typically the concept definition or equation latex — that the question is grounded in>,
      "confidence": <int 0..3, 0=guess, 3=grounded in a direct quote with an unambiguous answer>,

      // Required when question_type == "mcq" or "counterexample" (MCQ flavour):
      "choices": [
        {"label": "A", "text": <string>, "is_correct": <bool>, "misconception": <string | null>},
        ...
      ],

      // Required when question_type == "numeric":
      "numeric": {
        "correct_value": <float>,
        "tolerance": <float>,        // absolute, in answer units
        "unit": <string | null>,
        "alternate_forms": [<string>, ...]
      },

      // Required when question_type == "symbolic":
      "symbolic": {
        "correct_expression_latex": <string>,
        "variables": [<string>, ...],
        "domain_constraints": <string | null>
      },

      // Required when question_type == "free_text" or "counterexample" (rubric flavour):
      "rubric": {
        "criteria": [
          {
            "criterion": <string>,
            "expected_signal": <string, what an answer satisfying this looks like>,
            "misconception_if_missing": <string | null>
          },
          ...
        ],
        "pass_threshold": <int, min criteria satisfied to pass>
      }
    },
    ...
  ]
}

Generate 6-8 questions per section. Mix:
  - 2-3 mcq (recognition)
  - 2-3 numeric or symbolic (application)
  - 1-2 free_text or counterexample (explanation / synthesis)

Rules:
  - Every question must test a concept the section actually introduces or applies.
  - "concept_names" must be exact matches of names from the section's "concepts_introduced" or "concepts_assumed" list.
  - "source_quote" MUST be a verbatim substring of either a concept definition, a key equation, or any field of the section enrichment payload you are given. Do NOT invent quotes. If you cannot ground a question in a quote, do not generate that question.
  - For MCQ: exactly 4 choices, exactly ONE marked is_correct=true. Distractors must map to plausible misconceptions, not nonsense. Set misconception=null only for the correct choice or for a distractor that's wrong but doesn't reflect a specific misconception. NEVER include a choice that is a trivial paraphrase of the stem ("answerable without reading the section") — the question should require recall or reasoning that depends on the section content.
  - For numeric: "correct_value" must be solvable from the section's content (equations, given values). Tolerance generous enough to absorb rounding (e.g. 0.5% of the value for engineering answers).
  - For symbolic: "correct_expression_latex" must be a valid LaTeX expression in SymPy-parseable form. Variables you reference must be listed in "variables".
  - For free_text: 2-4 criteria. Each "criterion" describes one point the answer must address. "pass_threshold" defaults to ceil(criteria_count / 2).
  - "explanation" gives the canonical reasoning for the correct answer in 1-3 sentences.
  - "confidence": be honest. Use 0-1 when the answer is debatable or you had to guess.
  - PREFER FEWER, BETTER QUESTIONS to many shaky ones. If you can only ground 4 questions in quotes, output 4.

Output ONLY the JSON object.\
"""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_openai_client() -> openai.OpenAI:
    return openai.OpenAI(api_key=settings.openai_api_key)


@dataclass
class _GenStats:
    sections_processed: int = 0
    questions_generated: int = 0
    questions_kept: int = 0
    questions_rejected_schema: int = 0
    questions_rejected_math: int = 0
    # MCQ rejected because a blind-solver pass (just stem + choices,
    # no section context) got it right — strong signal the question
    # is trivial or its answer is given away by the choice wording.
    questions_rejected_leaky: int = 0


class _QuestionSchemaError(ValueError):
    pass


def _validate_question(q: Any) -> None:
    """Strict per-question schema check. Raises ``_QuestionSchemaError``
    so the caller can surface a corrective retry prompt."""
    if not isinstance(q, dict):
        raise _QuestionSchemaError("question must be an object")
    qtype = q.get("question_type")
    if qtype not in QUESTION_TYPES:
        raise _QuestionSchemaError(
            f"'question_type' must be one of {QUESTION_TYPES}, got {qtype!r}"
        )
    stem = q.get("stem")
    if not isinstance(stem, str) or not stem.strip():
        raise _QuestionSchemaError("'stem' must be a non-empty string")
    concept_names = q.get("concept_names")
    if not isinstance(concept_names, list) or not all(
        isinstance(n, str) and n.strip() for n in concept_names
    ):
        raise _QuestionSchemaError("'concept_names' must be a list of non-empty strings")
    if not isinstance(q.get("difficulty"), int) or not 1 <= q["difficulty"] <= 5:
        raise _QuestionSchemaError("'difficulty' must be int 1..5")
    if not isinstance(q.get("estimated_seconds"), int) or q["estimated_seconds"] <= 0:
        raise _QuestionSchemaError("'estimated_seconds' must be positive int")
    explanation = q.get("explanation")
    if not isinstance(explanation, str) or not explanation.strip():
        raise _QuestionSchemaError("'explanation' must be a non-empty string")

    # source_quote and confidence are optional in the schema but
    # surface in the admin review UI when present.
    sq = q.get("source_quote")
    if sq is not None and not isinstance(sq, str):
        raise _QuestionSchemaError("'source_quote' must be a string when provided")
    conf = q.get("confidence")
    if conf is not None and (not isinstance(conf, int) or not 0 <= conf <= 3):
        raise _QuestionSchemaError("'confidence' must be an int in 0..3 when provided")

    if qtype == "mcq" or (qtype == "counterexample" and "choices" in q):
        choices = q.get("choices")
        if not isinstance(choices, list) or len(choices) < 2:
            raise _QuestionSchemaError("MCQ 'choices' must be a list of >= 2 items")
        labels = [str(c.get("label", "")).strip() for c in choices]
        if len(set(labels)) != len(labels) or any(not l for l in labels):
            raise _QuestionSchemaError("MCQ 'choices' must have unique non-empty labels")
        correct_count = sum(1 for c in choices if c.get("is_correct"))
        if correct_count != 1:
            raise _QuestionSchemaError(
                f"MCQ must have exactly ONE correct choice, got {correct_count}"
            )
        for c in choices:
            if not isinstance(c.get("text"), str) or not c["text"].strip():
                raise _QuestionSchemaError("MCQ choice 'text' must be a non-empty string")
        # Distractor uniqueness on text (case-insensitive, whitespace-collapsed).
        normalised = [c["text"].strip().lower() for c in choices]
        if len(set(normalised)) != len(normalised):
            raise _QuestionSchemaError("MCQ choices must have unique text")

    elif qtype == "numeric":
        block = q.get("numeric")
        if not isinstance(block, dict):
            raise _QuestionSchemaError("numeric question missing 'numeric' block")
        if not isinstance(block.get("correct_value"), (int, float)):
            raise _QuestionSchemaError("numeric 'correct_value' must be a number")
        if not isinstance(block.get("tolerance"), (int, float)) or block["tolerance"] < 0:
            raise _QuestionSchemaError("numeric 'tolerance' must be non-negative number")

    elif qtype == "symbolic":
        block = q.get("symbolic")
        if not isinstance(block, dict):
            raise _QuestionSchemaError("symbolic question missing 'symbolic' block")
        expr = block.get("correct_expression_latex")
        if not isinstance(expr, str) or not expr.strip():
            raise _QuestionSchemaError(
                "symbolic 'correct_expression_latex' must be a non-empty string"
            )
        variables = block.get("variables")
        if not isinstance(variables, list) or not all(
            isinstance(v, str) for v in variables
        ):
            raise _QuestionSchemaError("symbolic 'variables' must be a list of strings")

    elif qtype == "free_text" or (qtype == "counterexample" and "rubric" in q):
        rubric = q.get("rubric")
        if not isinstance(rubric, dict):
            raise _QuestionSchemaError("rubric block must be an object")
        criteria = rubric.get("criteria")
        if not isinstance(criteria, list) or len(criteria) < 1:
            raise _QuestionSchemaError("rubric 'criteria' must be a list of >= 1 items")
        for c in criteria:
            if not isinstance(c, dict):
                raise _QuestionSchemaError("each rubric criterion must be an object")
            if not isinstance(c.get("criterion"), str) or not c["criterion"].strip():
                raise _QuestionSchemaError("rubric 'criterion' must be a non-empty string")
        threshold = rubric.get("pass_threshold")
        if not isinstance(threshold, int) or threshold < 1 or threshold > len(criteria):
            raise _QuestionSchemaError(
                f"rubric 'pass_threshold' must be int in 1..{len(criteria)}"
            )

    else:
        # counterexample with neither choices nor rubric — ambiguous shape.
        if qtype == "counterexample":
            raise _QuestionSchemaError(
                "counterexample question must carry either 'choices' or 'rubric'"
            )


_LEAKAGE_CHECK_SYSTEM = (
    "You are a careful test-taker. Answer the following multiple-choice question "
    "USING ONLY the stem and the choices — you do not have the source material. "
    "If the stem or wording makes the answer obvious without any subject knowledge, "
    "pick it. Otherwise, if you have no way to know, reply 'IDK'. "
    "Reply with ONLY the choice label (A/B/C/D) or 'IDK' — no explanation."
)


def _mcq_is_leaky(
    client: openai.OpenAI, q: dict[str, Any]
) -> tuple[bool, str | None]:
    """Run a blind-solver call on an MCQ to detect questions whose
    answer leaks through wording alone.

    Strategy: ask gpt-4o to answer the question with NO section
    context. If it picks the correct label, the question is too
    easy or self-revealing — flag it as leaky. If it picks a wrong
    label or says IDK, the question genuinely depends on the
    section content and is keepable.

    Cost: one short call per MCQ. We restrict to MCQ because numeric
    / symbolic / free-text leakage is much rarer (they require
    actually computing or arguing something).

    Returns ``(is_leaky, reason)``. ``reason`` is set when leaky.
    """
    choices = q.get("choices") or []
    if not choices:
        return False, None
    correct = next((c for c in choices if c.get("is_correct")), None)
    if correct is None:
        return False, None

    rendered = "\n".join(
        f"{c.get('label', '?')}. {c.get('text', '')}"
        for c in choices
    )
    prompt = f"Question:\n{q.get('stem', '')}\n\nChoices:\n{rendered}"
    try:
        completion = client.chat.completions.create(
            model=settings.openai_reasoning_model,
            messages=[
                {"role": "system", "content": _LEAKAGE_CHECK_SYSTEM},
                {"role": "user", "content": prompt},
            ],
            temperature=0,
            max_tokens=8,
        )
        reply = (completion.choices[0].message.content or "").strip().upper()
    except Exception as exc:
        # Don't fail the whole question pipeline if the leakage
        # check itself errors — just keep the question, log warning.
        logger.warning("leakage_check_error: %s", exc)
        return False, None

    correct_label = str(correct.get("label", "")).strip().upper()
    # Match if reply starts with the correct label (allow "A." or "A) "
    # responses) and is not "IDK".
    if reply.startswith("IDK"):
        return False, None
    if correct_label and reply.startswith(correct_label):
        return True, f"blind-solver picked the correct label {correct_label!r}"
    return False, None


def _math_question_self_grades_correct(q: dict[str, Any]) -> tuple[bool, str | None]:
    """Run the question's correct answer through the live grader to
    confirm the stored payload is internally consistent.

    For numeric: feed ``correct_value`` (formatted with unit if any)
    as the user input and confirm the grader marks it correct.
    For symbolic: feed ``correct_expression_latex`` as the user input
    and confirm the grader marks it correct (proves the expression is
    parseable and the comparison logic terminates).

    Returns ``(is_consistent, reason_or_None)``.
    """
    qtype = q["question_type"]
    try:
        if qtype == "numeric":
            block = q["numeric"]
            text = f"{block['correct_value']}"
            if block.get("unit"):
                text = f"{text} {block['unit']}"
            payload = {
                "correct_value": float(block["correct_value"]),
                "tolerance": float(block["tolerance"]),
                "unit": block.get("unit"),
                "alternate_forms": block.get("alternate_forms") or [],
            }
            result = grade_numeric(text, payload)
            return result.is_correct, None if result.is_correct else result.feedback

        if qtype == "symbolic":
            block = q["symbolic"]
            payload = {
                "correct_expression_latex": block["correct_expression_latex"],
                "variables": block.get("variables") or [],
                "domain_constraints": block.get("domain_constraints"),
            }
            result = grade_symbolic(
                block["correct_expression_latex"], payload
            )
            return result.is_correct, None if result.is_correct else result.feedback
    except GraderError as exc:
        return False, str(exc)
    except Exception as exc:  # noqa: BLE001
        # Any other grader exception (offset-unit math, pint parser
        # quirks, sympy hangs surfaced as RuntimeError, etc.) — treat
        # the question as inconsistent and drop it. Better one missing
        # question than a whole pipeline crashed for a 139-page book.
        return False, f"grader_internal_error: {exc.__class__.__name__}: {exc}"
    return True, None  # non-math types: trivially "consistent"


def _to_section_question(
    *,
    q: dict[str, Any],
    section_id: uuid.UUID,
    concept_lookup: dict[str, uuid.UUID],
    display_ordinal: int,
) -> SectionQuestion:
    """Translate the generator's payload into a SectionQuestion row."""
    qtype = q["question_type"]
    # Build the SectionQuestion.payload column per type.
    if qtype == "mcq" or (qtype == "counterexample" and "choices" in q):
        payload = {"choices": q["choices"]}
    elif qtype == "numeric":
        payload = q["numeric"]
    elif qtype == "symbolic":
        payload = q["symbolic"]
    else:  # free_text or counterexample with rubric
        payload = q["rubric"]

    # Forward review metadata (source_quote, confidence, leakage)
    # onto the stored payload so the admin review UI can render and
    # sort by them. These keys are namespaced under ``__review`` so
    # they don't collide with type-specific payload fields.
    review_meta: dict[str, Any] = {}
    if q.get("source_quote"):
        review_meta["source_quote"] = q["source_quote"]
    if isinstance(q.get("confidence"), int):
        review_meta["confidence"] = q["confidence"]
    if q.get("leakage_flag"):
        review_meta["leakage_flag"] = q["leakage_flag"]
    if review_meta:
        payload = {**payload, "__review": review_meta}

    # Map concept names → concept UUIDs (the LLM's normalised name
    # may differ in casing, hence the lookup table built outside).
    concept_ids: list[str] = []
    misconception_tags: list[str] = []
    for name in q.get("concept_names", []) or []:
        cid = concept_lookup.get(name.strip().lower())
        if cid is not None:
            concept_ids.append(str(cid))
    # Pull misconception tags off MCQ distractors and rubric criteria.
    if qtype == "mcq" or (qtype == "counterexample" and "choices" in q):
        for choice in q["choices"]:
            tag = (choice.get("misconception") or "").strip()
            if tag:
                misconception_tags.append(tag)
    elif qtype in ("free_text", "counterexample"):
        for criterion in q.get("rubric", {}).get("criteria", []):
            tag = (criterion.get("misconception_if_missing") or "").strip()
            if tag:
                misconception_tags.append(tag)

    return SectionQuestion(
        id=uuid.uuid4(),
        section_id=section_id,
        question_type=qtype,
        stem=q["stem"],
        payload=payload,
        explanation=q["explanation"],
        concept_ids=concept_ids,
        difficulty=int(q["difficulty"]),
        estimated_seconds=int(q["estimated_seconds"]),
        misconception_tags=sorted(set(misconception_tags)),
        display_ordinal=display_ordinal,
    )


# ---------------------------------------------------------------------------
# Per-section generation
# ---------------------------------------------------------------------------


def _generate_questions_for_section(
    client: openai.OpenAI,
    section: DocumentSection,
    stats: _GenStats,
) -> list[dict[str, Any]]:
    """Run the gpt-4o generation call with schema validation +
    corrective retries. Returns the list of validated question
    dicts (math-validation happens after, at storage time)."""
    enrichment = section.content_json or {}
    if not enrichment.get("concepts_introduced") and not enrichment.get("concepts_assumed"):
        logger.info(
            "skipping question generation for section %s (%r) — no concepts in payload",
            section.id,
            section.title,
        )
        return []

    user_prompt = (
        f"Section title: {section.title}\n"
        f"Page range: {section.page_start}–{section.page_end}\n\n"
        "Section enrichment payload:\n"
        f"{json.dumps(enrichment, ensure_ascii=False, indent=2)}"
    )

    last_error: str | None = None
    last_raw: str | None = None
    for attempt in range(_MAX_CORRECTIVE_RETRIES + 1):
        if attempt == 0:
            prompt = user_prompt
        else:
            prompt = (
                "Your previous response was invalid: "
                f"{last_error}\n\n"
                f"Previous response (DO NOT REPEAT THE SAME MISTAKE):\n{last_raw}\n\n"
                "Re-run the original task. Original input:\n\n"
                f"{user_prompt}"
            )

        completion = client.chat.completions.create(
            model=settings.openai_reasoning_model,
            messages=[
                {"role": "system", "content": _QUESTION_GEN_SYSTEM},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0,
        )
        last_raw = (completion.choices[0].message.content or "").strip()

        try:
            parsed = json.loads(last_raw)
        except json.JSONDecodeError as exc:
            last_error = f"output was not valid JSON ({exc.msg} at char {exc.pos})"
            logger.warning(
                "question_gen JSON parse failed attempt=%d section=%s",
                attempt,
                section.id,
            )
            continue

        questions = parsed.get("questions")
        if not isinstance(questions, list) or not questions:
            last_error = "'questions' must be a non-empty list"
            continue
        if not _MIN_QUESTIONS <= len(questions) <= _MAX_QUESTIONS:
            last_error = (
                f"questions count {len(questions)} is outside "
                f"[{_MIN_QUESTIONS}, {_MAX_QUESTIONS}]"
            )
            continue

        # Validate every question. We accept partial banks (drop bad
        # individual questions, keep the good ones) as long as at
        # least _MIN_QUESTIONS survive — re-running the whole call
        # for one bad question would balloon cost.
        accepted: list[dict[str, Any]] = []
        for q in questions:
            try:
                _validate_question(q)
            except _QuestionSchemaError as exc:
                stats.questions_rejected_schema += 1
                logger.warning(
                    "rejected question (schema) section=%s reason=%s",
                    section.id,
                    exc,
                )
                continue
            accepted.append(q)

        if len(accepted) < _MIN_QUESTIONS:
            last_error = (
                f"only {len(accepted)} questions passed schema "
                f"(need ≥ {_MIN_QUESTIONS}). Re-generate from scratch."
            )
            continue

        stats.questions_generated += len(questions)
        return accepted

    raise RuntimeError(
        f"Question generation failed for section {section.id} ({section.title!r}) "
        f"after {_MAX_CORRECTIVE_RETRIES + 1} attempts. Last error: {last_error}"
    )


# ---------------------------------------------------------------------------
# Concept lookup helper
# ---------------------------------------------------------------------------


def _build_concept_lookup(db: Session, doc_id: uuid.UUID) -> dict[str, uuid.UUID]:
    """Pre-fetch every concept touched by this document so the
    generator can map name → concept_id in O(1).

    Keys are the *normalised* names (lowercased + stripped) so the
    generator's slightly-different casing still resolves.
    """
    rows = db.execute(
        select(Concept.id, Concept.canonical_name_normalised, Concept.aliases)
        .distinct()
    ).all()
    lookup: dict[str, uuid.UUID] = {}
    for cid, normalised, aliases in rows:
        lookup[normalised] = cid
        for alias in aliases or []:
            lookup[alias.strip().lower()] = cid
    return lookup


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


def generate_questions_for_document(db: Session, doc_id: str) -> dict[str, int]:
    """End-to-end: regenerate every headline's question bank from
    its current enrichment payload.

    Idempotent. Wipes the document's existing ``section_questions``
    rows first, then inserts the fresh bank in one transaction per
    section. Math questions that fail self-grading are dropped (the
    section keeps any others that passed).
    """
    document_uuid = uuid.UUID(doc_id)
    stats = _GenStats()

    headlines = (
        db.query(DocumentSection)
        .filter(DocumentSection.document_id == document_uuid)
        .filter(DocumentSection.kind == "headline")
        .all()
    )
    if not headlines:
        logger.warning(
            "[%s] question_generation: no headlines — run section_mapping first",
            doc_id,
        )
        return {
            "sections_processed": 0,
            "questions_generated": 0,
            "questions_kept": 0,
            "questions_rejected_schema": 0,
            "questions_rejected_math": 0,
        }

    # Wipe the document's existing question bank wholesale. CASCADE on
    # the section FK doesn't fire here because we're not deleting
    # sections — so an explicit delete is needed.
    section_ids = [h.id for h in headlines]
    db.execute(
        delete(SectionQuestion).where(SectionQuestion.section_id.in_(section_ids))
    )
    db.flush()

    concept_lookup = _build_concept_lookup(db, document_uuid)
    client = _get_openai_client()

    for index, section in enumerate(headlines, start=1):
        logger.info(
            "[%s] generating questions %d/%d: %r",
            doc_id,
            index,
            len(headlines),
            section.title,
        )
        try:
            questions = _generate_questions_for_section(client, section, stats)
        except RuntimeError as exc:
            # Don't kill the whole pass on one bad section — log and
            # move on. The section just ends up without questions;
            # learn mode degrades gracefully.
            logger.error(
                "[%s] question generation failed for section %r: %s",
                doc_id,
                section.title,
                exc,
            )
            continue

        # Math self-validation + MCQ leakage check.
        # - Numeric/symbolic: re-grade the stored correct answer
        #   through the live grader; drop any that don't round-trip.
        # - MCQ: blind-solver pass — answer the question with NO
        #   section context; if the model gets it right just from
        #   stem + choice wording, the question is leaky and we
        #   drop it rather than ship a freebie.
        kept_payloads: list[dict[str, Any]] = []
        for q in questions:
            if q["question_type"] in ("numeric", "symbolic"):
                ok, reason = _math_question_self_grades_correct(q)
                if not ok:
                    stats.questions_rejected_math += 1
                    logger.warning(
                        "[%s] rejected math question (self-grade failed) "
                        "section=%r reason=%s",
                        doc_id,
                        section.title,
                        reason,
                    )
                    continue
            if q["question_type"] in ("mcq", "counterexample") and (q.get("choices")):
                leaky, leak_reason = _mcq_is_leaky(client, q)
                if leaky:
                    stats.questions_rejected_leaky += 1
                    logger.info(
                        "[%s] dropped leaky MCQ section=%r reason=%s stem=%r",
                        doc_id,
                        section.title,
                        leak_reason,
                        q.get("stem", "")[:100],
                    )
                    continue
            kept_payloads.append(q)

        # Persist.
        for ordinal, q in enumerate(kept_payloads):
            row = _to_section_question(
                q=q,
                section_id=section.id,
                concept_lookup=concept_lookup,
                display_ordinal=ordinal,
            )
            db.add(row)
            stats.questions_kept += 1
        stats.sections_processed += 1
        db.flush()

    db.commit()
    logger.info(
        "[%s] question_generation complete: sections=%d generated=%d kept=%d rejected_schema=%d rejected_math=%d",
        doc_id,
        stats.sections_processed,
        stats.questions_generated,
        stats.questions_kept,
        stats.questions_rejected_schema,
        stats.questions_rejected_math,
    )
    return {
        "sections_processed": stats.sections_processed,
        "questions_generated": stats.questions_generated,
        "questions_kept": stats.questions_kept,
        "questions_rejected_schema": stats.questions_rejected_schema,
        "questions_rejected_math": stats.questions_rejected_math,
    }
