"use client";

import "@/components/pdf/pdfjsSetup";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, FileSearch2, Globe2 } from "lucide-react";
import { Document as PDFDocument } from "react-pdf";
import type { PDFDocumentProxy } from "pdfjs-dist";

import { PDFOutline, pdfHasOutline } from "@/components/pdf/PDFOutline";
import { PDFPageJS } from "@/components/pdf/PDFPageJS";
import { PDFToolbar } from "@/components/pdf/PDFToolbar";
import { usePdfSearch } from "@/components/pdf/usePdfSearch";
import { LoadingSpinner } from "@/components/shared/LoadingSpinner";
import { api, getCachedPageData, getStoredToken } from "@/lib/api";
import type { Citation, Document, PageData } from "@/lib/types";
import { useAnnotationsStore } from "@/stores/annotationsStore";
import { useAuthStore } from "@/stores/authStore";
import { usePDFViewerStore } from "@/stores/pdfViewerStore";

const ZOOM_STEP = 1.15;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 4;

function PDFLoadIndicator({
  progress,
}: {
  progress: { loaded: number; total: number } | null;
}) {
  // pdfjs reports `total` from the Content-Length header. With range
  // requests the first response covers only a chunk, so `total` may be
  // smaller than the whole file — but the loaded/total ratio is still
  // meaningful per-segment, which is what users want to see.
  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
      : null;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-white">
      <div className="relative h-1.5 w-[220px] overflow-hidden rounded-full bg-white/20">
        {pct !== null ? (
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-white transition-[width] duration-150 ease-out"
            style={{ width: `${pct}%` }}
          />
        ) : (
          <div className="maia-pdf-shimmer absolute inset-y-0 left-0 w-1/3 rounded-full bg-white/80" />
        )}
      </div>
      <p className="text-[11px] uppercase tracking-[0.18em] text-white/80">
        {pct !== null ? `Loading PDF · ${pct}%` : "Loading PDF…"}
      </p>
    </div>
  );
}

const INITIAL_PAGE_WINDOW = 4;
const PAGE_BATCH = 4;
const PAGE_EDGE_THRESHOLD = 320;

function pageKey(documentId: string, pageNumber: number) {
  return `${documentId}:${pageNumber}`;
}

function buildInitialWindow(currentPage: number, pageCount: number | null) {
  const total = Math.max(pageCount ?? currentPage, 1);
  const pagesBeforeCurrent = Math.min(2, INITIAL_PAGE_WINDOW - 1);
  const start = Math.max(1, currentPage - pagesBeforeCurrent);
  const end = Math.min(total, Math.max(currentPage, start + INITIAL_PAGE_WINDOW - 1));
  return { start, end };
}

function buildCitationWindow(currentPage: number, pageCount: number | null) {
  const total = Math.max(pageCount ?? currentPage, 1);
  const page = Math.min(Math.max(currentPage, 1), total);
  return { start: page, end: page };
}

function PageThumbnail({
  document,
  pageNumber,
  active,
  cachedPage,
  onVisible,
  onOpen,
}: {
  document: Document;
  pageNumber: number;
  active: boolean;
  cachedPage: PageData | null;
  onVisible: (pageNumber: number) => void;
  onOpen: (pageNumber: number) => void;
}) {
  const containerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onVisible(pageNumber);
          observer.disconnect();
        }
      },
      { rootMargin: "600px 0px" },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [onVisible, pageNumber]);

  return (
    <button
      ref={containerRef}
      type="button"
      onClick={() => onOpen(pageNumber)}
      className={`group flex w-full flex-col items-center gap-2 border px-2 py-2 text-left transition ${
        active
          ? "border-black/15 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
          : "border-transparent hover:border-black/[0.08] hover:bg-white/60"
      }`}
    >
      <div
        className={`relative aspect-[0.72] w-full overflow-hidden border ${
          active ? "border-black/20" : "border-black/[0.10]"
        } bg-white`}
      >
        {cachedPage ? (
          <img
            src={cachedPage.image_url}
            alt={`Page ${cachedPage.printed_page_label ?? pageNumber}`}
            className="h-full w-full object-cover object-top"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-[#f1f1ef] text-[11px] uppercase tracking-[0.16em] text-muted">
            {pageNumber}
          </div>
        )}
      </div>
      <span
        className={`min-w-[38px] border px-2 py-1 text-center text-[10px] font-medium tracking-[0.14em] ${
          active
            ? "border-black bg-black text-white"
            : "border-black/[0.10] bg-white text-muted"
        }`}
      >
        {cachedPage?.printed_page_label ?? pageNumber}
      </span>
    </button>
  );
}

export function PDFViewer() {
  const currentDocument = usePDFViewerStore((state) => state.currentDocument);
  const currentWebCitation = usePDFViewerStore((state) => state.currentWebCitation);
  const currentPage = usePDFViewerStore((state) => state.currentPage);
  const pageData = usePDFViewerStore((state) => state.pageData);
  const pageCache = usePDFViewerStore((state) => state.pageCache);
  const zoom = usePDFViewerStore((state) => state.zoom);
  const highlights = usePDFViewerStore((state) => state.highlightCitations);
  const loading = usePDFViewerStore((state) => state.loading);
  const openClickNonce = usePDFViewerStore((state) => state.openClickNonce);
  const clearHighlights = usePDFViewerStore((state) => state.clearHighlights);
  const loadPage = usePDFViewerStore((state) => state.loadPage);
  const prefetchPages = usePDFViewerStore((state) => state.prefetchPages);
  const setZoom = usePDFViewerStore((state) => state.setZoom);
  const nextPage = usePDFViewerStore((state) => state.nextPage);
  const previousPage = usePDFViewerStore((state) => state.previousPage);
  const annotations = useAnnotationsStore((state) => state.annotations);
  const loadAnnotations = useAnnotationsStore((state) => state.load);
  const clearAnnotations = useAnnotationsStore((state) => state.clear);
  const currentUserId = useAuthStore((state) => state.user?.id ?? null);
  const hasEvidenceHighlights = highlights.length > 0;
  const hasRenderableHighlight = useMemo(
    () =>
      highlights.some((citation) =>
        citation.boxes?.some(
          (box) => Array.isArray(box) && box.length === 4 && box[2] > box[0] && box[3] > box[1],
        ),
      ),
    [highlights],
  );
  const [visibleRange, setVisibleRange] = useState({ start: 1, end: 0 });
  const [highlightReadyNonce, setHighlightReadyNonce] = useState(0);
  const [pdfProxy, setPdfProxy] = useState<PDFDocumentProxy | null>(null);
  // Resolve PDF "page labels" (printed page numbers, e.g. "40") to
  // 1-indexed internal pages. A TOC entry says "Chapter 5 ... 40";
  // the user clicks "40" expecting to land on the page that shows
  // "40" — but every book with unnumbered front matter has internal
  // index ≠ printed number.
  //
  // Two paths, in order:
  //   (a) pdf.getPageLabels() — the PDF's own embedded labels. Most
  //       PDFs typeset by Acrobat / InDesign include this; many
  //       older scanned books do not.
  //   (b) If (a) returns null, sample a middle page's text content
  //       and look for a header/footer integer. The difference
  //       between that integer and the sampled internal page index
  //       gives the offset for the whole book. Works for any PDF
  //       whose page headers / footers contain the printed number.
  const [pageLabels, setPageLabels] = useState<string[] | null>(null);
  const [pageOffset, setPageOffset] = useState<number>(0);
  useEffect(() => {
    if (!pdfProxy || !currentDocument) {
      setPageLabels(null);
      setPageOffset(0);
      return;
    }
    let cancelled = false;

    (async () => {
      // (a) Try the PDF's own embedded labels first (free, exact).
      try {
        const labels = await pdfProxy.getPageLabels();
        if (cancelled) return;
        if (labels) {
          setPageLabels(labels);
          setPageOffset(0);
          return;
        }
      } catch {
        if (cancelled) return;
      }

      // (b) No embedded labels — ask the backend, which uses
      // PyMuPDF + gpt-4o-mini on 3 sample pages to resolve the
      // printed-page-number offset. Result is cached on the
      // document row, so subsequent opens are a single DB hit.
      try {
        const { offset } = await api.getDocumentPageOffset(currentDocument.id);
        if (cancelled) return;
        setPageLabels(null);
        setPageOffset(typeof offset === "number" && offset >= 0 ? offset : 0);
      } catch {
        if (cancelled) return;
        setPageLabels(null);
        setPageOffset(0);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pdfProxy, currentDocument]);

  const resolvePageLabel = useCallback(
    (label: string): number | null => {
      const target = label.trim();
      // Path (a): exact match against embedded labels.
      if (pageLabels) {
        for (let i = 0; i < pageLabels.length; i += 1) {
          if ((pageLabels[i] ?? "").trim() === target) {
            return i + 1;
          }
        }
        return null;
      }
      // Path (b): apply the detected offset uniformly.
      const printed = parseInt(target, 10);
      if (Number.isNaN(printed) || printed < 1) return null;
      const internal = printed + pageOffset;
      if (!pdfProxy || internal < 1 || internal > pdfProxy.numPages) return null;
      return internal;
    },
    [pageLabels, pageOffset, pdfProxy],
  );
  const [hasOutline, setHasOutline] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<"pages" | "outline">("pages");
  // Real download progress reported by pdfjs's onLoadProgress. Lets us
  // render a determinate bar instead of an indeterminate spinner so the
  // user sees "we're at 40%, hang on" instead of "is this stuck?".
  const [loadProgress, setLoadProgress] = useState<{ loaded: number; total: number } | null>(null);
  // Width of the scroll container's content area. We measure it with
  // ResizeObserver so when the user resizes the panel (or opens the
  // preview dialog at a different size) every rendered page reflows
  // to the new width and stays uniform.
  const [containerInnerWidth, setContainerInnerWidth] = useState<number | null>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const naturalPageWidthRef = useRef<number | null>(null);
  const lastScrollTargetRef = useRef<string | null>(null);

  const search = usePdfSearch(pdfProxy);
  const { currentMatch: searchMatch, query: searchQuery, matches: searchMatches } = search;
  // For each rendered page, count how many search matches precede it on
  // the same page so PDFPageJS can highlight only the active one.
  const activeMatchIndexByPage = useMemo(() => {
    if (!searchMatch) return null;
    return { pageNumber: searchMatch.pageNumber, indexInPage: searchMatch.indexInPage };
  }, [searchMatch]);

  // Stable file prop for react-pdf <Document>: same object reference for
  // the same document, so PDF.js doesn't reload the PDF on every parent
  // re-render. Auth header threaded via httpHeaders so the streaming
  // /file endpoint accepts us.
  const pdfFile = useMemo(() => {
    if (!currentDocument) {
      return null;
    }
    const token = getStoredToken();
    return {
      url: api.getDocumentFileUrl(currentDocument.id),
      httpHeaders: token ? { Authorization: `Bearer ${token}` } : {},
      withCredentials: false as const,
    };
  }, [currentDocument]);

  const loadPreviousPages = useCallback(() => {
    if (!currentDocument?.page_count || visibleRange.start <= 1) {
      return;
    }

    setVisibleRange((current) => ({
      start: Math.max(1, current.start - PAGE_BATCH),
      end: current.end,
    }));
  }, [currentDocument?.page_count, visibleRange.start]);

  const loadNextPages = useCallback(() => {
    if (!currentDocument?.page_count || visibleRange.end >= currentDocument.page_count) {
      return;
    }

    setVisibleRange((current) => ({
      start: current.start,
      end: Math.min(current.end + PAGE_BATCH, currentDocument.page_count ?? current.end + PAGE_BATCH),
    }));
  }, [currentDocument?.page_count, visibleRange.end]);

  const warmThumbnailPage = useCallback(
    async (documentId: string, pageNumber: number) => {
      if (!currentDocument || currentDocument.id !== documentId) {
        return;
      }
      await prefetchPages(currentDocument, [pageNumber]);
    },
    [currentDocument, prefetchPages],
  );

  const loadPages = useCallback(
    async (documentId: string, startPage: number, endPage: number) => {
      if (!currentDocument || currentDocument.id !== documentId) {
        return;
      }
      const pageNumbers = Array.from(
        { length: endPage - startPage + 1 },
        (_, index) => startPage + index,
      );
      await prefetchPages(currentDocument, pageNumbers);
    },
    [currentDocument, prefetchPages],
  );

  useEffect(() => {
    if (!currentDocument) {
      setVisibleRange({ start: 1, end: 0 });
      lastScrollTargetRef.current = null;
      return;
    }

    setVisibleRange(
      hasEvidenceHighlights
        ? buildCitationWindow(currentPage, currentDocument.page_count)
        : buildInitialWindow(currentPage, currentDocument.page_count),
    );
    lastScrollTargetRef.current = null;
    setHighlightReadyNonce(0);
    // openClickNonce is in deps so a repeat click of the same citation
    // re-runs this effect and resets visibleRange to the citation window
    // (otherwise React skips it because doc/page/highlight haven't changed).
  }, [currentDocument, currentPage, hasEvidenceHighlights, openClickNonce]);

  useEffect(() => {
    if (!currentDocument || visibleRange.end < visibleRange.start) {
      return;
    }

    void loadPages(currentDocument.id, visibleRange.start, visibleRange.end);
  }, [currentDocument, loadPages, visibleRange]);

  const handleThumbnailVisible = useCallback(
    (pageNumber: number) => {
      if (!currentDocument) {
        return;
      }
      void warmThumbnailPage(currentDocument.id, pageNumber);
    },
    [currentDocument, warmThumbnailPage],
  );

  const handleOpenPage = useCallback(
    async (pageNumber: number) => {
      if (!currentDocument) {
        return;
      }

      setVisibleRange(buildInitialWindow(pageNumber, currentDocument.page_count));
      await loadPage(
        currentDocument,
        pageNumber,
        pageNumber === currentPage ? highlights : [],
      );
    },
    [currentDocument, currentPage, highlights, loadPage],
  );

  const handleCurrentHighlightReady = useCallback(() => {
    setHighlightReadyNonce((current) => current + 1);
  }, []);

  const clampZoom = (value: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value));

  const handleZoomIn = useCallback(() => {
    setZoom(clampZoom(zoom * ZOOM_STEP));
  }, [setZoom, zoom]);

  const handleZoomOut = useCallback(() => {
    setZoom(clampZoom(zoom / ZOOM_STEP));
  }, [setZoom, zoom]);

  // Pages are width-based now (every page renders at containerInnerWidth
  // × zoom), so "fit to width" is just zoom = 1.
  const handleFitWidth = useCallback(() => {
    setZoom(1);
  }, [setZoom]);

  // Pull every visible annotation for this document up-front. The list
  // is small relative to chunk content and has to be in memory anyway
  // for the per-page filter; one round trip on doc-open is cheaper than
  // a per-page fetch.
  useEffect(() => {
    if (currentDocument) {
      void loadAnnotations(currentDocument.id);
    } else {
      clearAnnotations();
    }
  }, [currentDocument, loadAnnotations, clearAnnotations]);

  // Group annotations by page once so each rendered page reads its own
  // slice in O(1).
  const annotationsByPage = useMemo(() => {
    const map = new Map<number, typeof annotations>();
    for (const annotation of annotations) {
      const list = map.get(annotation.page_number) ?? [];
      list.push(annotation);
      map.set(annotation.page_number, list);
    }
    return map;
  }, [annotations]);

  // Track the scroll container's inner width so each PDFPageJS can be
  // told to render at a uniform width — otherwise PDFs with mixed page
  // dimensions read as a ragged column. Ignore sub-pixel changes so a
  // scrollbar that appears/disappears during scrolling doesn't trigger
  // a full re-render of every page (which would visually reset the
  // user's scroll position).
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) {
      return;
    }
    const measure = () => {
      // 32px ~ the px-4 horizontal padding inside the scroll container
      // plus a small inset so the page never butts against the scrollbar.
      const inner = Math.max(120, el.clientWidth - 32);
      setContainerInnerWidth((current) => {
        if (current !== null && Math.abs(current - inner) < 8) {
          return current;
        }
        return inner;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [currentDocument]);

  // Detect outline once the doc loads so the sidebar tab can show or hide.
  useEffect(() => {
    let cancelled = false;
    pdfHasOutline(pdfProxy).then((value) => {
      if (cancelled) return;
      setHasOutline(value);
      if (value) {
        // Default to outline view when one exists — that's the high-leverage
        // navigation surface for textbooks; users can still flip to thumbnails.
        setSidebarTab("outline");
      } else {
        setSidebarTab("pages");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pdfProxy]);

  // Document-level keyboard shortcuts. Skip when the user is typing into
  // an input/textarea/contentEditable so the search box and chat input
  // keep working normally.
  useEffect(() => {
    if (!currentDocument) {
      return;
    }
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
          return;
        }
      }
      if (event.ctrlKey || event.metaKey) {
        if (event.key === "=" || event.key === "+") {
          event.preventDefault();
          handleZoomIn();
          return;
        }
        if (event.key === "-") {
          event.preventDefault();
          handleZoomOut();
          return;
        }
        if (event.key === "0") {
          event.preventDefault();
          handleFitWidth();
          return;
        }
      }
      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        void nextPage();
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        void previousPage();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [currentDocument, handleZoomIn, handleZoomOut, handleFitWidth, nextPage, previousPage]);

  // When the active search match moves to a different page, pull that
  // page into the rendered window so the text-layer highlighting work
  // inside PDFPageJS can actually find a node to mark.
  useEffect(() => {
    if (!searchMatch || !currentDocument) {
      return;
    }
    if (searchMatch.pageNumber === currentPage) {
      return;
    }
    void loadPage(currentDocument, searchMatch.pageNumber, []);
  }, [searchMatch, currentDocument, currentPage, loadPage]);

  // Once PDFPageJS has tagged the active span, pull it into view. The
  // text layer scrolls inside the same scrollContainerRef as the rest
  // of the viewer, so we centre on it instead of using scrollIntoView
  // (which would also scroll the outer page).
  const handleActiveSearchHit = useCallback((element: HTMLElement) => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const delta = elementRect.top - containerRect.top - container.clientHeight / 2;
    container.scrollTo({
      top: container.scrollTop + delta,
      behavior: "smooth",
    });
  }, []);

  const loadedPages = useMemo(() => {
    if (!currentDocument || visibleRange.end < visibleRange.start) {
      return [];
    }

    // Cap at the document's known page count so the prefetch window
    // walking past the end of a 365-page doc doesn't leave the viewer
    // rendering ghost "Loading page 366…" placeholders that never resolve.
    const upperBound = currentDocument.page_count
      ? Math.min(visibleRange.end, currentDocument.page_count)
      : visibleRange.end;

    const pages: Array<{ pageNumber: number; pageData: PageData | null }> = [];
    for (let pageNumber = visibleRange.start; pageNumber <= upperBound; pageNumber += 1) {
      const key = pageKey(currentDocument.id, pageNumber);
      pages.push({
        pageNumber,
        pageData: pageCache[key] ?? getCachedPageData(currentDocument.id, pageNumber) ?? null,
      });
    }
    return pages;
  }, [currentDocument, pageCache, visibleRange]);

  useEffect(() => {
    if (!currentDocument) {
      return;
    }

    const highlightKey = highlights
      .map((citation) => citation.id)
      .sort()
      .join(",");
    // openClickNonce makes each chip click produce a distinct key even when
    // the user clicks the same citation twice — without it, the dedupe
    // below short-circuits and the page never re-scrolls into view.
    const targetKey = `${currentDocument.id}:${currentPage}:${highlightKey}:${highlightReadyNonce}:${openClickNonce}`;
    if (lastScrollTargetRef.current === targetKey) {
      return;
    }

    const target = pageRefs.current[currentPage];
    if (!target) {
      return;
    }

    let attempts = 0;
    const maxAttempts = 24;

    const scrollToEvidence = () => {
      const pageElement = pageRefs.current[currentPage];
      if (!pageElement) {
        return;
      }

      const highlightAnchor = pageElement.querySelector<HTMLElement>('[data-highlight-anchor="true"]');
      if (highlightAnchor && scrollContainerRef.current) {
        const containerRect = scrollContainerRef.current.getBoundingClientRect();
        const anchorRect = highlightAnchor.getBoundingClientRect();
        const delta = anchorRect.top - containerRect.top - scrollContainerRef.current.clientHeight / 2;
        scrollContainerRef.current.scrollTo({
          top: scrollContainerRef.current.scrollTop + delta,
          behavior: "smooth",
        });
        lastScrollTargetRef.current = targetKey;
        return;
      }

      if (attempts === 0) {
        pageElement.scrollIntoView({ block: "center", behavior: "smooth" });
      }

      attempts += 1;
      if (attempts < maxAttempts) {
        window.setTimeout(scrollToEvidence, 80);
      } else {
        lastScrollTargetRef.current = targetKey;
      }
    };

    scrollToEvidence();
  }, [currentDocument, currentPage, highlightReadyNonce, highlights, loadedPages, openClickNonce]);

  if (currentWebCitation) {
    return (
      <div className="flex h-full flex-col overflow-hidden border border-black/[0.08] bg-white">
        <div className="border-b border-line px-4 py-4">
          <div className="flex items-start gap-3">
            <span className="border border-black/[0.08] bg-black/[0.03] p-2 text-black">
              <Globe2 className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate font-medium text-ink">
                {currentWebCitation.title || "Web source"}
              </p>
              <p className="mt-1 text-xs text-muted">Web evidence</p>
            </div>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin">
          <div className="border border-black/[0.08] bg-[#f7f7f6] p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted">
                Source
              </p>
              {currentWebCitation.url ? (
                <a
                  href={currentWebCitation.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 border border-black/[0.08] bg-white px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-black hover:text-white"
                >
                  Open page
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              ) : null}
            </div>
            {currentWebCitation.url ? (
              <p className="mt-3 break-all text-sm leading-6 text-muted">{currentWebCitation.url}</p>
            ) : null}
            {currentWebCitation.snippet ? (
              <div className="mt-5 border border-black/[0.08] bg-white px-4 py-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">
                  Referenced text
                </p>
                <p className="mt-3 text-sm leading-7 text-ink">{currentWebCitation.snippet}</p>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  if (!currentDocument) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 border border-black/[0.08] bg-black/[0.02] p-6 text-center">
        <FileSearch2 className="h-6 w-6 text-muted/70" />
        <div>
          <p className="font-display text-[1.75rem] font-semibold tracking-[-0.04em] text-ink">No source open</p>
          <p className="mt-2 max-w-sm text-sm leading-7 text-muted">
            Open a citation to inspect the original page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden border border-black/[0.08] bg-white">
      <PDFToolbar
        document={currentDocument}
        zoom={zoom}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onFitWidth={handleFitWidth}
        search={search}
      />
      <div className="flex items-center justify-between border-b border-line px-4 py-2 text-[11px] text-muted">
        <span>
          {hasEvidenceHighlights && !hasRenderableHighlight
            ? "Cited page (no precise highlight available) — "
            : hasEvidenceHighlights
              ? "Evidence on "
              : ""}
          page {pageData?.printed_page_label ?? currentPage}
        </span>
        {hasEvidenceHighlights ? (
          <button type="button" className="text-accent" onClick={clearHighlights}>
            Clear
          </button>
        ) : (
          <span>{currentDocument.page_count ? `${currentDocument.page_count} pages` : ""}</span>
        )}
      </div>
      <div className="min-h-0 flex flex-1 overflow-hidden bg-[#d9d9d7]">
        <aside className="hidden w-[200px] shrink-0 flex-col border-r border-black/[0.08] bg-[#ececeb] md:flex">
          {hasOutline ? (
            <div className="flex shrink-0 border-b border-black/[0.08]">
              <button
                type="button"
                onClick={() => setSidebarTab("pages")}
                className={`flex-1 px-2 py-2 text-[10px] font-medium uppercase tracking-[0.18em] transition ${
                  sidebarTab === "pages" ? "bg-white text-ink" : "text-muted hover:text-ink"
                }`}
              >
                Pages
              </button>
              <button
                type="button"
                onClick={() => setSidebarTab("outline")}
                className={`flex-1 px-2 py-2 text-[10px] font-medium uppercase tracking-[0.18em] transition ${
                  sidebarTab === "outline" ? "bg-white text-ink" : "text-muted hover:text-ink"
                }`}
              >
                Outline
              </button>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            {sidebarTab === "outline" && hasOutline ? (
              <PDFOutline
                pdf={pdfProxy}
                currentPage={currentPage}
                onSelectPage={(pageNumber) => {
                  void handleOpenPage(pageNumber);
                }}
              />
            ) : (
              <div className="px-2 py-3">
                <div className="space-y-3">
                  {Array.from({ length: currentDocument.page_count ?? currentPage }, (_, index) => {
                    const pageNumber = index + 1;
                    return (
                      <PageThumbnail
                        key={`${currentDocument.id}-thumb-${pageNumber}`}
                        document={currentDocument}
                        pageNumber={pageNumber}
                        active={pageNumber === currentPage}
                        cachedPage={pageCache[pageKey(currentDocument.id, pageNumber)] ?? null}
                        onVisible={handleThumbnailVisible}
                        onOpen={(nextPage) => {
                          void handleOpenPage(nextPage);
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </aside>
        <div
          ref={scrollContainerRef}
          data-pdf-scroll="true"
          // overflow-y-scroll (not auto) + scrollbar-gutter:stable keeps
          // the scrollbar lane reserved even when content briefly fits.
          // Without it the gutter blinks in/out during page loads and
          // every page re-renders at a slightly different width.
          style={{ scrollbarGutter: "stable" }}
          className="min-h-0 flex-1 overflow-y-scroll overflow-x-hidden bg-[#9b9b9b] px-4 py-5 scrollbar-thin"
          onScroll={(event) => {
            if (!currentDocument.page_count) {
              return;
            }
            const target = event.currentTarget;
            const nearTop = target.scrollTop <= PAGE_EDGE_THRESHOLD;
            const nearBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - PAGE_EDGE_THRESHOLD;

            if (nearTop) {
              loadPreviousPages();
            }

            if (nearBottom) {
              loadNextPages();
            }
          }}
        >
          {loading && !loadedPages.length ? (
            <div className="flex h-full items-center justify-center">
              <LoadingSpinner className="h-6 w-6 text-white" />
            </div>
          ) : (
            <PDFDocument
              file={pdfFile}
              onLoadStart={() => setLoadProgress(null)}
              onLoadProgress={({ loaded, total }: { loaded: number; total: number }) => {
                setLoadProgress({ loaded, total });
              }}
              onLoadSuccess={(doc: PDFDocumentProxy) => setPdfProxy(doc)}
              loading={<PDFLoadIndicator progress={loadProgress} />}
              error={
                <div className="mx-auto max-w-[640px] mt-10 border border-black/[0.08] bg-white px-6 py-6 text-center text-sm text-warn">
                  Could not load this PDF. Try refreshing or contact support if it
                  persists.
                </div>
              }
            >
              <div className="space-y-6">
                {visibleRange.start > 1 ? (
                  <div className="flex justify-center">
                    <button
                      type="button"
                      onClick={loadPreviousPages}
                      className="border border-white/40 bg-white/90 px-4 py-2 text-[11px] font-medium uppercase tracking-[0.16em] text-ink transition hover:bg-white"
                    >
                      Load earlier pages
                    </button>
                  </div>
                ) : null}
                {loadedPages.map(({ pageNumber }) => (
                  <div
                    key={`${currentDocument.id}-${pageNumber}`}
                    ref={(element) => {
                      pageRefs.current[pageNumber] = element;
                    }}
                    className="space-y-0"
                  >
                    <PDFPageJS
                      pageNumber={pageNumber}
                      zoom={zoom}
                      baseWidth={containerInnerWidth}
                      highlights={pageNumber === currentPage ? highlights : []}
                      annotations={annotationsByPage.get(pageNumber) ?? []}
                      documentId={currentDocument.id}
                      currentUserId={currentUserId}
                      resolvePageLabel={resolvePageLabel}
                      searchQuery={searchQuery}
                      activeSearchIndexInPage={
                        activeMatchIndexByPage &&
                        activeMatchIndexByPage.pageNumber === pageNumber
                          ? activeMatchIndexByPage.indexInPage
                          : null
                      }
                      onHighlightReady={
                        pageNumber === currentPage
                          ? handleCurrentHighlightReady
                          : undefined
                      }
                      onActiveSearchHitMounted={
                        activeMatchIndexByPage &&
                        activeMatchIndexByPage.pageNumber === pageNumber
                          ? handleActiveSearchHit
                          : undefined
                      }
                    />
                  </div>
                ))}
              </div>
            </PDFDocument>
          )}
        </div>
      </div>
    </div>
  );
}
