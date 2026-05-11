"""Lightweight, non-persistent translation endpoint.

Used by the PDF viewer's "Translate" action: the user selects a passage
and asks for it in another language. The translation is rendered only
on their screen — we don't save it, attach it to the document, or share
it with the group. Keeps cost low (gpt-4o-mini, short prompts) and
avoids polluting the corpus with derivative content.
"""

from __future__ import annotations

import re

import openai
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.api.deps import get_current_user
from app.core.config import settings
from app.models.user import User

router = APIRouter(prefix="/translate", tags=["translate"])


class TranslateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    target_language: str = Field(min_length=2, max_length=64)


class TranslateResponse(BaseModel):
    translated_text: str
    target_language: str


def _normalize_pdf_text(text: str) -> str:
    """Collapse PDF-extracted text into prose.

    PDF.js emits one DOM span per text fragment, so a JS Selection of
    ``"Josef Lexis Ventilatoren in der Praxis"`` arrives here as
    ``"Josef Lexis\\nVentilatoren\\nin der Praxis"``. Translating that
    line-by-line produces stripey output (each chunk on its own line).
    We fold single newlines back into spaces while preserving real
    paragraph breaks (``\\n\\n+``).
    """
    # Mark paragraph breaks (two or more consecutive newlines).
    paragraphs = re.split(r"\n\s*\n", text)
    rejoined = "\n\n".join(
        re.sub(r"\s+", " ", paragraph).strip() for paragraph in paragraphs
    )
    return rejoined.strip()


@router.post("", response_model=TranslateResponse)
async def translate_text(body: TranslateRequest, _user: User = Depends(get_current_user)):
    cleaned = _normalize_pdf_text(body.text)
    if not cleaned:
        raise HTTPException(status_code=400, detail="Empty text")

    client = openai.OpenAI(api_key=settings.openai_api_key)
    system_prompt = (
        f"You are a precise translator. Translate the user's text into {body.target_language}. "
        "Output the translation as flowing prose: keep the source's paragraph structure exactly "
        "(blank lines stay blank lines), but do NOT introduce line breaks inside a paragraph. "
        "Preserve technical terms, proper nouns, numbers, and inline formatting. "
        "Output ONLY the translation — no preamble, no explanations, no surrounding quotation marks."
    )
    try:
        completion = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": cleaned},
            ],
            temperature=0,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Translation service failed: {exc}") from exc

    output = (completion.choices[0].message.content or "").strip()
    if not output:
        raise HTTPException(status_code=502, detail="Empty translation")

    return TranslateResponse(translated_text=output, target_language=body.target_language)
