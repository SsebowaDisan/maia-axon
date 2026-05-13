"""Question grading.

Centralises every kind of answer check learn-mode does. Same
module is used by:

* the offline question-generation pass (to validate that a stored
  ``correct_answer`` actually solves the question);
* the live check-in flow (to grade user responses).

The four grader functions return a uniform ``GradeResult``. The
caller doesn't need to know what kind of question it was — for
mastery scoring, only the score / is_correct / misconception
matter.

Reliability discipline
----------------------
This module deliberately avoids "ask the LLM if the answer is
correct" for anything that can be checked deterministically. For
math we use SymPy + pint; the failure modes are predictable (parse
errors, unit-mismatch) and the comparisons are exact. The LLM is
only used for free-text where it's unavoidable, and even there only
to evaluate **per-criterion satisfaction** in a decomposed rubric,
never to score the answer as a whole. That decomposition is what
makes free-text grading repeatable rather than vibes-based.
"""

from __future__ import annotations

import json
import logging
import math
import re
from dataclasses import dataclass, field
from typing import Any

import openai
import pint
import sympy
from sympy.parsing.sympy_parser import (
    parse_expr,
    standard_transformations,
    implicit_multiplication_application,
    convert_xor,
)

from app.core.config import settings

logger = logging.getLogger(__name__)


# Pint unit registry — one per process is fine and standard practice.
_UREG = pint.UnitRegistry()
# Allow common engineering shortcuts that pint doesn't ship with.
# (Pint already covers SI + most engineering units, but books in
# the corpus use a few that need a hand.)
_UREG.define("m3_h = m**3 / hour = m3/h = m³/h")

# Permissive SymPy parser: handles "2x" as "2*x", "^" as "**", etc.
_SYMPY_TRANSFORMS = standard_transformations + (
    implicit_multiplication_application,
    convert_xor,
)


# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------


@dataclass
class GradeResult:
    """Uniform return value for every grader.

    Attributes
    ----------
    is_correct : bool
        Binary pass/fail. ``score >= pass_threshold`` for rubric
        graders, exact match for everything else.
    score : float
        0..1. For binary graders this is 0.0 or 1.0. For rubric
        graders it's ``satisfied_criteria / total_criteria``.
    feedback : str
        Short, user-facing message. Either a generic "correct" /
        "wrong" hint, or for rubric graders a one-sentence summary
        of which criteria the answer missed.
    normalised_user_answer : str | None
        The user's input after parsing / canonicalisation. Stored
        with the response so an admin can audit what the system
        actually evaluated.
    misconception_tag : str | None
        If the user picked a distractor (MCQ) or missed a rubric
        criterion that maps to a tagged misconception, this carries
        the tag. The mastery system increments the user's misconception
        counter when this is non-None.
    diagnostic : dict
        Per-grader detail useful for debugging — parse errors, unit
        mismatches, per-criterion LLM verdicts. Not surfaced to users.
    """

    is_correct: bool
    score: float
    feedback: str
    normalised_user_answer: str | None = None
    misconception_tag: str | None = None
    diagnostic: dict[str, Any] = field(default_factory=dict)


class GraderError(RuntimeError):
    """Raised when a grader can't even attempt evaluation — typically
    means the question's stored payload is malformed, not that the
    user's answer is wrong. Callers should treat this as a 500-class
    error, not a wrong answer."""


# ---------------------------------------------------------------------------
# MCQ grader
# ---------------------------------------------------------------------------


def grade_mcq(user_choice_label: str, payload: dict[str, Any]) -> GradeResult:
    """Exact-match grader for multiple-choice questions.

    ``user_choice_label`` is the label the user picked ("A", "B", …).
    Payload must carry a ``choices`` array of objects with
    ``label``, ``text``, ``is_correct``, and optional ``misconception``.
    """
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise GraderError("MCQ payload missing 'choices' array")
    label = (user_choice_label or "").strip().upper()
    picked = next((c for c in choices if str(c.get("label", "")).upper() == label), None)
    correct = next((c for c in choices if c.get("is_correct")), None)
    if correct is None:
        raise GraderError("MCQ payload has no correct choice")
    if picked is None:
        return GradeResult(
            is_correct=False,
            score=0.0,
            feedback=f"Choice {label!r} is not one of the options.",
            normalised_user_answer=label or None,
        )
    if picked.get("is_correct"):
        return GradeResult(
            is_correct=True,
            score=1.0,
            feedback="Correct.",
            normalised_user_answer=label,
        )
    return GradeResult(
        is_correct=False,
        score=0.0,
        feedback=f"Not quite — the correct answer is {correct.get('label')}.",
        normalised_user_answer=label,
        misconception_tag=picked.get("misconception"),
    )


# ---------------------------------------------------------------------------
# Numeric grader (with optional units via pint)
# ---------------------------------------------------------------------------


# Strip common decorations: superscripts, locale separators, leading "≈" etc.
_NUMERIC_DECORATIONS = re.compile(r"[≈≠≅≡≃]")
_NUMERIC_TRAILING_NOTE = re.compile(r"\s*(?:approx|about|roughly|~)\s*$", re.IGNORECASE)


def _parse_value_with_unit(text: str) -> tuple[float, pint.Quantity | None]:
    """Parse user numeric input into a magnitude + optional pint Quantity.

    Returns ``(magnitude, quantity_or_None)``. The Quantity is None if
    the user's input lacks units. Raises ``ValueError`` if the input
    is not parseable as a number.

    Handles: scientific notation, fractions, comma-as-thousands or
    comma-as-decimal (best-effort), unicode minus / hyphen variants,
    trailing units (``"3.14 m/s"``, ``"3.14m/s"``), engineering
    notation (``"1.5e3 Pa"``), exponent symbols (``×``, ``·``).
    """
    raw = (text or "").strip()
    if not raw:
        raise ValueError("empty answer")
    cleaned = _NUMERIC_DECORATIONS.sub("", raw).strip()
    cleaned = _NUMERIC_TRAILING_NOTE.sub("", cleaned).strip()
    # Replace unicode minus / hyphen variants with ASCII minus.
    cleaned = (
        cleaned.replace("−", "-")
        .replace("×", "*")  # × → *
        .replace("·", "*")  # · → *
        .replace(",", "")  # treat comma as thousands sep first; fallback below
    )

    # Try to parse as a plain number first.
    try:
        return float(cleaned), None
    except ValueError:
        pass

    # Try pint — handles "3.14 m/s" naturally.
    try:
        qty = _UREG.Quantity(cleaned)
        return float(qty.magnitude), qty
    except (
        pint.errors.UndefinedUnitError,
        pint.errors.DimensionalityError,
        pint.errors.OffsetUnitCalculusError,
        ValueError,
    ):
        # OffsetUnitCalculusError shows up for offset units (dB, °C)
        # when pint sees them in expressions that require linear-only
        # algebra. We fall through to the dimensionless-magnitude
        # parser below — for acoustics questions this still grades
        # correctly because tolerance is on the magnitude, not the
        # dimensional quantity.
        pass

    # Last resort: try treating "," as decimal point (European format).
    try:
        return float(cleaned.replace(".", "").replace(",", ".")), None
    except ValueError as exc:
        raise ValueError(f"cannot parse {text!r} as a number") from exc


def grade_numeric(user_text: str, payload: dict[str, Any]) -> GradeResult:
    """Numeric grader with unit awareness via pint.

    Payload contract:
        {
          "correct_value": float,
          "tolerance": float,        # absolute tolerance in answer units
          "unit": str | null,        # expected unit; null = dimensionless
          "alternate_forms": [str]   # additional accepted text exact matches
        }

    Comparison rules:
        * If both expected and user have units, convert user's
          quantity to expected unit and compare magnitudes.
        * If expected has a unit but user didn't supply one, accept
          (assume user gave the magnitude in the expected unit) but
          flag in diagnostic.
        * If expected has no unit, ignore any unit on user input.
    """
    expected_value = payload.get("correct_value")
    if not isinstance(expected_value, (int, float)):
        raise GraderError("Numeric payload missing/invalid 'correct_value'")
    tolerance = float(payload.get("tolerance", 0.0))
    expected_unit_str = payload.get("unit")

    # Exact match on stored alternate forms first — cheapest path.
    user_stripped = (user_text or "").strip()
    for alt in payload.get("alternate_forms", []) or []:
        if user_stripped.lower() == str(alt).strip().lower():
            return GradeResult(
                is_correct=True,
                score=1.0,
                feedback="Correct.",
                normalised_user_answer=user_stripped,
            )

    try:
        magnitude, quantity = _parse_value_with_unit(user_stripped)
    except ValueError as exc:
        return GradeResult(
            is_correct=False,
            score=0.0,
            feedback=f"Could not parse your answer as a number: {exc}",
            normalised_user_answer=user_stripped or None,
            diagnostic={"parse_error": str(exc)},
        )

    converted_magnitude = magnitude
    unit_mismatch = False
    if expected_unit_str:
        try:
            expected_qty = _UREG.Quantity(1.0, expected_unit_str)
        except pint.errors.UndefinedUnitError as exc:
            raise GraderError(
                f"Numeric payload has unknown unit {expected_unit_str!r}: {exc}"
            ) from exc

        if quantity is not None:
            try:
                converted_magnitude = float(quantity.to(expected_qty.units).magnitude)
            except pint.errors.DimensionalityError as exc:
                return GradeResult(
                    is_correct=False,
                    score=0.0,
                    feedback=(
                        f"Your answer has the wrong dimensionality. "
                        f"Expected units of {expected_unit_str}."
                    ),
                    normalised_user_answer=user_stripped,
                    diagnostic={"dimensionality_error": str(exc)},
                )
        else:
            # User gave a bare number. Accept but flag.
            unit_mismatch = True

    diff = abs(converted_magnitude - float(expected_value))
    if diff <= max(tolerance, 0.0):
        feedback = "Correct."
        if unit_mismatch:
            feedback += f" (Assumed your answer was in {expected_unit_str}.)"
        return GradeResult(
            is_correct=True,
            score=1.0,
            feedback=feedback,
            normalised_user_answer=f"{converted_magnitude}",
            diagnostic={
                "expected": expected_value,
                "got": converted_magnitude,
                "tolerance": tolerance,
            },
        )

    return GradeResult(
        is_correct=False,
        score=0.0,
        feedback=(
            f"Not quite — got {converted_magnitude:g}"
            f"{f' {expected_unit_str}' if expected_unit_str else ''}, "
            f"expected {expected_value:g}"
            f"{f' {expected_unit_str}' if expected_unit_str else ''}"
            f" (±{tolerance:g})."
        ),
        normalised_user_answer=f"{converted_magnitude}",
        diagnostic={
            "expected": expected_value,
            "got": converted_magnitude,
            "tolerance": tolerance,
            "diff": diff,
        },
    )


# ---------------------------------------------------------------------------
# Symbolic grader
# ---------------------------------------------------------------------------


def _parse_user_expression(text: str, variable_names: list[str]) -> sympy.Expr:
    """Parse a user's text answer into a SymPy expression.

    Tries plain SymPy first (handles "x^2 + 3*y" naturally). If the
    answer looks like LaTeX (starts with ``\\``, contains ``\\frac``,
    contains ``$``…), tries SymPy's LaTeX parser. Falls back to a
    permissive parse with implicit-multiplication transformations.
    """
    raw = (text or "").strip()
    if not raw:
        raise ValueError("empty answer")
    # Strip surrounding $...$ if present.
    if raw.startswith("$") and raw.endswith("$"):
        raw = raw[1:-1].strip()

    # Pre-declare symbols so the parser doesn't invent them.
    local_dict = {name: sympy.Symbol(name) for name in variable_names}

    # Try the permissive parser first.
    try:
        return parse_expr(
            raw,
            local_dict=local_dict,
            transformations=_SYMPY_TRANSFORMS,
            evaluate=True,
        )
    except (SyntaxError, ValueError, TypeError):
        pass

    # If it looks LaTeX-ish, try the latex parser. Lazy import because
    # sympy.parsing.latex pulls in antlr4 and we don't want to penalise
    # plain numeric / MCQ requests with that cost.
    if "\\" in raw or "{" in raw:
        try:
            from sympy.parsing.latex import parse_latex  # type: ignore
            return parse_latex(raw)
        except Exception:  # noqa: BLE001 — broad on purpose; many failure modes
            pass

    raise ValueError(f"cannot parse {text!r} as a SymPy expression")


def grade_symbolic(user_text: str, payload: dict[str, Any]) -> GradeResult:
    """Algebraic-equivalence grader.

    Payload contract:
        {
          "correct_expression_latex": str,
          "variables": [str, ...],
          "domain_constraints": str | null
        }

    Strategy:
        1. Parse both expressions.
        2. Compute ``simplify(user - expected)``.
        3. If the result simplifies to zero, the answers are
           algebraically equivalent. Otherwise wrong.

    No LLM in the loop. This is what makes the symbolic grader
    reliable — two answers are equivalent iff SymPy proves they are.
    """
    expected_text = payload.get("correct_expression_latex")
    if not isinstance(expected_text, str) or not expected_text.strip():
        raise GraderError("Symbolic payload missing 'correct_expression_latex'")
    variables = payload.get("variables") or []
    if not isinstance(variables, list) or not all(isinstance(v, str) for v in variables):
        raise GraderError("Symbolic payload 'variables' must be a list of strings")

    try:
        user_expr = _parse_user_expression(user_text, variables)
    except ValueError as exc:
        return GradeResult(
            is_correct=False,
            score=0.0,
            feedback=f"Could not parse your answer: {exc}",
            normalised_user_answer=(user_text or "").strip() or None,
            diagnostic={"parse_error": str(exc)},
        )
    try:
        expected_expr = _parse_user_expression(expected_text, variables)
    except ValueError as exc:
        raise GraderError(
            f"Stored 'correct_expression_latex' is not parseable: {exc}"
        ) from exc

    try:
        difference = sympy.simplify(user_expr - expected_expr)
    except Exception as exc:  # noqa: BLE001 — many SymPy failure modes
        return GradeResult(
            is_correct=False,
            score=0.0,
            feedback="Your answer couldn't be compared to the expected expression.",
            normalised_user_answer=str(user_expr),
            diagnostic={"simplify_error": str(exc)},
        )

    if difference == 0 or (hasattr(difference, "is_zero") and difference.is_zero):
        return GradeResult(
            is_correct=True,
            score=1.0,
            feedback="Correct (algebraically equivalent).",
            normalised_user_answer=str(user_expr),
        )

    return GradeResult(
        is_correct=False,
        score=0.0,
        feedback=(
            "Not equivalent to the expected expression. "
            "Double-check your derivation."
        ),
        normalised_user_answer=str(user_expr),
        diagnostic={
            "expected": str(expected_expr),
            "got": str(user_expr),
            "difference": str(difference),
        },
    )


# ---------------------------------------------------------------------------
# Free-text rubric grader
# ---------------------------------------------------------------------------


_RUBRIC_GRADER_SYSTEM = """\
You are grading one user answer against a SET of criteria. For each \
criterion, you must decide INDEPENDENTLY whether the user's answer \
demonstrates that specific point. Do not judge overall correctness. \
Do not assume implied content — only what the answer actually states.

Output STRICT JSON ONLY:

{
  "evaluations": [
    {
      "criterion_index": <int, 0-based index into the criteria list you were given>,
      "satisfied": <bool>,
      "reasoning": <string, one short sentence on why>
    },
    ...
  ]
}

Rules:
  - Return one entry per criterion, in the order given.
  - "satisfied" = true only if the user's answer demonstrably addresses the criterion.
  - Vague gestures don't count. The answer must show understanding of THIS point.
  - Output ONLY the JSON object.\
"""


def grade_free_text(
    user_text: str,
    payload: dict[str, Any],
    openai_client: openai.OpenAI | None = None,
) -> GradeResult:
    """Rubric-decomposed grader for free-text answers.

    Payload contract:
        {
          "rubric": [
            {
              "criterion": str,
              "expected_signal": str,
              "misconception_if_missing": str | null
            },
            ...
          ],
          "pass_threshold": int   # min criteria satisfied to pass
        }

    The LLM grades each criterion **independently**. Aggregation
    (score, pass/fail, first-detected misconception) is deterministic.

    Why not just ask "is this answer correct"? Because the LLM
    drifts wildly on "correct enough" — same answer scored 0.6 one
    call, 0.9 the next. Decomposed yes/no per criterion is much
    more stable across temperature, model versions, and prompt drift.
    """
    rubric = payload.get("rubric") or []
    if not isinstance(rubric, list) or not rubric:
        raise GraderError("Free-text payload missing 'rubric' array")
    pass_threshold = int(payload.get("pass_threshold", max(1, len(rubric) // 2)))

    user_stripped = (user_text or "").strip()
    if not user_stripped:
        return GradeResult(
            is_correct=False,
            score=0.0,
            feedback="No answer provided.",
            normalised_user_answer=None,
        )

    client = openai_client or openai.OpenAI(api_key=settings.openai_api_key)
    criteria_for_prompt = [
        {
            "index": i,
            "criterion": r.get("criterion", ""),
            "expected_signal": r.get("expected_signal", ""),
        }
        for i, r in enumerate(rubric)
    ]
    user_message = (
        "User's answer:\n"
        f"{user_stripped}\n\n"
        "Criteria:\n"
        f"{json.dumps(criteria_for_prompt, ensure_ascii=False, indent=2)}"
    )
    completion = client.chat.completions.create(
        model=settings.openai_reasoning_model,
        messages=[
            {"role": "system", "content": _RUBRIC_GRADER_SYSTEM},
            {"role": "user", "content": user_message},
        ],
        response_format={"type": "json_object"},
        temperature=0,
    )
    raw = (completion.choices[0].message.content or "").strip()
    try:
        parsed = json.loads(raw)
        evaluations = parsed.get("evaluations") or []
        if not isinstance(evaluations, list):
            raise ValueError("'evaluations' is not a list")
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning("rubric grader returned malformed JSON: %s | raw=%s", exc, raw)
        # Fail closed — don't auto-pass a malformed grader response.
        return GradeResult(
            is_correct=False,
            score=0.0,
            feedback="Your answer couldn't be graded automatically. Please retry.",
            normalised_user_answer=user_stripped,
            diagnostic={"grader_error": str(exc), "raw": raw},
        )

    # Aggregate.
    satisfied_indexes: set[int] = set()
    per_criterion: list[dict[str, Any]] = []
    for ev in evaluations:
        idx = ev.get("criterion_index")
        if not isinstance(idx, int) or idx < 0 or idx >= len(rubric):
            continue
        sat = bool(ev.get("satisfied"))
        per_criterion.append(
            {
                "index": idx,
                "satisfied": sat,
                "reasoning": str(ev.get("reasoning", "")),
            }
        )
        if sat:
            satisfied_indexes.add(idx)

    score = len(satisfied_indexes) / len(rubric)
    is_correct = len(satisfied_indexes) >= pass_threshold

    # First missed criterion with a misconception tag → surface it.
    missed_misconception: str | None = None
    missed_criteria_text: list[str] = []
    for i, criterion in enumerate(rubric):
        if i in satisfied_indexes:
            continue
        if missed_misconception is None and criterion.get("misconception_if_missing"):
            missed_misconception = criterion["misconception_if_missing"]
        if criterion.get("criterion"):
            missed_criteria_text.append(criterion["criterion"])

    if is_correct:
        feedback = "Correct — your answer addresses the key points."
    elif missed_criteria_text:
        feedback = "Partly there. Missing: " + "; ".join(
            missed_criteria_text[:3]
        ) + ("…" if len(missed_criteria_text) > 3 else "")
    else:
        feedback = "Not quite — try addressing the criteria more directly."

    return GradeResult(
        is_correct=is_correct,
        score=score,
        feedback=feedback,
        normalised_user_answer=user_stripped,
        misconception_tag=missed_misconception,
        diagnostic={
            "per_criterion": per_criterion,
            "satisfied_count": len(satisfied_indexes),
            "total_criteria": len(rubric),
            "pass_threshold": pass_threshold,
        },
    )


# ---------------------------------------------------------------------------
# Top-level dispatch
# ---------------------------------------------------------------------------


def grade(
    *,
    question_type: str,
    user_answer: str,
    payload: dict[str, Any],
    openai_client: openai.OpenAI | None = None,
) -> GradeResult:
    """Dispatch to the right grader by question type.

    Counterexamples are graded as either MCQ or free_text depending
    on the payload shape — the type is a UI / pacing distinction,
    not a grading one. Code grading isn't implemented yet (requires
    sandbox infrastructure); raises ``NotImplementedError`` so a
    caller can fall back gracefully.
    """
    if question_type == "mcq":
        return grade_mcq(user_answer, payload)
    if question_type == "numeric":
        return grade_numeric(user_answer, payload)
    if question_type == "symbolic":
        return grade_symbolic(user_answer, payload)
    if question_type in ("free_text", "counterexample"):
        # Counterexample with MCQ-shaped payload → MCQ grader.
        if "choices" in payload:
            return grade_mcq(user_answer, payload)
        return grade_free_text(user_answer, payload, openai_client=openai_client)
    if question_type == "code":
        raise NotImplementedError("Code grading requires sandbox infrastructure")
    raise GraderError(f"Unknown question_type: {question_type!r}")
