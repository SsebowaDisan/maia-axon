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
import { LearnDialog } from "@/components/learn/LearnDialog";
import { SectionMindmapDialog } from "@/components/learn/SectionMindmapDialog";
import { useChatStore } from "@/stores/chatStore";
import { LoadingSpinner } from "@/components/shared/LoadingSpinner";
import { api, getStoredToken } from "@/lib/api";
import type { Document, PageData } from "@/lib/types";
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

function pageKey(documentId: string, pageNumber: number) {
  return `${documentId}:${pageNumber}`;
}

// Initial render window kept tight so first-paint only renders one
// canvas. The scroll-driven effect expands as the user moves; pre-
// rendering many pages in parallel starves the PDF.js worker and
// makes first paint feel slow.
function buildInitialWindow(currentPage: number, pageCount: number | null) {
  const total = Math.max(pageCount ?? currentPage, 1);
  const start = Math.max(1, currentPage - 1);
  const end = Math.min(total, currentPage + 1);
  return { start, end };
}

function buildCitationWindow(currentPage: number, pageCount: number | null) {
  const total = Math.max(pageCount ?? currentPage, 1);
  const page = Math.min(Math.max(currentPage, 1), total);
  return { start: page, end: page };
}

// Editable current-page indicator. Type a number, press Enter to
// jump — same model as Google Drive / Acrobat. Stays controlled-from-
// outside when not focused so scrolling updates the displayed page;
// stops syncing while the user is mid-edit so we don't yank their
// typed value out from under them.
function PageJumpControl({
  currentPage,
  pageCount,
  onJump,
}: {
  currentPage: number;
  pageCount: number | null;
  onJump: (pageNumber: number) => void | Promise<void>;
}) {
  const [value, setValue] = useState(String(currentPage));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) {
      setValue(String(currentPage));
    }
  }, [currentPage, editing]);

  const commit = () => {
    const n = parseInt(value, 10);
    if (!Number.isNaN(n) && n >= 1 && (!pageCount || n <= pageCount)) {
      if (n !== currentPage) {
        void onJump(n);
      }
    } else {
      setValue(String(currentPage));
    }
    setEditing(false);
  };

  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] tabular-nums text-muted">
      <input
        type="text"
        inputMode="numeric"
        value={value}
        onFocus={(event) => {
          setEditing(true);
          event.currentTarget.select();
        }}
        onChange={(event) => setValue(event.target.value.replace(/[^0-9]/g, ""))}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
            (event.currentTarget as HTMLInputElement).blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setValue(String(currentPage));
            setEditing(false);
            (event.currentTarget as HTMLInputElement).blur();
          }
        }}
        onBlur={commit}
        aria-label="Page number"
        className="w-12 border border-black/[0.10] bg-white px-1.5 py-0.5 text-center font-medium text-ink outline-none transition focus:border-black"
      />
      <span>of {pageCount ?? "—"}</span>
    </span>
  );
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

  // When this thumbnail becomes active (because currentPage changed),
  // pull it into the rail's viewport. `block: "nearest"` keeps the
  // scroll quiet — it only runs when the active thumb is actually
  // off-screen.
  useEffect(() => {
    if (active && containerRef.current) {
      containerRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [active]);

  return (
    <button
      ref={containerRef}
      type="button"
      onClick={() => onOpen(pageNumber)}
      className={`group flex w-full flex-col items-center gap-2 border-2 px-2 py-2 text-left transition ${
        active
          ? "border-white bg-white shadow-[0_4px_14px_rgba(0,0,0,0.45)]"
          : "border-transparent hover:bg-white/[0.06]"
      }`}
    >
      <div
        className={`relative aspect-[0.72] w-full overflow-hidden border bg-white ${
          active ? "border-black/30" : "border-black/[0.10]"
        }`}
      >
        {cachedPage ? (
          <img
            src={cachedPage.image_url}
            alt={`Page ${pageNumber}`}
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
      {/*
        Internal page number, NOT the OCR-derived printed label.
        printed_page_label is a heuristic that picks up stray numbers
        from chapter headings / figure refs (e.g. it labels internal
        page 28 as "96" because that number appeared somewhere in the
        OCR text) — using it here makes the rail look randomly
        numbered. The internal number matches the `[27] of 334` jump
        input above and the page-jump store.
      */}
      <span
        className={`min-w-[38px] border px-2 py-1 text-center text-[10px] font-semibold tracking-[0.14em] tabular-nums ${
          active
            ? "border-black bg-black text-white"
            : "border-white/10 bg-[#2a2a2a] text-white/70"
        }`}
      >
        {pageNumber}
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
  // Once a page has been rendered by PDF.js, remember its rendered
  // height so the slot keeps that height after PDFPageJS unmounts.
  // Without this, slots shrink back to the estimate when they leave
  // the render window, scroll height drops, and the browser snaps
  // the viewport backward — the user perceives this as the page
  // "jumping back to the top".
  const [pageHeights, setPageHeights] = useState<Map<number, number>>(new Map());
  useEffect(() => {
    // Reset when the document changes — old heights don't apply.
    setPageHeights(new Map());
  }, [currentDocument?.id]);
  const handlePageRendered = useCallback(
    (info: { pageNumber: number; width: number; height: number }) => {
      setPageHeights((current) => {
        const existing = current.get(info.pageNumber);
        if (existing !== undefined && Math.abs(existing - info.height) < 1) {
          return current;
        }
        const next = new Map(current);
        next.set(info.pageNumber, info.height);
        return next;
      });
    },
    [],
  );
  // Track the file URL the current pdfProxy belongs to. When pdfFile
  // changes (user switches documents) we MUST drop the old proxy
  // before mounting any <Page> children — react-pdf has already torn
  // down its worker and any getPage() call against the old reference
  // explodes with "Cannot read properties of null (reading
  // 'sendWithPromise')".
  const pdfProxyFileRef = useRef<string | null>(null);
  // Native PDF page dimensions of the first page — used as the
  // estimated height for every placeholder slot, so the scroll
  // container has the correct total height from frame 1 (Drive /
  // Chrome PDF viewer trick). Books with uniform pages get the exact
  // right scroll length; books with mixed-size pages get a stable
  // approximation that slightly adjusts as real pages render.
  const [firstPageDims, setFirstPageDims] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    if (!pdfProxy) {
      setFirstPageDims(null);
      return;
    }
    let cancelled = false;
    pdfProxy
      .getPage(1)
      .then((page) => {
        if (cancelled) return;
        const v = page.getViewport({ scale: 1 });
        setFirstPageDims({ width: v.width, height: v.height });
      })
      .catch(() => {
        if (!cancelled) setFirstPageDims(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pdfProxy]);
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
  const [learnOpen, setLearnOpen] = useState(false);
  const [mindmapOpen, setMindmapOpen] = useState(false);
  const pendingLearnDocId = useChatStore((state) => state.pendingLearnDiagnosticDocumentId);
  const clearPendingLearn = useChatStore((state) => state.setPendingLearnDiagnosticDocumentId);
  // When the chat handler signals a learn-mode message hit a doc
  // without an active path, the chatStore stores the doc id here.
  // Open the LearnDialog for that doc and clear the flag.
  useEffect(() => {
    if (pendingLearnDocId && currentDocument?.id === pendingLearnDocId) {
      setLearnOpen(true);
      clearPendingLearn(null);
    }
  }, [pendingLearnDocId, currentDocument?.id, clearPendingLearn]);

  // Library-card → "Open mindmap" shortcut: the card sets
  // pendingAutoOpen on pdfViewerStore right before triggering the
  // PDF open. The viewer reads + clears it once the doc has mounted.
  const pendingAutoOpen = usePDFViewerStore((state) => state.pendingAutoOpen);
  const setPendingAutoOpen = usePDFViewerStore((state) => state.setPendingAutoOpen);
  useEffect(() => {
    if (pendingAutoOpen === "mindmap" && currentDocument) {
      setMindmapOpen(true);
      setPendingAutoOpen(null);
    }
  }, [pendingAutoOpen, currentDocument, setPendingAutoOpen]);
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
  // rAF coalescing token for the scroll edge-load handler. While a
  // frame is pending we drop further scroll events; the queued frame
  // reads the freshest scroll position from the live DOM.
  const scrollRafRef = useRef<number | null>(null);

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
  // Stabilise on document.id only. The store re-creates the
  // currentDocument object on every loadPage call, so memoising on
  // the whole reference made react-pdf see a new `file` prop on every
  // page change and re-download the PDF.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDocument?.id]);

  // Drop the old proxy the moment the file URL changes. react-pdf has
  // already torn down the worker by this point; if a <Page> renders
  // before our new onLoadSuccess fires, getPage() will dereference a
  // null messageHandler and crash the whole panel.
  useEffect(() => {
    if (pdfProxyFileRef.current !== (pdfFile?.url ?? null)) {
      setPdfProxy(null);
    }
  }, [pdfFile]);

  const warmThumbnailPage = useCallback(
    async (documentId: string, pageNumber: number) => {
      if (!currentDocument || currentDocument.id !== documentId) {
        return;
      }
      await prefetchPages(currentDocument, [pageNumber]);
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

  // (Removed: prefetchPages on visibleRange change.) The main viewer
  // renders pages from the downloaded PDF via PDF.js — it does not
  // need /pages/{n} metadata or /pages/{n}/image bytes from the
  // backend. Those used to fire N+N parallel requests on every range
  // update, competing with the PDF download itself. Thumbnails still
  // warm via the per-thumb IntersectionObserver below.

  // Targeted preview prefetch on navigation. currentPage ± 1 so the
  // jumped-to page paints its JPEG immediately while PDF.js works on
  // the canvas (Drive trick).
  useEffect(() => {
    if (!currentDocument || !currentPage) return;
    const candidates = [currentPage - 1, currentPage, currentPage + 1].filter(
      (p) =>
        p >= 1 && (!currentDocument.page_count || p <= currentDocument.page_count),
    );
    void prefetchPages(currentDocument, candidates);
  }, [currentDocument, currentPage, prefetchPages]);

  // Wider preview prefetch driven by scroll position. Once the PDF
  // itself has loaded (pdfProxy set), we eagerly fetch JPEG previews
  // for the visibleRange plus a generous buffer. These become static
  // placeholders shown in any slot whose PDFPageJS has unmounted —
  // so as the user scrolls past a page, the canvas goes away but
  // the JPEG stays, and the user never sees a blank slot. Bandwidth
  // is bounded by the buffer width, not the document length.
  useEffect(() => {
    if (!currentDocument || !pdfProxy) return;
    const pageCount = currentDocument.page_count;
    if (!pageCount) return;
    const PREVIEW_BUFFER = 20;
    const start = Math.max(1, visibleRange.start - PREVIEW_BUFFER);
    const end = Math.min(pageCount, visibleRange.end + PREVIEW_BUFFER);
    const pages: number[] = [];
    for (let p = start; p <= end; p += 1) pages.push(p);
    void prefetchPages(currentDocument, pages);
  }, [currentDocument, pdfProxy, visibleRange, prefetchPages]);

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

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, []);

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

  // Estimated rendered height of every page slot. Used for the
  // placeholder divs surrounding the visibleRange so the scroll
  // container has the correct total height even before pdf.js has
  // rendered each page. Falls back to a sane default until we know
  // the first page's aspect ratio.
  const estimatedPageHeight = useMemo(() => {
    const width = containerInnerWidth && containerInnerWidth > 0 ? containerInnerWidth : 600;
    if (!firstPageDims) {
      // ~A4 portrait at the given width.
      return width * 1.41 * zoom;
    }
    const aspect = firstPageDims.height / firstPageDims.width;
    return Math.max(80, width * aspect * zoom);
  }, [firstPageDims, containerInnerWidth, zoom]);

  // Scroll-driven visibleRange. Every page slot exists in the DOM with
  // an estimated height so the scrollbar has the full document length
  // from frame 1 (Drive / Chrome PDF viewer trick). This effect tracks
  // the viewport, computes which pages are near it, and updates
  // visibleRange so only those pages mount a real <PDFPageJS>. Off-
  // window slots stay as empty placeholders with content-visibility:
  // auto, which lets the browser skip layout/paint for them entirely.
  useEffect(() => {
    const container = scrollContainerRef.current;
    const pageCount = currentDocument?.page_count;
    if (!container || !pageCount) return;

    // Render window. Slightly wider than the bare viewport so adjacent
    // pages stay mounted (canvas + selectable text) as the user scrolls
    // — otherwise the canvas flickers out the moment a page slides off
    // the viewport edge. The JPEG preview keeps further-out pages
    // visible even when their PDFPageJS has unmounted.
    const RENDER_AHEAD = 3;
    const RENDER_BEHIND = 2;

    const updateRange = () => {
      scrollRafRef.current = null;
      const scrollTop = container.scrollTop;
      const clientHeight = container.clientHeight;
      const viewportCenter = scrollTop + clientHeight / 2;
      // Approximate page using estimatedPageHeight. For uniform-page
      // PDFs (the common case) this is exact; for mixed-size PDFs the
      // generous RENDER_AHEAD/BEHIND buffer covers the drift.
      const approxPage = Math.max(
        1,
        Math.min(pageCount, Math.floor(viewportCenter / estimatedPageHeight) + 1),
      );
      const start = Math.max(1, approxPage - RENDER_BEHIND);
      const end = Math.min(pageCount, approxPage + RENDER_AHEAD);
      setVisibleRange((cur) => {
        if (cur.start === start && cur.end === end) return cur;
        return { start, end };
      });
    };

    const onScroll = () => {
      if (scrollRafRef.current !== null) return;
      scrollRafRef.current = window.requestAnimationFrame(updateRange);
    };

    updateRange();
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
    };
  }, [currentDocument?.page_count, estimatedPageHeight]);

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

    // Distance-aware scroll behaviour. Smooth-scrolling a jump of
    // hundreds of pages takes Chrome tens of seconds to animate; for
    // anything beyond ~1.5 viewports we hard-jump like the Chrome /
    // Drive native viewers do for TOC navigation.
    const container = scrollContainerRef.current;
    const pickBehavior = (): ScrollBehavior => {
      if (!container) return "auto";
      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const distance = Math.abs(
        targetRect.top - containerRect.top - container.clientHeight / 2,
      );
      return distance > container.clientHeight * 1.5 ? "auto" : "smooth";
    };

    const hasHighlights = highlights.length > 0;
    // No citation to focus → scroll to the page once and mark this
    // target done. Without this short-circuit, scrollToEvidence kept
    // polling for a highlight anchor (24 retries × 80ms) and the
    // dedupe key wasn't set until the polling ran out — so any later
    // scroll (e.g. the user scrolling to the bottom of page 1) re-
    // entered the effect, found a stale ref equal-but-not-set, and
    // snapped them back to currentPage.
    if (!hasHighlights) {
      target.scrollIntoView({ block: "center", behavior: pickBehavior() });
      lastScrollTargetRef.current = targetKey;
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
          behavior:
            Math.abs(delta) > scrollContainerRef.current.clientHeight * 1.5
              ? "auto"
              : "smooth",
        });
        lastScrollTargetRef.current = targetKey;
        return;
      }

      if (attempts === 0) {
        pageElement.scrollIntoView({ block: "center", behavior: pickBehavior() });
      }

      attempts += 1;
      if (attempts < maxAttempts) {
        window.setTimeout(scrollToEvidence, 80);
      } else {
        lastScrollTargetRef.current = targetKey;
      }
    };

    scrollToEvidence();
    // visibleRange intentionally NOT a dep: with virtual scrolling
    // every page slot exists from frame 1, so we never need to
    // re-attempt this effect when more pages "arrive" in the window.
    // Re-running on scroll caused exactly the snap-back-to-top bug
    // this effect is designed to prevent.
  }, [currentDocument, currentPage, highlightReadyNonce, highlights, openClickNonce]);

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
        onOpenMindmap={() => setMindmapOpen(true)}
        search={search}
      />
      <LearnDialog
        documentId={currentDocument.id}
        documentName={currentDocument.filename}
        open={learnOpen}
        onClose={() => setLearnOpen(false)}
        onJumpToPage={(page) => {
          void handleOpenPage(page);
        }}
      />
      <SectionMindmapDialog
        documentId={currentDocument.id}
        documentName={currentDocument.filename}
        open={mindmapOpen}
        onClose={() => setMindmapOpen(false)}
        onJumpToPage={(page) => {
          void handleOpenPage(page);
        }}
        onLearnSection={() => {
          setLearnOpen(true);
        }}
      />
      <div className="flex items-center justify-between border-b border-line px-4 py-2 text-[11px] text-muted">
        <div className="flex items-center gap-2">
          {hasEvidenceHighlights ? (
            <span className="uppercase tracking-[0.16em] text-muted">
              {hasRenderableHighlight ? "Evidence on" : "Cited page —"}
            </span>
          ) : null}
          <PageJumpControl
            currentPage={currentPage}
            pageCount={currentDocument.page_count}
            onJump={handleOpenPage}
          />
        </div>
        {hasEvidenceHighlights ? (
          <button type="button" className="text-accent" onClick={clearHighlights}>
            Clear
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex flex-1 overflow-hidden bg-[#4a4a4a]">
        <aside className="hidden w-[200px] shrink-0 flex-col border-r border-black/40 bg-[#3a3a3a] md:flex">
          {hasOutline ? (
            <div className="flex shrink-0 border-b border-black/[0.08]">
              <button
                type="button"
                onClick={() => setSidebarTab("pages")}
                className={`flex-1 px-2 py-2 text-[10px] font-medium uppercase tracking-[0.18em] transition ${
                  sidebarTab === "pages" ? "bg-[#2a2a2a] text-white" : "text-white/55 hover:text-white"
                }`}
              >
                Pages
              </button>
              <button
                type="button"
                onClick={() => setSidebarTab("outline")}
                className={`flex-1 px-2 py-2 text-[10px] font-medium uppercase tracking-[0.18em] transition ${
                  sidebarTab === "outline" ? "bg-[#2a2a2a] text-white" : "text-white/55 hover:text-white"
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
          className="min-h-0 flex-1 overflow-y-scroll overflow-x-hidden bg-[#525252] px-4 py-5 scrollbar-thin"
        >
          {loading && visibleRange.end < visibleRange.start ? (
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
              onLoadSuccess={(doc: PDFDocumentProxy) => {
                pdfProxyFileRef.current = pdfFile?.url ?? null;
                setPdfProxy(doc);
              }}
              loading={<PDFLoadIndicator progress={loadProgress} />}
              error={
                <div className="mx-auto max-w-[640px] mt-10 border border-black/[0.08] bg-white px-6 py-6 text-center text-sm text-warn">
                  Could not load this PDF. Try refreshing or contact support if it
                  persists.
                </div>
              }
            >
              <div className="space-y-6">
                {/*
                  Only mount Page children once OUR pdfProxy state is
                  set AND it's the proxy for the *current* file URL.
                  The file-URL check matters during the render where
                  pdfFile has just changed but our reset useEffect
                  hasn't run yet — without it, react-pdf's Document
                  has already torn down the old proxy internally and
                  any <Page> mount would explode with "Cannot read
                  properties of null (reading 'sendWithPromise')".
                */}
                {pdfProxy &&
                  pdfProxyFileRef.current === (pdfFile?.url ?? null) &&
                  Array.from(
                  { length: currentDocument.page_count ?? Math.max(0, visibleRange.end - visibleRange.start + 1) },
                  (_, idx) => {
                    const pageNumber = idx + 1;
                    const inWindow =
                      pageNumber >= visibleRange.start && pageNumber <= visibleRange.end;
                    // Prefer the *actually rendered* height we've
                    // already seen for this page; fall back to the
                    // viewport-based estimate for not-yet-rendered
                    // pages. Once a page has rendered, its slot
                    // height is locked at that value so leaving the
                    // render window never shrinks scrollHeight.
                    const knownHeight = pageHeights.get(pageNumber);
                    const slotHeightPx = Math.max(
                      80,
                      Math.round(knownHeight ?? estimatedPageHeight),
                    );
                    // Slot width tracks the rendered page width so an
                    // empty slot looks like a blank page (Drive does
                    // this) instead of a gray strip spanning the
                    // viewer.
                    const slotWidthPx =
                      containerInnerWidth && containerInnerWidth > 0
                        ? Math.round(containerInnerWidth * zoom)
                        : null;
                    // Pull the cached preview JPEG for ANY slot that
                    // has one, in-window or out. In-window slots pass
                    // it to PDFPageJS for the canvas-fade-in; out-of-
                    // window slots paint it directly as a static
                    // placeholder so the user never sees a blank
                    // sheet of paper for pages they've already
                    // scrolled past.
                    const cachedImage =
                      pageCache[pageKey(currentDocument.id, pageNumber)]?.image_url ?? null;
                    return (
                      <div
                        key={`${currentDocument.id}-${pageNumber}`}
                        ref={(element) => {
                          pageRefs.current[pageNumber] = element;
                        }}
                        data-page-number={pageNumber}
                        className="relative mx-auto bg-white shadow-[0_4px_18px_rgba(15,23,42,0.06)]"
                        // bg-white + page-shaped width + shadow makes
                        // every slot read as a blank sheet of paper
                        // while PDF.js is busy rendering — no more
                        // grey scroll-container colour bleeding
                        // through. content-visibility:auto still lets
                        // the browser skip layout/paint for distant
                        // slots; contain-intrinsic-size keeps their
                        // scroll height correct. minHeight gives every
                        // slot a stable floor so layout never collapses
                        // while a canvas is mid-render.
                        style={{
                          contentVisibility: "auto",
                          containIntrinsicSize: `auto ${slotHeightPx}px`,
                          minHeight: `${slotHeightPx}px`,
                          width: slotWidthPx ?? undefined,
                          maxWidth: "100%",
                        }}
                      >
                        {/* Static preview JPEG drawn at the slot
                            level for *every* slot we have one for —
                            in-window AND out-of-window. PDFPageJS'
                            canvas, when mounted, overlays this
                            image (canvas is opaque). When PDFPageJS
                            unmounts as the user scrolls past, the
                            image stays so the page never goes blank.
                            One <img> per slot — no flicker, no
                            mount/unmount churn for the preview. */}
                        {cachedImage ? (
                          <img
                            src={cachedImage}
                            alt=""
                            aria-hidden="true"
                            draggable={false}
                            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                          />
                        ) : null}
                        {inWindow ? (
                          <PDFPageJS
                            pageNumber={pageNumber}
                            zoom={zoom}
                            baseWidth={containerInnerWidth}
                            previewImageUrl={cachedImage}
                            onRenderSuccess={handlePageRendered}
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
                        ) : null}
                      </div>
                    );
                  },
                )}
              </div>
            </PDFDocument>
          )}
        </div>
      </div>
    </div>
  );
}
