"""Unit tests for math_extraction.

We mock the OpenAI client (no real API calls). PyMuPDF is exercised against
a tiny in-memory PDF so we cover the cropping path end-to-end.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import fitz
import pytest

from app.services.math_extraction import (
    _crop_region_to_png,
    _looks_like_latex,
    extract_latex_from_region,
)

# ---------------------------------------------------------------------------
# _looks_like_latex sanity gate
# ---------------------------------------------------------------------------


class TestLooksLikeLatex:
    def test_accepts_backslash_command(self):
        assert _looks_like_latex(r"\frac{a}{b}")

    def test_accepts_super_subscripts(self):
        assert _looks_like_latex("x^2 + y_1")

    def test_accepts_simple_equation(self):
        assert _looks_like_latex("F = m a")

    def test_rejects_no_equation_sentinel(self):
        assert not _looks_like_latex("NO_EQUATION")

    def test_rejects_empty(self):
        assert not _looks_like_latex("")

    def test_rejects_pure_prose(self):
        # No backslash, no caret, no underscore, no equals -> reject
        assert not _looks_like_latex("This is just narrative text.")

    def test_rejects_lone_number(self):
        assert not _looks_like_latex("42")

    def test_handles_whitespace(self):
        assert _looks_like_latex("  \\frac{1}{2}  ")


# ---------------------------------------------------------------------------
# _crop_region_to_png
# ---------------------------------------------------------------------------


@pytest.fixture
def tiny_pdf_page() -> fitz.Page:
    """Tiny one-page PDF with a square of text. Returned as the active page."""
    doc = fitz.open()
    page = doc.new_page(width=400, height=400)
    page.insert_text((50, 50), "x = mc^2", fontsize=14)
    return page


class TestCropRegionToPng:
    def test_returns_png_bytes_for_valid_bbox(self, tiny_pdf_page):
        png = _crop_region_to_png(tiny_pdf_page, [[40, 40, 200, 80]])
        assert png is not None
        assert png.startswith(b"\x89PNG\r\n\x1a\n")

    def test_returns_none_for_no_bboxes(self, tiny_pdf_page):
        assert _crop_region_to_png(tiny_pdf_page, []) is None
        assert _crop_region_to_png(tiny_pdf_page, None) is None

    def test_skips_degenerate_bboxes(self, tiny_pdf_page):
        # All-degenerate input should yield None (no usable rect).
        assert _crop_region_to_png(tiny_pdf_page, [[10, 10, 10, 10]]) is None
        assert _crop_region_to_png(tiny_pdf_page, [[30, 40, 10, 20]]) is None

    def test_unions_multiple_bboxes(self, tiny_pdf_page):
        # Two bboxes should be merged into one render — the resulting image
        # should be wider than either alone.
        single = _crop_region_to_png(tiny_pdf_page, [[10, 10, 50, 30]])
        unioned = _crop_region_to_png(tiny_pdf_page, [[10, 10, 50, 30], [200, 10, 250, 30]])
        assert single and unioned
        # The unioned image should be larger (covers more horizontal area).
        assert len(unioned) > len(single)

    def test_skips_malformed_entries(self, tiny_pdf_page):
        # Mix of valid + garbage; valid one carries the render.
        png = _crop_region_to_png(
            tiny_pdf_page,
            [[10, 10, 50, 30], [1, 2, 3], "garbage", None],  # type: ignore[list-item]
        )
        assert png is not None


# ---------------------------------------------------------------------------
# extract_latex_from_region — end-to-end with mocked vision client
# ---------------------------------------------------------------------------


def _mock_client_returning(content: str) -> MagicMock:
    """Build an openai.OpenAI mock whose chat.completions.create returns ``content``."""
    client = MagicMock()
    response = MagicMock()
    response.choices = [MagicMock()]
    response.choices[0].message.content = content
    client.chat.completions.create.return_value = response
    return client


class TestExtractLatexFromRegion:
    def test_returns_latex_on_clean_response(self, tiny_pdf_page):
        client = _mock_client_returning(r"E = mc^2")
        result = extract_latex_from_region(client, tiny_pdf_page, [[10, 10, 200, 50]])
        assert result == r"E = mc^2"

    def test_returns_none_for_no_equation_sentinel(self, tiny_pdf_page):
        client = _mock_client_returning("NO_EQUATION")
        assert extract_latex_from_region(client, tiny_pdf_page, [[10, 10, 200, 50]]) is None

    def test_strips_dollar_delimiters(self, tiny_pdf_page):
        client = _mock_client_returning(r"$$\frac{a}{b}$$")
        result = extract_latex_from_region(client, tiny_pdf_page, [[10, 10, 200, 50]])
        assert result == r"\frac{a}{b}"

    def test_strips_code_fence(self, tiny_pdf_page):
        client = _mock_client_returning("```latex\n\\frac{a}{b}\n```")
        result = extract_latex_from_region(client, tiny_pdf_page, [[10, 10, 200, 50]])
        assert result == r"\frac{a}{b}"

    def test_rejects_prose_response(self, tiny_pdf_page):
        # If the model writes English instead of LaTeX, sanity check rejects it.
        client = _mock_client_returning("This image shows a fraction over a fraction.")
        assert extract_latex_from_region(client, tiny_pdf_page, [[10, 10, 200, 50]]) is None

    def test_returns_none_when_no_bbox(self, tiny_pdf_page):
        client = _mock_client_returning(r"E = mc^2")
        # No usable bbox -> short-circuits without calling the API.
        assert extract_latex_from_region(client, tiny_pdf_page, []) is None
        client.chat.completions.create.assert_not_called()

    def test_returns_none_when_api_raises(self, tiny_pdf_page):
        client = MagicMock()
        client.chat.completions.create.side_effect = RuntimeError("network down")
        # Failure must be silent — caller keeps the existing plaintext.
        assert extract_latex_from_region(client, tiny_pdf_page, [[10, 10, 200, 50]]) is None

    def test_passes_ocr_hint_into_prompt(self, tiny_pdf_page):
        client = _mock_client_returning(r"x = 1")
        extract_latex_from_region(
            client,
            tiny_pdf_page,
            [[10, 10, 200, 50]],
            ocr_hint="garbled OCR plaintext as a hint",
        )
        sent = client.chat.completions.create.call_args.kwargs["messages"][0]["content"]
        prompt_text = next(part["text"] for part in sent if part["type"] == "text")
        assert "garbled OCR plaintext as a hint" in prompt_text

    def test_uses_specified_model(self, tiny_pdf_page):
        client = _mock_client_returning(r"x = 1")
        extract_latex_from_region(
            client, tiny_pdf_page, [[10, 10, 200, 50]], model="gpt-4o"
        )
        assert client.chat.completions.create.call_args.kwargs["model"] == "gpt-4o"
