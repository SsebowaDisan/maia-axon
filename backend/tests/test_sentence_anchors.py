"""Unit tests for sentence_anchors.

Sentence-level anchoring is the foundation of NotebookLM-style citations,
so it pays to test it thoroughly: abbreviation handling, decimal numbers,
multi-language punctuation, equation references, and sentence-to-bbox
resolution from per-line data.
"""

from __future__ import annotations

from app.services.sentence_anchors import (
    Anchor,
    SentenceSpan,
    _bbox_union,
    _resolve_sentence_bbox,
    annotate_with_anchors,
    split_into_sentences,
)

# ---------------------------------------------------------------------------
# split_into_sentences
# ---------------------------------------------------------------------------


class TestSplitIntoSentences:
    def test_two_sentences_basic(self):
        spans = split_into_sentences("First sentence. Second sentence.")
        assert [s.text for s in spans] == ["First sentence.", "Second sentence."]
        assert spans[0].char_start == 0
        assert spans[0].char_end == 15
        assert spans[1].char_start == 16
        assert spans[1].char_end == 32

    def test_single_sentence_no_terminator(self):
        spans = split_into_sentences("A complete thought without a final period")
        assert len(spans) == 1
        assert spans[0].char_start == 0

    def test_empty_input(self):
        assert split_into_sentences("") == []
        assert split_into_sentences("   ") == []

    def test_question_and_exclamation(self):
        spans = split_into_sentences("What is it? It is great! Indeed.")
        assert [s.text for s in spans] == ["What is it?", "It is great!", "Indeed."]

    def test_french_capitalised_split(self):
        spans = split_into_sentences("Le bruit est important. Les ventilateurs émettent du son.")
        assert len(spans) == 2

    def test_does_not_split_on_decimal_number(self):
        spans = split_into_sentences("Pi is approximately 3.14159 in mathematics. Many digits!")
        assert len(spans) == 2
        assert "3.14159" in spans[0].text

    def test_does_not_split_on_european_decimal(self):
        # French/German use comma as decimal separator: 9,81
        spans = split_into_sentences("La valeur 9,81 m/s² est constante. Vérifié.")
        assert len(spans) == 2
        assert "9,81" in spans[0].text

    def test_does_not_split_on_equation_ref(self):
        # "(1.2)" appears mid-sentence and shouldn't terminate it.
        spans = split_into_sentences("From equation (1.2) we derive Ohm's law. Then we proceed.")
        assert len(spans) == 2
        assert "(1.2)" in spans[0].text

    def test_does_not_split_on_etc(self):
        spans = split_into_sentences("We see fans, blades, etc. They rotate.")
        assert len(spans) == 2
        assert "etc." in spans[0].text

    def test_does_not_split_on_eg(self):
        spans = split_into_sentences("Some types e.g. centrifugal fans. Others exist.")
        assert len(spans) == 2

    def test_does_not_split_on_dr(self):
        spans = split_into_sentences("Dr. Smith published the paper. It was groundbreaking.")
        assert len(spans) == 2

    def test_does_not_split_on_french_monsieur(self):
        # "M." abbreviation for Monsieur in French
        spans = split_into_sentences("M. Dupont a publié l'article. Il est important.")
        assert len(spans) == 2

    def test_three_sentences(self):
        spans = split_into_sentences("One. Two. Three.")
        assert [s.text for s in spans] == ["One.", "Two.", "Three."]

    def test_preserves_offsets_for_substring_extraction(self):
        # The char_start/char_end must let us recover the sentence verbatim.
        text = "First sentence.   Second one."
        spans = split_into_sentences(text)
        for span in spans:
            assert span.text == text[span.char_start : span.char_end].strip()


# ---------------------------------------------------------------------------
# _bbox_union
# ---------------------------------------------------------------------------


class TestBboxUnion:
    def test_single_box(self):
        assert _bbox_union([[10, 20, 30, 40]]) == [10.0, 20.0, 30.0, 40.0]

    def test_two_boxes_horizontally_disjoint(self):
        assert _bbox_union([[10, 20, 30, 40], [50, 25, 70, 45]]) == [10.0, 20.0, 70.0, 45.0]

    def test_skips_degenerate(self):
        # zero-area boxes are skipped
        assert _bbox_union([[10, 10, 10, 10], [20, 20, 30, 30]]) == [20.0, 20.0, 30.0, 30.0]

    def test_skips_malformed(self):
        assert _bbox_union([[1, 2, 3], "garbage", None, [10, 10, 30, 30]]) == [
            10.0, 10.0, 30.0, 30.0
        ]  # type: ignore[list-item]

    def test_returns_none_when_all_invalid(self):
        assert _bbox_union([[1, 2, 3]]) is None
        assert _bbox_union([]) is None


# ---------------------------------------------------------------------------
# _resolve_sentence_bbox
# ---------------------------------------------------------------------------


class TestResolveSentenceBbox:
    def test_uses_overlapping_lines_when_available(self):
        # text: "Line one.\nLine two.\nLine three."
        # offsets: line one = [0,9], line two = [10,19], line three = [20,31]
        sentence = SentenceSpan(text="Line two.", char_start=10, char_end=19)
        lines = [
            {"text": "Line one.", "bbox": [0, 0, 100, 10]},
            {"text": "Line two.", "bbox": [0, 12, 100, 22]},
            {"text": "Line three.", "bbox": [0, 24, 100, 34]},
        ]
        bbox = _resolve_sentence_bbox(sentence, lines, fallback_bbox=[0, 0, 200, 200])
        assert bbox == [0.0, 12.0, 100.0, 22.0]

    def test_unions_across_multiple_lines(self):
        # Line A is chars 0-6, "\n" at 6, Line B is chars 7-13, "\n" at 13,
        # Line C starts at 14. A sentence ending at char 12 covers A and most
        # of B but NOT C.
        sentence = SentenceSpan(text="Multi line", char_start=0, char_end=12)
        lines = [
            {"text": "Line A", "bbox": [0, 0, 50, 10]},
            {"text": "Line B", "bbox": [0, 12, 60, 22]},
            {"text": "Line C", "bbox": [0, 24, 70, 34]},  # past sentence end
        ]
        bbox = _resolve_sentence_bbox(sentence, lines, fallback_bbox=None)
        # First two lines overlap; third starts at char 14 and is excluded.
        assert bbox == [0.0, 0.0, 60.0, 22.0]

    def test_fallback_when_no_lines(self):
        sentence = SentenceSpan(text="x", char_start=0, char_end=1)
        bbox = _resolve_sentence_bbox(sentence, lines=None, fallback_bbox=[5, 5, 50, 50])
        assert bbox == [5, 5, 50, 50]

    def test_fallback_when_lines_dont_overlap(self):
        sentence = SentenceSpan(text="x", char_start=100, char_end=110)
        lines = [{"text": "short", "bbox": [0, 0, 10, 10]}]
        # Sentence char range is past any line; falls back.
        bbox = _resolve_sentence_bbox(sentence, lines, fallback_bbox=[1, 2, 3, 4])
        assert bbox == [1, 2, 3, 4]


# ---------------------------------------------------------------------------
# annotate_with_anchors
# ---------------------------------------------------------------------------


class TestAnnotateWithAnchors:
    def test_basic_two_sentence_text(self):
        text = "First sentence. Second sentence."
        annotated, anchors, next_order = annotate_with_anchors(
            text,
            page_number=12,
            starting_reading_order=0,
            chunk_bbox=[10, 20, 100, 80],
        )
        assert annotated == "<c>12.0</c>First sentence. <c>12.1</c>Second sentence."
        assert next_order == 2
        assert [a.id for a in anchors] == ["12.0", "12.1"]
        # Without per-line data the fallback (chunk_bbox) is used.
        assert anchors[0].bbox == [10, 20, 100, 80]
        assert anchors[1].bbox == [10, 20, 100, 80]

    def test_threads_reading_order_across_chunks(self):
        first_text = "One. Two."
        _, _, after_first = annotate_with_anchors(
            first_text, page_number=5, starting_reading_order=10
        )
        assert after_first == 12  # consumed two ids: 5.10, 5.11

        second_text = "Three."
        annotated, anchors, after_second = annotate_with_anchors(
            second_text, page_number=5, starting_reading_order=after_first
        )
        assert after_second == 13
        assert annotated == "<c>5.12</c>Three."
        assert anchors[0].id == "5.12"

    def test_uses_per_line_bboxes_when_provided(self):
        text = "Line one text. Line two text."
        # With newline joining offsets: "Line one text." spans 0-14,
        # "Line two text." spans 15-29 (per-line bbox alignment).
        lines = [
            {"text": "Line one text.", "bbox": [0, 0, 100, 10]},
            {"text": "Line two text.", "bbox": [0, 12, 110, 22]},
        ]
        _, anchors, _ = annotate_with_anchors(
            text, page_number=1, starting_reading_order=0, lines=lines
        )
        # Each sentence resolves to its own line's bbox.
        assert anchors[0].bbox == [0.0, 0.0, 100.0, 10.0]
        assert anchors[1].bbox == [0.0, 12.0, 110.0, 22.0]

    def test_empty_text_returns_unchanged(self):
        annotated, anchors, order = annotate_with_anchors(
            "", page_number=3, starting_reading_order=5
        )
        assert annotated == ""
        assert anchors == []
        assert order == 5

    def test_anchors_serialise_to_dict_form(self):
        anchor = Anchor(id="2.1", bbox=[1, 2, 3, 4], char_start=0, char_end=10)
        assert anchor.to_dict() == {
            "id": "2.1",
            "bbox": [1, 2, 3, 4],
            "char_start": 0,
            "char_end": 10,
        }

    def test_inserts_anchor_before_each_sentence_keeping_text_round_trippable(self):
        # Stripping the <c>id</c> markers should give back the original text
        # (modulo whitespace handling around sentence boundaries).
        import re

        text = "Alpha. Beta. Gamma."
        annotated, _, _ = annotate_with_anchors(text, page_number=1, starting_reading_order=0)
        stripped = re.sub(r"<c>[^<]+</c>", "", annotated)
        assert stripped == text

    def test_handles_text_with_only_one_sentence(self):
        annotated, anchors, _ = annotate_with_anchors(
            "Just one sentence.", page_number=7, starting_reading_order=0
        )
        assert annotated == "<c>7.0</c>Just one sentence."
        assert len(anchors) == 1
