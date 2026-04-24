"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus, X } from "lucide-react";

import { PageRenderer } from "@/components/pdf/PageRenderer";
import { LoadingSpinner } from "@/components/shared/LoadingSpinner";
import { Button } from "@/components/ui/button";
import { useDialogDismiss } from "@/hooks/useDialogDismiss";
import { getCachedPageData } from "@/lib/api";
import type { Document, PageData } from "@/lib/types";
import { usePDFViewerStore } from "@/stores/pdfViewerStore";

function previewKey(documentId: string, pageNumber: number) {
  return `${documentId}:${pageNumber}`;
}

function PreviewThumbnail({
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
      { rootMargin: "500px 0px" },
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

export function DocumentPreviewDialog({
  document,
  onOpenChange,
}: {
  document: Document | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [visiblePreviewPages, setVisiblePreviewPages] = useState(0);
  const [activePreviewPage, setActivePreviewPage] = useState(1);
  const pageCache = usePDFViewerStore((state) => state.pageCache);
  const prefetchPages = usePDFViewerStore((state) => state.prefetchPages);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const {
    handleOpenChange,
    handlePointerDownOutside,
    handleEscapeKeyDown,
    handleFocusOutside,
    handleInteractOutside,
    requestClose,
  } =
    useDialogDismiss(() => onOpenChange(false));

  const loadPreviewPages = useCallback(
    async (activeDocument: Document, targetVisiblePages: number) => {
      const maxPage = Math.min(targetVisiblePages, activeDocument.page_count ?? targetVisiblePages);
      const missingPages: number[] = [];

      for (let pageNumber = 1; pageNumber <= maxPage; pageNumber += 1) {
        if (
          !pageCache[previewKey(activeDocument.id, pageNumber)] &&
          !getCachedPageData(activeDocument.id, pageNumber)
        ) {
          missingPages.push(pageNumber);
        }
      }

      if (!missingPages.length) {
        return;
      }

      setPreviewLoading(true);
      try {
        await prefetchPages(activeDocument, missingPages);
      } finally {
        setPreviewLoading(false);
      }
    },
    [pageCache, prefetchPages],
  );

  useEffect(() => {
    if (!document) {
      setPreviewLoading(false);
      setPreviewZoom(1);
      setVisiblePreviewPages(0);
      setActivePreviewPage(1);
      return;
    }

    setPreviewZoom(1);
    setVisiblePreviewPages(Math.min(document.page_count ?? 1, 6));
    setActivePreviewPage(1);
  }, [document]);

  useEffect(() => {
    if (!document || visiblePreviewPages === 0) {
      return;
    }

    void loadPreviewPages(document, visiblePreviewPages);
  }, [document, loadPreviewPages, visiblePreviewPages]);

  const loadedPreviewPages = useMemo(() => {
    if (!document || visiblePreviewPages === 0) {
      return [];
    }

    const pages: Array<{ pageNumber: number; pageData: PageData | null }> = [];
    for (let pageNumber = 1; pageNumber <= visiblePreviewPages; pageNumber += 1) {
      pages.push({
        pageNumber,
        pageData: pageCache[previewKey(document.id, pageNumber)] ?? getCachedPageData(document.id, pageNumber) ?? null,
      });
    }
    return pages;
  }, [document, pageCache, visiblePreviewPages]);

  const warmThumbnailPage = useCallback(
    async (activeDocument: Document, pageNumber: number) => {
      await prefetchPages(activeDocument, [pageNumber]);
    },
    [prefetchPages],
  );

  const openPreviewPage = useCallback(
    async (pageNumber: number) => {
      if (!document) {
        return;
      }

      if (pageNumber > visiblePreviewPages) {
        setVisiblePreviewPages(Math.min(pageNumber + 2, document.page_count ?? pageNumber + 2));
      }
      setActivePreviewPage(pageNumber);

      const pageElement = pageRefs.current[pageNumber];
      if (pageElement) {
        pageElement.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }

      const key = previewKey(document.id, pageNumber);
      if (!pageCache[key] && !getCachedPageData(document.id, pageNumber)) {
        await prefetchPages(document, [pageNumber]);
      }

      window.setTimeout(() => {
        pageRefs.current[pageNumber]?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 80);
    },
    [document, pageCache, prefetchPages, visiblePreviewPages],
  );

  return (
    <Dialog.Root open={document !== null} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/18 backdrop-blur-[18px]" onDoubleClick={requestClose} />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[80] flex h-[min(860px,calc(100vh-3rem))] w-[min(1180px,calc(100vw-3rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden border border-black/[0.08] bg-white shadow-[0_18px_48px_rgba(15,23,42,0.10)] outline-none"
          onPointerDownOutside={handlePointerDownOutside}
          onEscapeKeyDown={handleEscapeKeyDown}
          onFocusOutside={handleFocusOutside}
          onInteractOutside={handleInteractOutside}
        >
          <Dialog.Title className="sr-only">
            {document?.filename ?? "PDF Preview"}
          </Dialog.Title>
          <div className="min-h-0 flex-1 p-4">
            {document ? (
              <div className="flex h-full min-h-0 flex-col overflow-hidden border border-black/[0.08] bg-white">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-black/[0.08] px-4 py-3.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{document.filename}</p>
                    <p className="mt-1 text-xs uppercase tracking-[0.18em] text-muted">
                      Document preview
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 border border-black/[0.08] bg-white px-1 py-1">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-9 w-9"
                      onClick={() => setPreviewZoom((current) => Math.max(0.5, current - 0.1))}
                    >
                      <Minus className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-9 w-9"
                      onClick={() => setPreviewZoom((current) => Math.min(2.2, current + 0.1))}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-9 px-4"
                      onClick={() => setPreviewZoom(1)}
                    >
                      Fit
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-9 w-9"
                      onClick={requestClose}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="min-h-0 flex flex-1 overflow-hidden bg-[#d9d9d7]">
                  <aside className="hidden w-[116px] shrink-0 border-r border-black/[0.08] bg-[#ececeb] md:block">
                    <div className="h-full overflow-y-auto px-2 py-3 scrollbar-thin">
                      <div className="space-y-3">
                        {Array.from({ length: document.page_count ?? 1 }, (_, index) => {
                          const pageNumber = index + 1;
                          return (
                            <PreviewThumbnail
                              key={`${document.id}-preview-thumb-${pageNumber}`}
                              document={document}
                              pageNumber={pageNumber}
                              active={pageNumber === activePreviewPage}
                              cachedPage={
                                pageCache[previewKey(document.id, pageNumber)] ??
                                getCachedPageData(document.id, pageNumber) ??
                                null
                              }
                              onVisible={(nextPage) => {
                                void warmThumbnailPage(document, nextPage);
                              }}
                              onOpen={(nextPage) => {
                                void openPreviewPage(nextPage);
                              }}
                            />
                          );
                        })}
                      </div>
                    </div>
                  </aside>
                  <div
                    ref={scrollContainerRef}
                    className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-[#9b9b9b] px-4 py-5 scrollbar-thin"
                    onScroll={(event) => {
                      if (!document.page_count) {
                        return;
                      }
                      const target = event.currentTarget;
                      const nearBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 320;
                      if (nearBottom && visiblePreviewPages < document.page_count) {
                        setVisiblePreviewPages((current) =>
                          Math.min(current + 6, document.page_count ?? current + 6),
                        );
                      }

                      const containerTop = target.getBoundingClientRect().top;
                      let nextActivePage = activePreviewPage;
                      let closestDistance = Number.POSITIVE_INFINITY;

                      for (const { pageNumber, pageData } of loadedPreviewPages) {
                        if (!pageData) {
                          continue;
                        }
                        const pageElement = pageRefs.current[pageNumber];
                        if (!pageElement) {
                          continue;
                        }
                        const distance = Math.abs(pageElement.getBoundingClientRect().top - containerTop - 24);
                        if (distance < closestDistance) {
                          closestDistance = distance;
                          nextActivePage = pageNumber;
                        }
                      }

                      if (nextActivePage !== activePreviewPage) {
                        setActivePreviewPage(nextActivePage);
                      }
                    }}
                  >
                    {!loadedPreviewPages.length && previewLoading ? (
                      <div className="flex h-full items-center justify-center">
                        <LoadingSpinner className="h-6 w-6 text-white" />
                      </div>
                    ) : (
                      <div className="space-y-6">
                        {loadedPreviewPages.map(({ pageNumber, pageData }) =>
                          pageData ? (
                            <div
                              key={pageData.id}
                              ref={(element) => {
                                pageRefs.current[pageNumber] = element;
                              }}
                            >
                              <PageRenderer
                                page={pageData}
                                zoom={previewZoom}
                                highlights={[]}
                                scrollMode="natural"
                                onNavigateToExactPage={(nextPage) => {
                                  void openPreviewPage(nextPage);
                                }}
                              />
                            </div>
                          ) : (
                            <div
                              key={`${document.id}-${pageNumber}-loading`}
                              className="mx-auto max-w-[940px] border border-black/[0.08] bg-white px-6 py-10 text-center text-sm text-muted"
                            >
                              Loading page {pageNumber}...
                            </div>
                          ),
                        )}
                        {previewLoading ? (
                          <div className="flex items-center justify-center py-3">
                            <LoadingSpinner className="h-5 w-5 text-white" />
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
