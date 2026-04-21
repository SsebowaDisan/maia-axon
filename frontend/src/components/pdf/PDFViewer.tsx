"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, FileSearch2, Globe2 } from "lucide-react";

import { PageRenderer } from "@/components/pdf/PageRenderer";
import { PDFToolbar } from "@/components/pdf/PDFToolbar";
import { LoadingSpinner } from "@/components/shared/LoadingSpinner";
import { getCachedPageData } from "@/lib/api";
import type { Citation, Document, PageData } from "@/lib/types";
import { usePDFViewerStore } from "@/stores/pdfViewerStore";

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
  const clearHighlights = usePDFViewerStore((state) => state.clearHighlights);
  const loadPage = usePDFViewerStore((state) => state.loadPage);
  const prefetchPages = usePDFViewerStore((state) => state.prefetchPages);
  const [visibleRange, setVisibleRange] = useState({ start: 1, end: 0 });
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const lastScrollTargetRef = useRef<string | null>(null);

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

    setVisibleRange(buildInitialWindow(currentPage, currentDocument.page_count));
    lastScrollTargetRef.current = null;
  }, [currentDocument, currentPage]);

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

  const loadedPages = useMemo(() => {
    if (!currentDocument || visibleRange.end < visibleRange.start) {
      return [];
    }

    const pages: Array<{ pageNumber: number; pageData: PageData | null }> = [];
    for (let pageNumber = visibleRange.start; pageNumber <= visibleRange.end; pageNumber += 1) {
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
    const targetKey = `${currentDocument.id}:${currentPage}:${highlightKey}`;
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
  }, [currentDocument, currentPage, highlights, loadedPages]);

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
      />
      <div className="flex items-center justify-between border-b border-line px-4 py-2 text-[11px] text-muted">
        <span>
          {highlights.length ? "Evidence on " : ""}
          {pageData?.printed_page_label
            ? `page ${pageData.printed_page_label} (PDF ${currentPage})`
            : `page ${currentPage}`}
        </span>
        {highlights.length ? (
          <button type="button" className="text-accent" onClick={clearHighlights}>
            Clear
          </button>
        ) : (
          <span>{currentDocument.page_count ? `${currentDocument.page_count} pages` : ""}</span>
        )}
      </div>
      <div className="min-h-0 flex flex-1 overflow-hidden bg-[#d9d9d7]">
        <aside className="hidden w-[116px] shrink-0 border-r border-black/[0.08] bg-[#ececeb] md:block">
          <div className="h-full overflow-y-auto px-2 py-3 scrollbar-thin">
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
        </aside>
        <div
          ref={scrollContainerRef}
          className="min-h-0 flex-1 overflow-y-auto bg-[#9b9b9b] px-4 py-5 scrollbar-thin"
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
              {loadedPages.map(({ pageNumber, pageData: nextPageData }) => (
                <div
                  key={`${currentDocument.id}-${pageNumber}`}
                  ref={(element) => {
                    pageRefs.current[pageNumber] = element;
                  }}
                  className="space-y-0"
                >
                  {nextPageData ? (
                    <PageRenderer
                      page={nextPageData}
                      zoom={zoom}
                      highlights={pageNumber === currentPage ? highlights : []}
                      scrollMode="natural"
                      onNavigateToExactPage={(nextPage) => {
                        void handleOpenPage(nextPage);
                      }}
                    />
                  ) : (
                    <div className="mx-auto max-w-[940px] border border-black/[0.08] bg-white px-6 py-10 text-center text-sm text-muted">
                      Loading page {pageNumber}...
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
