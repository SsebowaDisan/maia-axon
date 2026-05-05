"""Unit tests for citation construction, normalization, and reindexing.

These cover the contracts the answer pipeline relies on:
- bbox normalization rejects degenerate / malformed entries
- citations are built one-to-one from retrieval results
- merging two citations unions their boxes
- reindex correctly handles permutations the prior loop-based
  implementation could corrupt (notably swaps, where successive
  re.subs collide on intermediate values)
"""

from __future__ import annotations

from app.services.answer_engine import (
    Citation,
    _build_anchor_index,
    _build_citations,
    _is_formula_listing_query,
    _merge_citation_pair,
    _normalize_bbox_references,
    _promote_equation_sources,
    _reindex_citation_references,
    _render_claims_to_markdown,
    _render_claims_with_anchors,
    _resolve_citation_token,
    _strip_anchor_markers,
)
from app.services.retrieval import (
    RetrievalResult,
    _is_substantive_formula_latex,
    _merge_retrieval_results,
    _strip_tracking_params,
    _strip_tracking_params_in_text,
)


def _make_result(idx: int, boxes: list[list[float]] | None = None) -> RetrievalResult:
    return RetrievalResult(
        source_type="pdf",
        document_id=None,
        document_name=f"doc-{idx}",
        page_number=idx,
        content=f"chunk content {idx}",
        bbox_references=boxes,
    )


# ---------------------------------------------------------------------------
# _normalize_bbox_references
# ---------------------------------------------------------------------------


class TestNormalizeBboxReferences:
    def test_returns_empty_for_none(self):
        assert _normalize_bbox_references(None) == []

    def test_returns_empty_for_empty_list(self):
        assert _normalize_bbox_references([]) == []

    def test_keeps_well_formed_box(self):
        assert _normalize_bbox_references([[10.0, 20.0, 30.0, 40.0]]) == [[10.0, 20.0, 30.0, 40.0]]

    def test_rounds_to_two_decimals(self):
        result = _normalize_bbox_references([[1.234, 2.345, 3.456, 4.567]])
        assert result == [[1.23, 2.35, 3.46, 4.57]]

    def test_drops_wrong_arity(self):
        assert _normalize_bbox_references([[1, 2, 3]]) == []
        assert _normalize_bbox_references([[1, 2, 3, 4, 5]]) == []

    def test_drops_non_list_entries(self):
        assert _normalize_bbox_references([{"x": 1}, "bad", None]) == []  # type: ignore[list-item]

    def test_drops_non_numeric_entries(self):
        assert _normalize_bbox_references([["a", "b", "c", "d"]]) == []  # type: ignore[list-item]

    def test_drops_zero_area_box(self):
        # Defense-in-depth: degenerate boxes would otherwise be inflated
        # by the renderer's minimum-size clamps into phantom rectangles.
        assert _normalize_bbox_references([[10, 10, 10, 10]]) == []

    def test_drops_inverted_box(self):
        assert _normalize_bbox_references([[30, 40, 10, 20]]) == []

    def test_drops_zero_width_box(self):
        assert _normalize_bbox_references([[10, 10, 10, 20]]) == []

    def test_drops_zero_height_box(self):
        assert _normalize_bbox_references([[10, 10, 20, 10]]) == []

    def test_filters_mixed_valid_and_invalid(self):
        result = _normalize_bbox_references([
            [10, 20, 30, 40],   # valid
            [10, 10, 10, 10],   # degenerate
            [1, 2, 3],          # wrong arity
            [50, 60, 70, 80],   # valid
        ])
        assert result == [[10.0, 20.0, 30.0, 40.0], [50.0, 60.0, 70.0, 80.0]]


# ---------------------------------------------------------------------------
# _build_citations
# ---------------------------------------------------------------------------


class TestBuildCitations:
    def test_assigns_one_indexed_ids(self):
        citations = _build_citations([_make_result(1), _make_result(2), _make_result(3)])
        assert [c.id for c in citations] == ["cite-1", "cite-2", "cite-3"]

    def test_truncates_snippet_to_200_chars(self):
        long_text = "x" * 500
        result = RetrievalResult(source_type="pdf", content=long_text)
        cite = _build_citations([result])[0]
        assert len(cite.snippet) == 200

    def test_boxes_normalized_when_present(self):
        cite = _build_citations([_make_result(1, [[10, 20, 30, 40]])])[0]
        assert cite.boxes == [[10.0, 20.0, 30.0, 40.0]]

    def test_boxes_none_when_absent(self):
        cite = _build_citations([_make_result(1, None)])[0]
        assert cite.boxes is None

    def test_boxes_none_when_only_degenerate(self):
        cite = _build_citations([_make_result(1, [[10, 10, 10, 10]])])[0]
        assert cite.boxes is None

    def test_returns_empty_for_no_results(self):
        assert _build_citations([]) == []


# ---------------------------------------------------------------------------
# _merge_citation_pair
# ---------------------------------------------------------------------------


class TestMergeCitationPair:
    def _cite(self, ident: str, boxes: list[list[float]] | None) -> Citation:
        return Citation(id=ident, source_type="pdf", boxes=boxes, snippet="snippet")

    def test_unions_boxes(self):
        a = self._cite("cite-1", [[10, 10, 20, 20]])
        b = self._cite("cite-2", [[30, 30, 40, 40]])
        merged = _merge_citation_pair(a, b)
        assert merged.boxes == [[10.0, 10.0, 20.0, 20.0], [30.0, 30.0, 40.0, 40.0]]

    def test_keeps_existing_id(self):
        a = self._cite("cite-1", None)
        b = self._cite("cite-2", None)
        merged = _merge_citation_pair(a, b)
        assert merged.id == "cite-1"

    def test_falls_back_to_one_side_when_other_empty(self):
        a = self._cite("cite-1", None)
        b = self._cite("cite-2", [[10, 10, 20, 20]])
        merged = _merge_citation_pair(a, b)
        assert merged.boxes == [[10.0, 10.0, 20.0, 20.0]]

    def test_keeps_longer_snippet(self):
        a = Citation(id="cite-1", source_type="pdf", snippet="short")
        b = Citation(id="cite-2", source_type="pdf", snippet="a much longer snippet of text")
        merged = _merge_citation_pair(a, b)
        assert merged.snippet == "a much longer snippet of text"


# ---------------------------------------------------------------------------
# _reindex_citation_references
# ---------------------------------------------------------------------------


def _cites(n: int) -> list[Citation]:
    return [
        Citation(id=f"cite-{i}", source_type="pdf", document_name=f"doc-{i}", page=i)
        for i in range(1, n + 1)
    ]


class TestReindexCitationReferences:
    def test_swap_does_not_collide(self):
        # Regression: the prior loop-based implementation collapsed both refs
        # into the same index when the mapping was a swap.
        text = "Foo [1] bar [2] baz"
        citations = _cites(2)
        new_text, new_citations = _reindex_citation_references(text, citations, [2, 1])

        assert new_text == "Foo [2] bar [1] baz"
        assert [c.id for c in new_citations] == ["cite-2", "cite-1"]

    def test_three_way_rotation_does_not_collide(self):
        text = "A [1] B [2] C [3]"
        citations = _cites(3)
        # Rotation: 1→3, 2→1, 3→2
        new_text, new_citations = _reindex_citation_references(text, citations, [2, 3, 1])

        # 2 becomes cite-1 (new), 3 becomes cite-2, 1 becomes cite-3
        assert new_text == "A [3] B [1] C [2]"
        assert [c.id for c in new_citations] == ["cite-2", "cite-3", "cite-1"]

    def test_identity_mapping(self):
        text = "A [1] B [2]"
        citations = _cites(2)
        new_text, new_citations = _reindex_citation_references(text, citations, [1, 2])

        assert new_text == "A [1] B [2]"
        assert [c.id for c in new_citations] == ["cite-1", "cite-2"]

    def test_subset_drops_unused_citations(self):
        text = "Only [1] and [3] used here."
        citations = _cites(3)
        new_text, new_citations = _reindex_citation_references(text, citations, [1, 3])

        assert new_text == "Only [1] and [2] used here."
        assert [c.id for c in new_citations] == ["cite-1", "cite-3"]

    def test_normalizes_source_n_form(self):
        text = "See [Source 1] and (Source 2) and Source 3 also."
        citations = _cites(3)
        new_text, _ = _reindex_citation_references(text, citations, [1, 2, 3])

        assert new_text == "See [1] and [2] and [3] also."

    def test_ignores_indices_out_of_range(self):
        text = "A [1] B [2] C"
        citations = _cites(2)
        new_text, new_citations = _reindex_citation_references(text, citations, [1, 2, 99])

        assert new_text == "A [1] B [2] C"
        assert len(new_citations) == 2

    def test_dedupes_repeated_indices(self):
        text = "A [1] B [2] C"
        citations = _cites(2)
        new_text, new_citations = _reindex_citation_references(text, citations, [2, 2, 1, 1])

        assert new_text == "A [2] B [1] C"
        assert [c.id for c in new_citations] == ["cite-2", "cite-1"]

    def test_no_op_when_no_used_indices(self):
        text = "A [1] B [2]"
        citations = _cites(2)
        new_text, new_citations = _reindex_citation_references(text, citations, [])

        assert new_text == text
        assert new_citations == citations

    def test_no_op_when_no_citations(self):
        text = "Nothing to reindex"
        new_text, new_citations = _reindex_citation_references(text, [], [1, 2])

        assert new_text == text
        assert new_citations == []

    def test_unused_citation_marker_left_in_text(self):
        # If the model emits [3] but only 2 sources were chosen,
        # reindex leaves it untouched. Downstream removal handles cleanup.
        text = "A [1] B [3] C"
        citations = _cites(3)
        new_text, _ = _reindex_citation_references(text, citations, [1, 2])

        assert new_text == "A [1] B [3] C"


# ---------------------------------------------------------------------------
# _strip_tracking_params / _strip_tracking_params_in_text
# ---------------------------------------------------------------------------


class TestStripTrackingParams:
    def test_removes_utm_source(self):
        url = "https://example.com/page?utm_source=openai"
        assert _strip_tracking_params(url) == "https://example.com/page"

    def test_removes_multiple_utm_params(self):
        url = "https://example.com/page?utm_source=openai&utm_medium=ai&utm_campaign=x"
        assert _strip_tracking_params(url) == "https://example.com/page"

    def test_keeps_non_utm_params(self):
        url = "https://example.com/page?id=42&utm_source=openai&q=hello"
        result = _strip_tracking_params(url)
        # Order of preserved params must be stable
        assert result == "https://example.com/page?id=42&q=hello"

    def test_preserves_path_and_fragment(self):
        url = "https://example.com/path/to/page?utm_source=x#section-2"
        assert _strip_tracking_params(url) == "https://example.com/path/to/page#section-2"

    def test_handles_url_without_query(self):
        url = "https://example.com/page"
        assert _strip_tracking_params(url) == "https://example.com/page"

    def test_handles_none(self):
        assert _strip_tracking_params(None) is None

    def test_handles_empty_string(self):
        assert _strip_tracking_params("") == ""

    def test_case_insensitive_param_match(self):
        url = "https://example.com/page?UTM_Source=openai&UTM_MEDIUM=x"
        assert _strip_tracking_params(url) == "https://example.com/page"


class TestStripTrackingParamsInText:
    def test_strips_url_in_prose(self):
        text = "See https://example.com/a?utm_source=openai for details."
        assert _strip_tracking_params_in_text(text) == "See https://example.com/a for details."

    def test_strips_multiple_urls(self):
        text = "First https://a.com/x?utm_source=ai and second https://b.com/y?utm_medium=x done."
        assert _strip_tracking_params_in_text(text) == (
            "First https://a.com/x and second https://b.com/y done."
        )

    def test_leaves_clean_urls_alone(self):
        text = "Visit https://example.com/page for info."
        assert _strip_tracking_params_in_text(text) == text

    def test_handles_empty_or_none(self):
        assert _strip_tracking_params_in_text(None) == ""
        assert _strip_tracking_params_in_text("") == ""

    def test_does_not_eat_trailing_punctuation(self):
        text = "Source: https://example.com/page?utm_source=x."
        assert _strip_tracking_params_in_text(text) == "Source: https://example.com/page."

    def test_preserves_markdown_link_structure(self):
        text = "[link](https://example.com/page?utm_source=openai)"
        assert _strip_tracking_params_in_text(text) == "[link](https://example.com/page)"


# ---------------------------------------------------------------------------
# _is_formula_listing_query
# ---------------------------------------------------------------------------


class TestIsFormulaListingQuery:
    def test_which_calculations(self):
        assert _is_formula_listing_query("which calculations that we do with this pdfs?")

    def test_what_formulas(self):
        assert _is_formula_listing_query("What formulas does this book describe?")

    def test_list_the_equations(self):
        assert _is_formula_listing_query("list all the equations in chapter 3")

    def test_show_me_formulas(self):
        assert _is_formula_listing_query("show me the formulas for fan power")

    def test_the_formula_for_x(self):
        # "the formula for X" should also trigger — user wants verbatim formula
        assert _is_formula_listing_query("what is the formula for kinetic energy?")

    def test_compute_request_does_not_trigger(self):
        # Imperative compute request should go to calculation_agent path, not this listing prompt
        assert not _is_formula_listing_query("Calculate the force given Q=5 and E=10")

    def test_general_qa_does_not_trigger(self):
        assert not _is_formula_listing_query("What does the book say about centrifugal fans?")

    def test_empty_query(self):
        assert not _is_formula_listing_query("")

    def test_topic_word_alone_is_insufficient(self):
        # Bare "formula" without listing intent should not switch modes
        assert not _is_formula_listing_query("formula")

    def test_listing_intent_alone_is_insufficient(self):
        # "list everything" with no calculation topic shouldn't trigger
        assert not _is_formula_listing_query("list everything you found")


# ---------------------------------------------------------------------------
# _promote_equation_sources
# ---------------------------------------------------------------------------


class TestIsSubstantiveFormulaLatex:
    """Filters unit conversions out of the formula-lookup retrieval path."""

    def test_accepts_greek_letter(self):
        assert _is_substantive_formula_latex(r"\Delta p = \rho g h")

    def test_accepts_frac(self):
        assert _is_substantive_formula_latex(r"L_W = 10 \log_{10}\frac{P_2}{P_1}")

    def test_accepts_letter_subscript(self):
        assert _is_substantive_formula_latex(r"Q_1 / Q_2 = N_1 / N_2")

    def test_accepts_letter_superscript(self):
        assert _is_substantive_formula_latex(r"E = mc^2")

    def test_rejects_unit_conversion_kp_n(self):
        # OCR'd/extracted unit conversion — passes _looks_like_latex but is
        # noise for a formulas-in-the-book query.
        assert not _is_substantive_formula_latex(r"1\,\mathrm{kp} = 9.81\,\mathrm{N}")

    def test_rejects_unit_conversion_bare(self):
        assert not _is_substantive_formula_latex("1 kp = 9,81 N")

    def test_rejects_torr_to_pa(self):
        assert not _is_substantive_formula_latex(r"1\,\mathrm{Torr} = 133\,\mathrm{Pa}")

    def test_rejects_temperature_unit_equality(self):
        assert not _is_substantive_formula_latex("1 grd = 1 K")

    def test_rejects_empty(self):
        assert not _is_substantive_formula_latex("")
        assert not _is_substantive_formula_latex(None)  # type: ignore[arg-type]

    def test_accepts_propto(self):
        assert _is_substantive_formula_latex(r"Q \propto D^3 N")


class TestRenderClaimsToMarkdown:
    """Structured citation pipeline: claims-with-citations → markdown."""

    def test_simple_claim(self):
        text, used = _render_claims_to_markdown(
            [{"text": "The flow rate is constant.", "citations": [1]}],
            max_index=3,
        )
        assert text == "The flow rate is constant [1]."
        assert used == [1]

    def test_multiple_citations_per_claim_render_in_order(self):
        text, used = _render_claims_to_markdown(
            [{"text": "Pressure drops with friction.", "citations": [2, 1, 3]}],
            max_index=5,
        )
        assert text == "Pressure drops with friction [2][1][3]."
        assert used == [2, 1, 3]

    def test_multiple_claims_joined_by_blank_line(self):
        text, used = _render_claims_to_markdown(
            [
                {"text": "First claim.", "citations": [1]},
                {"text": "Second claim.", "citations": [2]},
            ],
            max_index=2,
        )
        assert text == "First claim [1].\n\nSecond claim [2]."
        assert used == [1, 2]

    def test_markers_before_trailing_question_mark(self):
        text, _ = _render_claims_to_markdown(
            [{"text": "Is it true?", "citations": [1]}],
            max_index=1,
        )
        assert text == "Is it true [1]?"

    def test_no_terminal_punctuation_appends_marker(self):
        text, _ = _render_claims_to_markdown(
            [{"text": "Unterminated claim", "citations": [1]}],
            max_index=1,
        )
        assert text == "Unterminated claim [1]"

    def test_drops_claim_without_citations(self):
        # The whole point of the structured schema is strict citations.
        text, used = _render_claims_to_markdown(
            [
                {"text": "Backed claim.", "citations": [1]},
                {"text": "Unbacked claim.", "citations": []},
            ],
            max_index=3,
        )
        assert text == "Backed claim [1]."
        assert used == [1]

    def test_drops_out_of_range_citations(self):
        text, used = _render_claims_to_markdown(
            [{"text": "Claim.", "citations": [1, 99, 0, -1]}],
            max_index=2,
        )
        assert text == "Claim [1]."
        assert used == [1]

    def test_drops_claim_with_only_invalid_citations(self):
        text, used = _render_claims_to_markdown(
            [{"text": "Claim.", "citations": [99, 100]}],
            max_index=2,
        )
        assert text == ""
        assert used == []

    def test_dedupes_used_sources_across_claims(self):
        text, used = _render_claims_to_markdown(
            [
                {"text": "First.", "citations": [1, 2]},
                {"text": "Second.", "citations": [2, 3]},
                {"text": "Third.", "citations": [1]},
            ],
            max_index=5,
        )
        assert text == "First [1][2].\n\nSecond [2][3].\n\nThird [1]."
        assert used == [1, 2, 3]

    def test_handles_string_citation_indices(self):
        # Model occasionally emits "1" instead of 1.
        text, used = _render_claims_to_markdown(
            [{"text": "Claim.", "citations": ["1", "2"]}],
            max_index=3,
        )
        assert text == "Claim [1][2]."
        assert used == [1, 2]

    def test_skips_non_dict_claim_entries(self):
        text, used = _render_claims_to_markdown(
            ["bad string", {"text": "Good.", "citations": [1]}, None],
            max_index=2,
        )
        assert text == "Good [1]."
        assert used == [1]

    def test_empty_input(self):
        text, used = _render_claims_to_markdown([], max_index=3)
        assert text == ""
        assert used == []


class TestStripAnchorMarkers:
    def test_removes_simple_marker(self):
        assert _strip_anchor_markers("<c>5.3</c>Hello world") == "Hello world"

    def test_removes_multiple_markers(self):
        text = "<c>1.0</c>First sentence. <c>1.1</c>Second sentence."
        assert _strip_anchor_markers(text) == "First sentence. Second sentence."

    def test_leaves_non_anchor_html_alone(self):
        # Standard markdown / HTML should pass through untouched.
        text = "Some <em>emphasis</em> and <strong>bold</strong>."
        assert _strip_anchor_markers(text) == text

    def test_empty_input(self):
        assert _strip_anchor_markers("") == ""
        assert _strip_anchor_markers(None) == ""  # type: ignore[arg-type]


class TestBuildAnchorIndex:
    def _source_with_anchors(self, anchors: list[dict]) -> RetrievalResult:
        return RetrievalResult(
            source_type="pdf",
            chunk_id=None,
            document_name="doc",
            page_number=12,
            content="x",
            anchors=anchors,
            relevance_score=1.0,
        )

    def test_indexes_each_anchor_id(self):
        sources = [self._source_with_anchors([
            {"id": "12.0", "bbox": [0, 0, 10, 10], "char_start": 0, "char_end": 5},
            {"id": "12.1", "bbox": [0, 12, 10, 22], "char_start": 6, "char_end": 12},
        ])]
        index = _build_anchor_index(sources)
        assert set(index.keys()) == {"12.0", "12.1"}
        assert index["12.0"]["bbox"] == [0, 0, 10, 10]

    def test_skips_anchors_without_id(self):
        sources = [self._source_with_anchors([
            {"bbox": [1, 2, 3, 4]},  # no id
            {"id": "1.0", "bbox": [5, 6, 7, 8]},
        ])]
        index = _build_anchor_index(sources)
        assert list(index.keys()) == ["1.0"]

    def test_handles_source_without_anchors(self):
        source = RetrievalResult(source_type="pdf", content="x", anchors=None)
        assert _build_anchor_index([source]) == {}

    def test_later_source_overrides_duplicate_anchor(self):
        # If two sources share an anchor id (which shouldn't happen in
        # practice), the later one wins. This is just documenting behaviour.
        a = self._source_with_anchors([{"id": "1.0", "bbox": [0, 0, 1, 1]}])
        b = self._source_with_anchors([{"id": "1.0", "bbox": [9, 9, 10, 10]}])
        index = _build_anchor_index([a, b])
        assert index["1.0"]["bbox"] == [9, 9, 10, 10]


class TestResolveCitationToken:
    def _source(self, **kwargs) -> RetrievalResult:
        # Char layout of "zero one two three four five":
        # zero=0-4 (incl trailing space), one=4-8, two=8-12, three=12-18, ...
        defaults = dict(
            source_type="pdf",
            document_name="doc",
            page_number=12,
            content="zero one two three four five",
            bbox_references=[[0, 0, 100, 100]],
            anchors=[
                # Anchor 12.0 covers "zero" (chars 0..4)
                {"id": "12.0", "bbox": [0, 0, 50, 20], "char_start": 0, "char_end": 4},
                # Anchor 12.1 covers "one two" (chars 5..12)
                {"id": "12.1", "bbox": [0, 22, 50, 42], "char_start": 5, "char_end": 12},
            ],
        )
        defaults.update(kwargs)
        return RetrievalResult(**defaults)

    def test_anchor_id_yields_sentence_bbox(self):
        source = self._source()
        index = _build_anchor_index([source])
        cite = _resolve_citation_token("12.1", index, [source])
        assert cite is not None
        assert cite.boxes == [[0, 22, 50, 42]]
        assert cite.id == "cite-12.1"
        # The snippet is sliced from the resolved char range.
        assert "one two" in cite.snippet

    def test_unknown_anchor_id_returns_none(self):
        source = self._source()
        index = _build_anchor_index([source])
        assert _resolve_citation_token("99.99", index, [source]) is None

    def test_integer_token_falls_back_to_chunk_citation(self):
        sources = [self._source(), self._source(page_number=15)]
        index = _build_anchor_index(sources)
        cite = _resolve_citation_token("2", index, sources)
        assert cite is not None
        assert cite.page == 15
        # Chunk-level fallback uses the chunk's first bbox.
        assert cite.boxes == [[0, 0, 100, 100]]
        assert cite.id == "cite-2"

    def test_out_of_range_integer_returns_none(self):
        source = self._source()
        index = _build_anchor_index([source])
        assert _resolve_citation_token("5", index, [source]) is None
        assert _resolve_citation_token("0", index, [source]) is None

    def test_garbage_token_returns_none(self):
        source = self._source()
        index = _build_anchor_index([source])
        assert _resolve_citation_token("not-a-number", index, [source]) is None
        assert _resolve_citation_token(None, index, [source]) is None


class TestRenderClaimsWithAnchors:
    def _two_source_setup(self) -> list[RetrievalResult]:
        # Source 1 has two anchors (sentence-level), source 2 has none (legacy)
        s1 = RetrievalResult(
            source_type="pdf",
            document_name="doc-a",
            page_number=12,
            content="zero one two three four",
            bbox_references=[[0, 0, 200, 200]],
            anchors=[
                {"id": "12.0", "bbox": [0, 0, 50, 20], "char_start": 0, "char_end": 8},
                {"id": "12.1", "bbox": [0, 22, 50, 42], "char_start": 9, "char_end": 16},
            ],
        )
        s2 = RetrievalResult(
            source_type="pdf",
            document_name="doc-b",
            page_number=5,
            content="legacy content with no anchors",
            bbox_references=[[10, 10, 90, 90]],
            anchors=None,
        )
        return [s1, s2]

    def test_anchor_citation_yields_sentence_highlight(self):
        sources = self._two_source_setup()
        text, pool = _render_claims_with_anchors(
            [{"text": "Sentence-level claim.", "citations": ["12.1"]}],
            sources,
        )
        assert text == "Sentence-level claim [1]."
        assert len(pool) == 1
        assert pool[0].boxes == [[0, 22, 50, 42]]

    def test_dedupes_pool_across_claims(self):
        sources = self._two_source_setup()
        text, pool = _render_claims_with_anchors(
            [
                {"text": "First.", "citations": ["12.0"]},
                {"text": "Second.", "citations": ["12.0", "12.1"]},
            ],
            sources,
        )
        assert text == "First [1].\n\nSecond [1][2]."
        assert len(pool) == 2

    def test_falls_back_to_legacy_chunk_citation(self):
        sources = self._two_source_setup()
        text, pool = _render_claims_with_anchors(
            [{"text": "Whole-chunk claim.", "citations": ["2"]}],
            sources,
        )
        assert text == "Whole-chunk claim [1]."
        assert len(pool) == 1
        # Chunk-level fallback bbox.
        assert pool[0].boxes == [[10, 10, 90, 90]]

    def test_drops_claim_without_resolvable_citations(self):
        sources = self._two_source_setup()
        text, pool = _render_claims_with_anchors(
            [
                {"text": "Backed.", "citations": ["12.0"]},
                {"text": "Unbacked.", "citations": ["99.99", "garbage"]},
            ],
            sources,
        )
        assert text == "Backed [1]."
        assert len(pool) == 1

    def test_empty_input(self):
        text, pool = _render_claims_with_anchors([], [])
        assert text == ""
        assert pool == []

    def test_mixed_anchor_and_legacy_citations(self):
        sources = self._two_source_setup()
        text, pool = _render_claims_with_anchors(
            [{"text": "Mixed claim.", "citations": ["12.0", "2"]}],
            sources,
        )
        assert text == "Mixed claim [1][2]."
        assert len(pool) == 2
        assert pool[0].boxes == [[0, 0, 50, 20]]  # sentence bbox
        assert pool[1].boxes == [[10, 10, 90, 90]]  # chunk-level fallback


class TestMergeRetrievalResults:
    """Quality-gate retry path uses this to combine primary + retry hits."""

    def _result(self, chunk_id: str, score: float) -> RetrievalResult:
        from uuid import UUID

        return RetrievalResult(
            source_type="pdf",
            chunk_id=UUID(int=int(chunk_id, 16)),
            document_name="doc",
            page_number=1,
            content="x",
            relevance_score=score,
        )

    def test_dedupes_by_chunk_id_keeping_higher_score(self):
        a = self._result("a" * 32, 0.4)
        a_better = self._result("a" * 32, 0.8)
        b = self._result("b" * 32, 0.6)
        merged = _merge_retrieval_results([a, b], [a_better], top_k=10)
        assert len(merged) == 2
        scores_by_chunk = {r.chunk_id: r.relevance_score for r in merged}
        assert scores_by_chunk[a.chunk_id] == 0.8
        assert scores_by_chunk[b.chunk_id] == 0.6

    def test_orders_by_relevance_desc(self):
        results = [
            self._result("1" * 32, 0.3),
            self._result("2" * 32, 0.7),
            self._result("3" * 32, 0.5),
        ]
        merged = _merge_retrieval_results(results, [], top_k=10)
        assert [r.relevance_score for r in merged] == [0.7, 0.5, 0.3]

    def test_caps_to_top_k(self):
        results = [self._result(f"{i:032x}", 0.9 - i * 0.05) for i in range(8)]
        merged = _merge_retrieval_results(results, [], top_k=3)
        assert len(merged) == 3
        # Highest 3 scores preserved.
        assert merged[0].relevance_score >= merged[1].relevance_score >= merged[2].relevance_score

    def test_drops_results_without_chunk_id(self):
        # chunk_id is required to deduplicate. Without it we drop.
        bad = RetrievalResult(source_type="pdf", chunk_id=None, content="x", relevance_score=0.9)
        good = self._result("a" * 32, 0.5)
        merged = _merge_retrieval_results([bad, good], [], top_k=10)
        assert len(merged) == 1
        assert merged[0].chunk_id == good.chunk_id


class TestPromoteEquationSources:
    def _result(self, idx: int, ctype: str) -> RetrievalResult:
        return RetrievalResult(
            source_type="pdf",
            document_name=f"doc-{idx}",
            page_number=idx,
            chunk_type=ctype,
            content=f"chunk {idx}",
        )

    def test_equations_lead(self):
        sources = [
            self._result(1, "section"),
            self._result(2, "equation"),
            self._result(3, "page"),
            self._result(4, "equation"),
        ]
        out = _promote_equation_sources(sources)
        assert [s.page_number for s in out] == [2, 4, 1, 3]

    def test_preserves_relative_order_within_groups(self):
        sources = [
            self._result(10, "equation"),
            self._result(20, "section"),
            self._result(30, "equation"),
            self._result(40, "page"),
            self._result(50, "section"),
        ]
        out = _promote_equation_sources(sources)
        # equation chunks first, in original order; then non-equation, in original order
        assert [s.page_number for s in out] == [10, 30, 20, 40, 50]

    def test_no_equations_unchanged(self):
        sources = [
            self._result(1, "section"),
            self._result(2, "page"),
        ]
        out = _promote_equation_sources(sources)
        assert [s.page_number for s in out] == [1, 2]

    def test_all_equations_unchanged(self):
        sources = [
            self._result(1, "equation"),
            self._result(2, "equation"),
        ]
        out = _promote_equation_sources(sources)
        assert [s.page_number for s in out] == [1, 2]

    def test_empty(self):
        assert _promote_equation_sources([]) == []
