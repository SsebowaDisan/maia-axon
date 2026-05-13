"""Learn-mode chat helper.

When the user is in learn mode, the chat surface is no longer a
generic retrieval Q&A — it becomes a tutor for the current section
on the user's active learning path. This module produces the extra
context the chat handler needs to behave that way:

  * Identify which section the user is currently on.
  * Pull the section's summary, page range, and introduced concepts.
  * Surface which concepts in the section the user already knows vs.
    is still learning.
  * Compose a system-prompt prefix that pins the tutor's job
    (explain the current section, anchor every claim in the PDF,
    nudge toward a check-in when ready).

The chat handler then runs library retrieval scoped to the path's
document and prepends the prefix.

Why a separate module from ``learn_path.py``?
    ``learn_path.py`` is the path-state algorithm — it embeds, builds,
    recomputes. This module is read-only context assembly for the
    chat handler. Keeping them apart means future tweaks to the
    tutor's voice don't drag in the path generator's imports.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.concept import Concept
from app.models.document import Document, DocumentSection
from app.models.learning_path import UserLearningPath
from app.services.mastery import known_concepts

logger = logging.getLogger(__name__)


@dataclass
class LearnChatContext:
    """Snapshot of the user's learn-mode state used by the chat
    handler. None of these fields are required by the LLM; they're
    interpolated into the system prompt as guidance.
    """

    path_id: uuid.UUID
    document_id: uuid.UUID
    document_filename: str
    goal_text: str
    depth: str
    current_step_index: int
    total_steps: int
    section_id: uuid.UUID
    section_title: str
    section_page_start: int
    section_page_end: int
    section_summary: str
    section_rationale: str
    is_target_section: bool
    is_prereq_section: bool
    introduced_concept_names: list[str]
    known_concept_names: list[str]
    unknown_concept_names: list[str]
    path_complete: bool


def get_learn_chat_context(
    db: Session,
    *,
    user_id: uuid.UUID,
    document_id: uuid.UUID,
) -> LearnChatContext | None:
    """Load the active learning path + current section for tutoring.

    Returns ``None`` when the user has no active path for this
    document — the chat handler reads that as "tell the frontend
    to send the user through the diagnostic to start a path".
    """

    path = (
        db.query(UserLearningPath)
        .filter(UserLearningPath.user_id == user_id)
        .filter(UserLearningPath.document_id == document_id)
        .filter(UserLearningPath.status.in_(("active", "paused", "completed")))
        .order_by(UserLearningPath.last_active_at.desc())
        .first()
    )
    if path is None or not path.plan_json:
        return None

    document = db.scalar(select(Document).where(Document.id == document_id))
    if document is None:
        return None

    # Pick the focal step: the current pending one for active paths,
    # the final step for a completed path (so the chat still has
    # somewhere to ground tutoring follow-ups).
    plan: list[dict] = list(path.plan_json or [])
    step_index = path.current_step
    path_complete = path.status == "completed" or step_index >= len(plan)
    if path_complete:
        step_index = max(0, len(plan) - 1)
    step = plan[step_index]

    section_id = uuid.UUID(step["section_id"])
    section = db.scalar(
        select(DocumentSection).where(DocumentSection.id == section_id)
    )
    if section is None:
        # Path references a stale section — treat the same as no path.
        return None

    section_summary = ""
    content = section.content_json or {}
    if isinstance(content, dict):
        section_summary = (content.get("summary") or "").strip()

    introduced_ids: list[uuid.UUID] = []
    if isinstance(content, dict):
        for entry in content.get("concepts_introduced", []) or []:
            cid = entry.get("concept_id") if isinstance(entry, dict) else None
            if cid:
                try:
                    introduced_ids.append(uuid.UUID(cid))
                except (TypeError, ValueError):
                    continue

    introduced_names: list[str] = []
    if introduced_ids:
        rows = db.execute(
            select(Concept.id, Concept.canonical_name).where(
                Concept.id.in_(introduced_ids)
            )
        ).all()
        name_by_id = {row.id: row.canonical_name for row in rows}
        introduced_names = [
            name_by_id[cid] for cid in introduced_ids if cid in name_by_id
        ]

    user_known = known_concepts(db, user_id=user_id)
    known_intro = [cid for cid in introduced_ids if cid in user_known]
    unknown_intro = [cid for cid in introduced_ids if cid not in user_known]

    known_names: list[str] = []
    unknown_names: list[str] = []
    if known_intro or unknown_intro:
        rows = db.execute(
            select(Concept.id, Concept.canonical_name).where(
                Concept.id.in_(known_intro + unknown_intro)
            )
        ).all()
        name_by_id = {row.id: row.canonical_name for row in rows}
        known_names = [name_by_id[c] for c in known_intro if c in name_by_id]
        unknown_names = [name_by_id[c] for c in unknown_intro if c in name_by_id]

    return LearnChatContext(
        path_id=path.id,
        document_id=document_id,
        document_filename=document.filename,
        goal_text=path.goal_text,
        depth=path.depth,
        current_step_index=step_index,
        total_steps=len(plan),
        section_id=section_id,
        section_title=section.title,
        section_page_start=section.page_start,
        section_page_end=section.page_end,
        section_summary=section_summary,
        section_rationale=str(step.get("rationale") or ""),
        is_target_section=bool(step.get("is_target")),
        is_prereq_section=bool(step.get("is_prereq")),
        introduced_concept_names=introduced_names,
        known_concept_names=known_names,
        unknown_concept_names=unknown_names,
        path_complete=path_complete,
    )


def build_learn_system_prompt(ctx: LearnChatContext) -> str:
    """Compose the system-prompt prefix that pins tutor behaviour.

    Stays terse — the rest of the chat handler's system message
    (Markdown style, citation rules) still applies.
    """

    role_line = (
        "target section the user came here to master."
        if ctx.is_target_section
        else (
            "prerequisite section the path scheduled before the goal sections."
            if ctx.is_prereq_section
            else "current section on the user's learning path."
        )
    )

    parts: list[str] = []
    parts.append(
        "You are tutoring the user in learn mode. They are working through "
        f"\"{ctx.document_filename}\" toward this goal: {ctx.goal_text!r}."
    )
    parts.append(
        f"They are on step {ctx.current_step_index + 1} of {ctx.total_steps}: "
        f"\"{ctx.section_title}\" (pages {ctx.section_page_start}–{ctx.section_page_end}). "
        f"This is the {role_line}"
    )
    if ctx.section_rationale:
        parts.append(f"Why this section is on the path: {ctx.section_rationale}")
    if ctx.section_summary:
        parts.append(f"Section summary: {ctx.section_summary}")
    if ctx.introduced_concept_names:
        parts.append(
            "Concepts this section introduces: "
            + ", ".join(ctx.introduced_concept_names)
        )
    if ctx.unknown_concept_names:
        parts.append(
            "Concepts the user is still learning (focus here): "
            + ", ".join(ctx.unknown_concept_names)
        )
    if ctx.known_concept_names:
        parts.append(
            "Concepts the user already knows (you can lean on these as scaffolding): "
            + ", ".join(ctx.known_concept_names)
        )
    if ctx.path_complete:
        parts.append(
            "The path is already complete — the user is reviewing. "
            "Be willing to recap, compare to other sections in the book, "
            "and answer follow-up questions even if they range outside this section."
        )
    parts.append(
        "Tutoring rules: "
        "1) Ground every claim in the sources you are given. Cite inline as [N]. "
        "2) Prefer explanation over recitation — use the section as scaffolding, "
        "not as a script to repeat. "
        "3) When the user demonstrates they understand the section's key concepts, "
        "tell them they are ready for a check-in and to tap the check-in button. "
        "4) If they ask to skip ahead, answer the question but remind them their "
        "path expects this section first. "
        "5) If they are stuck, offer a worked example or simpler decomposition "
        "before re-explaining."
    )
    return " ".join(parts)


def fallback_no_path_message(document_filename: str | None) -> str:
    """Returned when learn mode is requested but no active path exists.

    Frontend reads this as a prompt to open the diagnostic.
    """

    name = f' for "{document_filename}"' if document_filename else ""
    return (
        f"You don't have an active learning path{name} yet. "
        "Start one by tapping the **Start learning** button on the document — "
        "you'll answer a few quick diagnostic questions, and Maia will lay out a "
        "personalised path through the book."
    )


def build_open_learn_system_prompt(
    document_filename: str | None,
    *,
    is_first_turn: bool = False,
) -> str:
    """Tutor-voice system prompt used when learn mode is on but no
    structured path has been generated yet.

    Lets the user use Learn as a "talk to a tutor about this book"
    chat surface without forcing the path-diagnostic popup. They can
    still opt into a generated path later via the Learn dialog —
    that path-aware prompt simply replaces this one.

    ``is_first_turn`` flips the prompt into discovery mode: the very
    first learn-mode response opens with one short question to learn
    the user's goal and level, then attempts a brief first-pass answer.
    Subsequent turns drop the discovery question and answer normally.
    """

    name = f'"{document_filename}"' if document_filename else "this document"
    base = (
        f"You are tutoring the user in learn mode for {name}. They have not "
        "generated a structured learning path yet — they're exploring the "
        "book and asking questions as they go. "
        "Tutoring rules: "
        "1) Ground every claim in the sources you are given. Cite inline as [N]. "
        "2) Prefer explanation over recitation — use the cited passages as "
        "scaffolding, not as a script to repeat. Make the underlying ideas "
        "click, with worked examples or simpler decompositions when useful. "
        "3) Check the user's understanding lightly when it makes sense — a "
        "single follow-up question is fine, not a quiz. "
        "4) If they seem to want a guided path through the book, mention that "
        "they can tap **Start learning** to generate one — don't push it."
    )
    if not is_first_turn:
        return base
    discovery = (
        " "
        "FIRST-TURN BEHAVIOUR (this is the user's first message in learn mode "
        "for this document): open your response with ONE short discovery "
        "question on its own line so you can tailor depth and angle going "
        "forward. Phrase it conversationally, e.g. 'Quick question first — "
        "are you trying to design something specific, prep for an exam, or "
        "just build intuition about this book?'. After that single question, "
        "give a brief first-pass answer to whatever the user asked (2-4 "
        "sentences, still cited from the sources) so they're not left "
        "hanging. Do NOT ask multiple discovery questions — one is enough."
    )
    return base + discovery
