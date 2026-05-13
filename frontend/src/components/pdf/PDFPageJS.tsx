"use client";

import "@/components/pdf/pdfjsSetup";

import { useCallback, useEffect, useRef, useState } from "react";
import { Page } from "react-pdf";

import { AnnotationOverlay } from "@/components/pdf/AnnotationOverlay";
import { AnnotationPopover, type AnnotationDraft } from "@/components/pdf/AnnotationPopover";
import { HighlightOverlay } from "@/components/pdf/HighlightOverlay";
import { TranslatePopover } from "@/components/pdf/TranslatePopover";
import type { Annotation, Citation } from "@/lib/types";
import { useAnnotationsStore } from "@/stores/annotationsStore";
import { useChatStore } from "@/stores/chatStore";
import { usePDFViewerStore } from "@/stores/pdfViewerStore";

interface PDFPageJSProps {
  pageNumber: number;
  zoom: number;
  // When provided, every page renders at this width (multiplied by zoom)
  // so a multi-page document with mixed native dimensions reads as a
  // uniform column instead of a ragged stack. Falls back to scale-based
  // rendering when omitted.
  baseWidth?: number | null;
  // Pre-rendered page image from the backend. Shown absolute-positioned
  // behind the canvas the moment the slot mounts, so the user never sees
  // a blank box while PDF.js's worker churns. Fades out the instant
  // PDF.js' onRenderSuccess fires.
  previewImageUrl?: string | null;
  highlights: Citation[];
  annotations?: Annotation[];
  documentId?: string | null;
  currentUserId?: string | null;
  // Resolves a printed PDF page label (e.g. "40", "iv") to the
  // 1-indexed internal page that carries it. Returns null if the
  // PDF has no embedded labels or the label isn't found, in which
  // case the caller should fall back to the raw label value.
  resolvePageLabel?: (label: string) => number | null;
  searchQuery?: string;
  // Index of the active hit on this page (0-based, only meaningful when
  // searchQuery is non-empty and this page contains the active match).
  activeSearchIndexInPage?: number | null;
  onRenderSuccess?: (info: { pageNumber: number; width: number; height: number }) => void;
  onHighlightReady?: () => void;
  onActiveSearchHitMounted?: (element: HTMLElement) => void;
}

/**
 * Single page rendered by react-pdf / PDF.js. Lives inside a parent
 * <Document> context (see PDFViewer). The page renders as a real PDF
 * with a native text layer (selectable, copy-pasteable, browser-search
 * compatible) and an annotation layer (internal links work). On top
 * we paint our existing bbox-based citation highlight overlay so the
 * citation system carries over from the old image-based viewer.
 */
export function PDFPageJS({
  pageNumber,
  zoom,
  baseWidth = null,
  previewImageUrl = null,
  highlights,
  annotations = [],
  documentId = null,
  currentUserId = null,
  resolvePageLabel,
  searchQuery,
  activeSearchIndexInPage,
  onRenderSuccess,
  onHighlightReady,
  onActiveSearchHitMounted,
}: PDFPageJSProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [pageSize, setPageSize] = useState<{
    width: number;
    height: number;
    pdfWidth: number;
    pdfHeight: number;
  } | null>(null);
  const lastReadyKeyRef = useRef<string | null>(null);
  const [draft, setDraft] = useState<AnnotationDraft | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  // Ephemeral translation popover state. Holds the source text and the
  // anchor coords inherited from the annotation popover so it appears
  // in roughly the same spot when the user clicks Translate.
  const [translation, setTranslation] = useState<{
    text: string;
    anchorLeft: number;
    anchorTop: number;
  } | null>(null);
  const createAnnotation = useAnnotationsStore((state) => state.create);
  const setPassageContext = useChatStore((state) => state.setPassageContext);
  const focusComposer = useChatStore((state) => state.focusComposer);
  const currentDocument = usePDFViewerStore((state) => state.currentDocument);
  const loadPage = usePDFViewerStore((state) => state.loadPage);

  const handleRenderSuccess = (page: { width: number; height: number; originalWidth: number; originalHeight: number }) => {
    setPageSize({
      width: page.width,
      height: page.height,
      pdfWidth: page.originalWidth,
      pdfHeight: page.originalHeight,
    });
    onRenderSuccess?.({ pageNumber, width: page.width, height: page.height });
  };

  useEffect(() => {
    if (!pageSize || !highlights.length) {
      return;
    }
    const key = `${pageNumber}:${highlights
      .map((c) => c.id)
      .sort()
      .join(",")}:${pageSize.width}x${pageSize.height}`;
    if (lastReadyKeyRef.current === key) {
      return;
    }
    lastReadyKeyRef.current = key;
    window.requestAnimationFrame(() => onHighlightReady?.());
  }, [pageSize, highlights, pageNumber, onHighlightReady]);

  // Paint search hits onto the rendered text layer. Runs after the page
  // size is known (proxy for "text layer is in the DOM"). The text layer
  // spans are positioned over invisible glyphs; tagging the entire span
  // with a yellow background gives a visible word-level highlight without
  // having to splice <mark> tags inside (which would break PDF.js's
  // coordinate math).
  useEffect(() => {
    const root = containerRef.current;
    if (!root) {
      return;
    }
    const textLayer = root.querySelector<HTMLElement>(".react-pdf__Page__textContent");
    if (!textLayer) {
      return;
    }

    const previous = textLayer.querySelectorAll<HTMLElement>(
      "[data-maia-search-hit='true']",
    );
    previous.forEach((el) => {
      el.removeAttribute("data-maia-search-hit");
      el.removeAttribute("data-maia-search-active");
    });

    const needle = (searchQuery ?? "").trim().toLowerCase();
    if (!pageSize || needle.length < 2) {
      return;
    }

    const spans = Array.from(textLayer.querySelectorAll<HTMLElement>("span"));
    let occurrence = 0;
    let activeElement: HTMLElement | null = null;
    for (const span of spans) {
      const text = (span.textContent ?? "").toLowerCase();
      if (!text || !text.includes(needle)) {
        continue;
      }
      // A single span can contain multiple hits; account for each so the
      // counter in the toolbar matches what the user can navigate to.
      let cursor = 0;
      while (true) {
        const idx = text.indexOf(needle, cursor);
        if (idx === -1) {
          break;
        }
        if (occurrence === 0 || !span.dataset.maiaSearchHit) {
          span.dataset.maiaSearchHit = "true";
        }
        if (occurrence === activeSearchIndexInPage) {
          span.dataset.maiaSearchActive = "true";
          activeElement = span;
        }
        occurrence += 1;
        cursor = idx + needle.length;
      }
    }

    if (activeElement) {
      onActiveSearchHitMounted?.(activeElement);
    }
  }, [pageSize, searchQuery, activeSearchIndexInPage, onActiveSearchHitMounted]);

  // Tag every text-layer span whose entire trimmed text is a valid
  // page number (1–4 digit integer within the document's page count,
  // and not the current page). The tag drives the pointer-cursor +
  // hover-tint CSS so the user can see exactly what's clickable. Re-
  // runs on text-layer mutations so pdf.js re-renders (zoom, scroll)
  // don't strand the tags. No line grouping, no continuation, no
  // sibling propagation — only the number spans themselves are
  // tagged, so a click on "40" can never resolve to anything but 40.
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !currentDocument) return;
    const pageCount = currentDocument.page_count ?? 0;
    if (pageCount <= 0) return;

    let cancelled = false;
    const cleanups: Array<() => void> = [];

    const tagNumbers = () => {
      if (cancelled) return;
      const textLayer = root.querySelector<HTMLElement>(".react-pdf__Page__textContent");
      if (!textLayer) return;
      for (const span of textLayer.querySelectorAll<HTMLElement>("span")) {
        if (span.dataset.maiaPageNumber === "true") continue;
        const text = (span.textContent ?? "").trim();
        const m = /^(\d{1,4})$/.exec(text);
        if (!m) continue;
        const n = parseInt(m[1], 10);
        if (n < 1 || n > pageCount || n === pageNumber) continue;
        span.dataset.maiaPageNumber = "true";
        span.style.cursor = "pointer";
        cleanups.push(() => {
          delete span.dataset.maiaPageNumber;
          if (span.style.cursor === "pointer") span.style.cursor = "";
        });
      }
    };

    // Run once now and let the MutationObserver catch every later
    // text-layer update. Earlier versions also fired setTimeout
    // retries at 80/320/1000ms, but those just duplicated work the
    // observer already covers and added per-page CPU during scrolls.
    tagNumbers();

    let debounce: number | null = null;
    const debounced = () => {
      if (debounce) window.clearTimeout(debounce);
      debounce = window.setTimeout(tagNumbers, 60);
    };
    let textLayerObserver: MutationObserver | null = null;
    const watchTextLayer = (): boolean => {
      if (cancelled) return false;
      const textLayer = root.querySelector<HTMLElement>(".react-pdf__Page__textContent");
      if (!textLayer) return false;
      textLayerObserver = new MutationObserver(debounced);
      textLayerObserver.observe(textLayer, { childList: true, subtree: false });
      return true;
    };
    let rootObserver: MutationObserver | null = null;
    if (!watchTextLayer()) {
      rootObserver = new MutationObserver(() => {
        if (watchTextLayer()) {
          rootObserver?.disconnect();
          rootObserver = null;
          debounced();
        }
      });
      rootObserver.observe(root, { childList: true, subtree: true });
    }

    return () => {
      cancelled = true;
      if (debounce) window.clearTimeout(debounce);
      textLayerObserver?.disconnect();
      rootObserver?.disconnect();
      cleanups.forEach((c) => c());
    };
  }, [pageSize, currentDocument, pageNumber]);

  // Page-level click handler.
  //
  // Rule, strictly: if the user clicks on a text-layer span whose
  // *own* trimmed text is a valid page number, navigate to that
  // number. Otherwise do nothing. No fallbacks, no sibling scan, no
  // pre-tagged targets, no whole-line heuristics. The user's click
  // coordinate determines the destination — only the span actually
  // under the cursor matters.
  //
  // Also kills PDF.js annotation-layer <a href="#"> clicks so the URL
  // bar never flashes "#".
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !currentDocument) return;
    const pageCount = currentDocument.page_count ?? 0;
    if (pageCount <= 0) return;

    const handler = (event: MouseEvent) => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim().length > 8) {
        return;
      }

      // Block the URL hash flip from annotation-layer internal links.
      if (event.target instanceof Element) {
        const link = event.target.closest("a");
        if (link && link.closest(".annotationLayer")) {
          const href = link.getAttribute("href") ?? "";
          if (!href || href.startsWith("#")) {
            event.preventDefault();
          }
        }
      }

      // Among all elements under the cursor, pick the text-layer span
      // whose own text is a valid page number AND whose vertical
      // center is closest to the click Y (so two overlapping number
      // spans from adjacent lines resolve to the one the user is
      // visually on).
      const stack = document.elementsFromPoint(event.clientX, event.clientY);
      let best: { n: number; dist: number } | null = null;
      for (const el of stack) {
        if (!(el instanceof HTMLElement)) continue;
        if (el.tagName !== "SPAN") continue;
        if (!el.closest(".react-pdf__Page__textContent")) continue;
        const text = (el.textContent ?? "").trim();
        const m = /^(\d{1,4})$/.exec(text);
        if (!m) continue;
        const n = parseInt(m[1], 10);
        if (n < 1 || n > pageCount || n === pageNumber) continue;
        const r = el.getBoundingClientRect();
        const cy = r.top + r.height / 2;
        const dist = Math.abs(cy - event.clientY);
        if (!best || dist < best.dist) {
          best = { n, dist };
        }
      }
      if (!best) return;

      // The TOC reference is a printed page label (e.g. "40"). Resolve
      // it to the internal page that carries that label — books with
      // any unnumbered front matter have an offset between internal
      // page index and printed page number. Falls back to the raw
      // value when the PDF has no embedded labels.
      const resolved = resolvePageLabel?.(String(best.n)) ?? best.n;
      const targetInternal = resolved >= 1 && resolved <= pageCount ? resolved : best.n;

      event.preventDefault();
      event.stopPropagation();
      selection?.removeAllRanges();
      void loadPage(currentDocument, targetInternal, []);
    };

    root.addEventListener("click", handler, true);
    return () => root.removeEventListener("click", handler, true);
  }, [currentDocument, loadPage, pageNumber, resolvePageLabel]);

  // Capture the user's text selection inside this page's text layer and
  // turn it into a draft annotation. Runs on mouseup so the rect set is
  // stable. Only fires when the selection is fully contained within
  // *this* page — otherwise dragging across pages would attach the
  // highlight to whichever page handled mouseup last.
  const handleMouseUp = useCallback(() => {
    // Skip while a draft popover is already open — the popover is the
    // user's active surface, and any mouseup that bubbles up (e.g. when
    // they release after dragging the popover) shouldn't re-trigger
    // selection capture and snap the popover back to its anchor.
    if (draft) {
      return;
    }
    if (!documentId || !pageSize || !containerRef.current) {
      return;
    }
    const root = containerRef.current;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
      return;
    }
    const text = selection.toString().trim();
    if (text.length < 2) {
      return;
    }
    const rootRect = root.getBoundingClientRect();
    // Use the browser's own per-line rects for the selection. We
    // tried walking text nodes by hand, but PDF.js text-layer DOM
    // order doesn't always match visual order (footers, multi-
    // column blocks, etc.) — so `range.intersectsNode` would catch
    // nodes that are visually outside the user's drag path and
    // their rects would bleed into the highlight. getClientRects()
    // is computed against the actual visual selection, which is
    // what the user sees, so it's the right source of truth.
    const rawRects = Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 1 && rect.height > 1,
    );
    if (rawRects.length === 0) {
      return;
    }
    // No per-line merging. Every previous attempt at merging
    // (bridging-anything-on-the-same-line / adjacency thresholds /
    // tree-walking) ended up dragging the highlight onto words the
    // user did not select — PDF.js text-layer rects can extend past
    // the visible glyph cluster, especially for justified runs and
    // overlapping spans. So we just record each per-character-cluster
    // rect that the browser already computed against the visual
    // selection. AnnotationOverlay renders these as solid borderless
    // tiles, so adjacent rects read as one continuous strip even
    // though they're stored separately.
    type Strip = { left: number; right: number; top: number; bottom: number };
    const lines: Strip[] = rawRects.map((rect) => ({
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    }));
    const scaleX = pageSize.pdfWidth / pageSize.width;
    const scaleY = pageSize.pdfHeight / pageSize.height;
    const boxes = lines.map((line) => {
      const x1 = (line.left - rootRect.left) * scaleX;
      const y1 = (line.top - rootRect.top) * scaleY;
      const x2 = (line.right - rootRect.left) * scaleX;
      const y2 = (line.bottom - rootRect.top) * scaleY;
      return [x1, y1, x2, y2];
    });
    // Anchor the popover to the last visual line of the selection so it
    // sits beneath the end of what the user actually selected.
    const lastLine = lines[lines.length - 1];
    // Center the popover horizontally inside the PDF panel so it
    // always appears in a predictable, fully-visible spot — anchoring
    // to the selection edge meant a right-margin highlight pushed the
    // popover off-screen even with clamping. Vertically, sit just
    // below the last selected line so the user can still see what
    // they grabbed, but clamp inside the panel.
    const POPOVER_WIDTH = 300;
    const POPOVER_MAX_HEIGHT = 260;
    const EDGE_MARGIN = 12;
    const panelEl = root.closest<HTMLElement>('[data-pdf-scroll="true"]');
    const panelRect = panelEl?.getBoundingClientRect();
    const boundsLeft = panelRect?.left ?? 0;
    const boundsRight = panelRect?.right ?? window.innerWidth;
    const boundsTop = panelRect?.top ?? 0;
    const boundsBottom = panelRect?.bottom ?? window.innerHeight;
    const panelCenter = (boundsLeft + boundsRight) / 2;
    const desiredLeft = panelCenter - POPOVER_WIDTH / 2;
    const desiredTop = lastLine.bottom + 12;
    const minLeft = boundsLeft + EDGE_MARGIN;
    const maxLeft = Math.max(minLeft, boundsRight - POPOVER_WIDTH - EDGE_MARGIN);
    const minTop = boundsTop + EDGE_MARGIN;
    const maxTop = Math.max(minTop, boundsBottom - POPOVER_MAX_HEIGHT - EDGE_MARGIN);
    setDraft({
      pageNumber,
      highlightedText: text,
      anchorLeft: Math.min(Math.max(desiredLeft, minLeft), maxLeft),
      anchorTop: Math.min(Math.max(desiredTop, minTop), maxTop),
      boxes,
    });
  }, [documentId, pageNumber, pageSize, draft]);

  const handleTranslate = useCallback(() => {
    if (!draft) return;
    setTranslation({
      text: draft.highlightedText,
      anchorLeft: draft.anchorLeft,
      anchorTop: draft.anchorTop,
    });
    // Close the annotation popover so the user isn't looking at two
    // overlapping panels.
    setDraft(null);
    window.getSelection()?.removeAllRanges();
  }, [draft]);

  const handleAskMaia = useCallback(() => {
    if (!draft) {
      return;
    }
    // Hand the selection to the chat as a structured "attached
    // passage" instead of seeding the textarea with markdown — the
    // composer renders it as a removable card so the user's actual
    // question stays uncluttered. The agent still sees the quoted
    // text because chatStore.sendMessage splices it into the outbound
    // payload at send time.
    setPassageContext({
      documentId: currentDocument?.id ?? null,
      documentName: currentDocument?.filename ?? null,
      pageNumber: draft.pageNumber,
      text: draft.highlightedText,
    });
    focusComposer();
    setDraft(null);
    window.getSelection()?.removeAllRanges();
  }, [currentDocument, draft, focusComposer, setPassageContext]);

  const handleSaveDraft = useCallback(
    async (input: { color: AnnotationDraft extends infer _ ? string : never; comment: string | null; visibility: string }) => {
      if (!draft || !documentId) {
        return;
      }
      setSavingDraft(true);
      try {
        const result = await createAnnotation({
          document_id: documentId,
          page_number: draft.pageNumber,
          highlighted_text: draft.highlightedText,
          color: input.color as never,
          comment: input.comment,
          visibility: input.visibility as never,
          boxes: draft.boxes,
        });
        if (result) {
          setDraft(null);
          // Clear the browser's selection so the popover doesn't immediately
          // re-open from the still-active selection range.
          window.getSelection()?.removeAllRanges();
        }
      } finally {
        setSavingDraft(false);
      }
    },
    [createAnnotation, documentId, draft],
  );

  return (
    <div
      ref={containerRef}
      // Slot in PDFViewer owns the page-shaped background + shadow,
      // so this container just needs to be a positioning context for
      // the canvas, overlays, and any popovers.
      className="relative mx-auto"
      onMouseUp={handleMouseUp}
    >
      {previewImageUrl ? (
        // Backend JPEG preview painted underneath the canvas. Visible
        // for the ~hundreds of ms PDF.js needs to render its canvas,
        // then faded out. Same trick Google Drive and Adobe Reader
        // web use to avoid the "blank rectangle" wait.
        <img
          src={previewImageUrl}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full object-contain transition-opacity duration-300 ease-out"
          style={{ opacity: pageSize ? 0 : 1 }}
        />
      ) : null}
      <Page
        pageNumber={pageNumber}
        {...(baseWidth && baseWidth > 0
          ? { width: baseWidth * zoom }
          : { scale: zoom })}
        renderTextLayer
        renderAnnotationLayer
        onRenderSuccess={handleRenderSuccess}
        loading={
          // Thin label only — the slot in PDFViewer already paints a
          // page-shaped white background, so the user sees a blank
          // sheet of paper with a small "Loading page N…" caption at
          // the top instead of a tiny grey-bordered box.
          <div className="flex w-full justify-center py-10 text-[11px] uppercase tracking-[0.18em] text-muted/60">
            Loading page {pageNumber}…
          </div>
        }
        error={
          <div className="flex w-full justify-center py-10 text-[11px] uppercase tracking-[0.18em] text-warn">
            Failed to render page {pageNumber}
          </div>
        }
      />
      {pageSize ? (
        <>
          <HighlightOverlay
            citations={highlights}
            coordinateWidth={pageSize.pdfWidth}
            coordinateHeight={pageSize.pdfHeight}
            renderedWidth={pageSize.width}
            renderedHeight={pageSize.height}
          />
          <AnnotationOverlay
            pageNumber={pageNumber}
            annotations={annotations}
            coordinateWidth={pageSize.pdfWidth}
            coordinateHeight={pageSize.pdfHeight}
            renderedWidth={pageSize.width}
            renderedHeight={pageSize.height}
            pageContainerRef={containerRef}
            currentUserId={currentUserId}
          />
        </>
      ) : null}
      {draft ? (
        <AnnotationPopover
          draft={draft}
          saving={savingDraft}
          onCancel={() => setDraft(null)}
          onSave={handleSaveDraft}
          onAskMaia={handleAskMaia}
          onTranslate={handleTranslate}
        />
      ) : null}
      {translation ? (
        <TranslatePopover
          sourceText={translation.text}
          anchorLeft={translation.anchorLeft}
          anchorTop={translation.anchorTop}
          onClose={() => setTranslation(null)}
        />
      ) : null}
    </div>
  );
}
