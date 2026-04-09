"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Minus, Plus, X } from "lucide-react";

import { PageRenderer } from "@/components/pdf/PageRenderer";
import { LoadingSpinner } from "@/components/shared/LoadingSpinner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { Document, PageData } from "@/lib/types";

function previewKey(documentId: string, pageNumber: number) {
  return `${documentId}:${pageNumber}`;
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
  const [previewCache, setPreviewCache] = useState<Record<string, PageData>>({});
  const [visiblePreviewPages, setVisiblePreviewPages] = useState(0);

  const loadPreviewPages = useCallback(
    async (activeDocument: Document, targetVisiblePages: number) => {
      const maxPage = Math.min(targetVisiblePages, activeDocument.page_count ?? targetVisiblePages);
      const missingPages: number[] = [];

      for (let pageNumber = 1; pageNumber <= maxPage; pageNumber += 1) {
        if (!previewCache[previewKey(activeDocument.id, pageNumber)]) {
          missingPages.push(pageNumber);
        }
      }

      if (!missingPages.length) {
        return;
      }

      setPreviewLoading(true);
      try {
        const pageResults = await Promise.all(
          missingPages.map(async (pageNumber) => ({
            pageNumber,
            pageData: await api.getPage(activeDocument.id, pageNumber),
          })),
        );

        setPreviewCache((current) => {
          const next = { ...current };
          for (const { pageNumber, pageData } of pageResults) {
            next[previewKey(activeDocument.id, pageNumber)] = pageData;
          }
          return next;
        });
      } finally {
        setPreviewLoading(false);
      }
    },
    [previewCache],
  );

  useEffect(() => {
    if (!document) {
      setPreviewLoading(false);
      setPreviewZoom(1);
      setVisiblePreviewPages(0);
      return;
    }

    setPreviewZoom(1);
    setVisiblePreviewPages(Math.min(document.page_count ?? 1, 6));
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
        pageData: previewCache[previewKey(document.id, pageNumber)] ?? null,
      });
    }
    return pages;
  }, [document, previewCache, visiblePreviewPages]);

  return (
    <Dialog.Root open={document !== null} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/18 backdrop-blur-[18px]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[80] flex h-[min(820px,calc(100vh-3rem))] w-[min(980px,calc(100vw-3rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[34px] border border-white/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(248,248,249,0.95))] shadow-[0_30px_100px_rgba(15,23,42,0.14)] outline-none"
          onPointerDownOutside={() => onOpenChange(false)}
        >
          <Dialog.Title className="sr-only">
            {document?.filename ?? "PDF Preview"}
          </Dialog.Title>
          <div className="min-h-0 flex-1 p-4">
            {document ? (
              <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[26px] border border-black/[0.05] bg-[linear-gradient(180deg,rgba(250,250,251,0.98),rgba(244,244,246,0.95))] shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-black/[0.05] px-4 py-3.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{document.filename}</p>
                    <p className="mt-1 text-xs uppercase tracking-[0.18em] text-muted">
                      Read mode
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 rounded-full border border-black/[0.05] bg-white/70 p-1 shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-9 w-9 rounded-full"
                      onClick={() => setPreviewZoom((current) => Math.max(0.5, current - 0.1))}
                    >
                      <Minus className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-9 w-9 rounded-full"
                      onClick={() => setPreviewZoom((current) => Math.min(2.2, current + 0.1))}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-9 rounded-full px-4"
                      onClick={() => setPreviewZoom(1)}
                    >
                      Fit
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-9 w-9 rounded-full"
                      onClick={() => onOpenChange(false)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div
                  className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.88),rgba(240,240,242,0.92))] p-4 scrollbar-thin"
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
                  }}
                >
                  {!loadedPreviewPages.length && previewLoading ? (
                    <div className="flex h-full items-center justify-center rounded-[28px] border border-black/[0.04] bg-white/60">
                      <LoadingSpinner className="h-6 w-6" />
                    </div>
                  ) : (
                    <div className="space-y-6">
                      {loadedPreviewPages.map(({ pageNumber, pageData }) =>
                        pageData ? (
                          <div key={pageData.id} className="space-y-3">
                            <div className="flex justify-center">
                              <p className="rounded-full border border-black/[0.06] bg-white/80 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted shadow-[0_8px_22px_rgba(15,23,42,0.04)]">
                                Page {pageNumber}
                              </p>
                            </div>
                            <PageRenderer page={pageData} zoom={previewZoom} highlights={[]} scrollMode="natural" />
                          </div>
                        ) : (
                          <div
                            key={`${document.id}-${pageNumber}-loading`}
                            className="rounded-[28px] border border-black/[0.05] bg-white/70 px-6 py-10 text-center text-sm text-muted shadow-[0_12px_30px_rgba(15,23,42,0.04)]"
                          >
                            Loading page {pageNumber}...
                          </div>
                        ),
                      )}
                      {previewLoading ? (
                        <div className="flex items-center justify-center py-3">
                          <LoadingSpinner className="h-5 w-5" />
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
