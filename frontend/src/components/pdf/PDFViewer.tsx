"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, FileSearch2, Globe2 } from "lucide-react";

import { PageRenderer } from "@/components/pdf/PageRenderer";
import { PDFToolbar } from "@/components/pdf/PDFToolbar";
import { LoadingSpinner } from "@/components/shared/LoadingSpinner";
import { api } from "@/lib/api";
import type { PageData } from "@/lib/types";
import { usePDFViewerStore } from "@/stores/pdfViewerStore";

function pageKey(documentId: string, pageNumber: number) {
  return `${documentId}:${pageNumber}`;
}

export function PDFViewer() {
  const currentDocument = usePDFViewerStore((state) => state.currentDocument);
  const currentWebCitation = usePDFViewerStore((state) => state.currentWebCitation);
  const currentPage = usePDFViewerStore((state) => state.currentPage);
  const pageData = usePDFViewerStore((state) => state.pageData);
  const zoom = usePDFViewerStore((state) => state.zoom);
  const highlights = usePDFViewerStore((state) => state.highlightCitations);
  const loading = usePDFViewerStore((state) => state.loading);
  const clearHighlights = usePDFViewerStore((state) => state.clearHighlights);
  const [pageCache, setPageCache] = useState<Record<string, PageData>>({});
  const [visiblePages, setVisiblePages] = useState(0);
  const activeDocumentIdRef = useRef<string | null>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const lastScrollTargetRef = useRef<string | null>(null);

  const loadPages = useCallback(
    async (documentId: string, targetPages: number) => {
      const missingPages: number[] = [];

      for (let pageNumber = 1; pageNumber <= targetPages; pageNumber += 1) {
        if (!pageCache[pageKey(documentId, pageNumber)]) {
          missingPages.push(pageNumber);
        }
      }

      if (!missingPages.length) {
        return;
      }

      const pageResults = await Promise.all(
        missingPages.map(async (pageNumber) => ({
          pageNumber,
          pageData: await api.getPage(documentId, pageNumber),
        })),
      );

      setPageCache((current) => {
        const next = { ...current };
        for (const { pageNumber, pageData: nextPageData } of pageResults) {
          next[pageKey(documentId, pageNumber)] = nextPageData;
        }
        return next;
      });
    },
    [pageCache],
  );

  useEffect(() => {
    if (!currentDocument) {
      setPageCache({});
      setVisiblePages(0);
      activeDocumentIdRef.current = null;
      lastScrollTargetRef.current = null;
      return;
    }

    if (activeDocumentIdRef.current !== currentDocument.id) {
      activeDocumentIdRef.current = currentDocument.id;
      setPageCache(
        pageData && pageData.document_id === currentDocument.id
          ? { [pageKey(currentDocument.id, pageData.page_number)]: pageData }
          : {},
      );
    } else if (pageData && pageData.document_id === currentDocument.id) {
      setPageCache((current) => ({
        ...current,
        [pageKey(currentDocument.id, pageData.page_number)]: pageData,
      }));
    }

    setVisiblePages(
      currentDocument.page_count
        ? Math.min(Math.max(currentPage, 6), currentDocument.page_count)
        : Math.max(currentPage, 1),
    );
    lastScrollTargetRef.current = null;
  }, [currentDocument, currentPage, pageData]);

  useEffect(() => {
    if (!currentDocument || visiblePages === 0) {
      return;
    }

    void loadPages(currentDocument.id, visiblePages);
  }, [currentDocument, loadPages, visiblePages]);

  const loadedPages = useMemo(() => {
    if (!currentDocument || visiblePages === 0) {
      return [];
    }

    const pages: Array<{ pageNumber: number; pageData: PageData | null }> = [];
    for (let pageNumber = 1; pageNumber <= visiblePages; pageNumber += 1) {
      pages.push({
        pageNumber,
        pageData: pageCache[pageKey(currentDocument.id, pageNumber)] ?? null,
      });
    }
    return pages;
  }, [currentDocument, pageCache, visiblePages]);

  useEffect(() => {
    if (!currentDocument) {
      return;
    }

    const targetKey = `${currentDocument.id}:${currentPage}`;
    if (lastScrollTargetRef.current === targetKey) {
      return;
    }

    const target = pageRefs.current[currentPage];
    if (!target) {
      return;
    }

    target.scrollIntoView({ block: "center", behavior: "smooth" });
    lastScrollTargetRef.current = targetKey;
  }, [currentDocument, currentPage, loadedPages]);

  if (currentWebCitation) {
    return (
      <div className="flex h-full flex-col overflow-hidden rounded-[24px] bg-white">
        <div className="border-b border-line px-4 py-4">
          <div className="flex items-start gap-3">
            <span className="rounded-full border border-black/[0.06] bg-black/[0.03] p-2 text-black">
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
          <div className="rounded-[24px] border border-black/[0.06] bg-black/[0.02] p-5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted">
                Source
              </p>
              {currentWebCitation.url ? (
                <a
                  href={currentWebCitation.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-full border border-black/[0.08] bg-white px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-black hover:text-white"
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
              <div className="mt-5 rounded-[20px] border border-black/[0.05] bg-white px-4 py-4">
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
      <div className="flex h-full flex-col items-center justify-center gap-3 rounded-[24px] bg-black/[0.02] p-6 text-center">
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
    <div className="flex h-full flex-col overflow-hidden rounded-[24px] bg-white">
      <PDFToolbar
        document={currentDocument}
        zoom={zoom}
      />
      <div className="flex items-center justify-between px-4 py-2 text-xs text-muted">
        <span>{highlights.length ? `Evidence highlighted on page ${currentPage}` : "Scroll the document"}</span>
        <button type="button" className="text-accent" onClick={clearHighlights}>
          Clear
        </button>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin"
        onScroll={(event) => {
          if (!currentDocument.page_count) {
            return;
          }
          const target = event.currentTarget;
          const nearBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 320;
          if (nearBottom && visiblePages < currentDocument.page_count) {
            setVisiblePages((current) => Math.min(current + 6, currentDocument.page_count ?? current + 6));
          }
        }}
      >
        {loading && !loadedPages.length ? (
          <div className="flex h-full items-center justify-center rounded-[24px] bg-black/[0.02]">
            <LoadingSpinner className="h-6 w-6" />
          </div>
        ) : (
          <div className="space-y-6">
            {loadedPages.map(({ pageNumber, pageData: nextPageData }) => (
              <div
                key={`${currentDocument.id}-${pageNumber}`}
                ref={(element) => {
                  pageRefs.current[pageNumber] = element;
                }}
                className="space-y-3"
              >
                <div className="flex justify-center">
                  <p className="rounded-full border border-black/[0.06] bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted">
                    Page {pageNumber}
                  </p>
                </div>
                {nextPageData ? (
                  <PageRenderer
                    page={nextPageData}
                    zoom={zoom}
                    highlights={pageNumber === currentPage ? highlights : []}
                    scrollMode="natural"
                  />
                ) : (
                  <div className="rounded-[24px] border border-black/[0.06] bg-black/[0.02] px-6 py-10 text-center text-sm text-muted">
                    Loading page {pageNumber}...
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
