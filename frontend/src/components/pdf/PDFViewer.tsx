"use client";

import { FileSearch2 } from "lucide-react";

import { PageRenderer } from "@/components/pdf/PageRenderer";
import { PDFToolbar } from "@/components/pdf/PDFToolbar";
import { LoadingSpinner } from "@/components/shared/LoadingSpinner";
import { usePDFViewerStore } from "@/stores/pdfViewerStore";

export function PDFViewer() {
  const currentDocument = usePDFViewerStore((state) => state.currentDocument);
  const pageData = usePDFViewerStore((state) => state.pageData);
  const currentPage = usePDFViewerStore((state) => state.currentPage);
  const zoom = usePDFViewerStore((state) => state.zoom);
  const highlights = usePDFViewerStore((state) => state.highlightCitations);
  const loading = usePDFViewerStore((state) => state.loading);
  const previousPage = usePDFViewerStore((state) => state.previousPage);
  const nextPage = usePDFViewerStore((state) => state.nextPage);
  const loadPage = usePDFViewerStore((state) => state.loadPage);
  const setZoom = usePDFViewerStore((state) => state.setZoom);
  const fitWidth = usePDFViewerStore((state) => state.fitWidth);
  const close = usePDFViewerStore((state) => state.close);
  const clearHighlights = usePDFViewerStore((state) => state.clearHighlights);

  if (!currentDocument) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 rounded-[28px] border border-dashed border-line bg-panel/60 p-6 text-center">
        <div className="rounded-full bg-accentSoft p-4 text-accent">
          <FileSearch2 className="h-7 w-7" />
        </div>
        <div>
          <p className="font-display text-xl">No source open</p>
          <p className="mt-2 max-w-sm text-sm leading-7 text-muted">
            Click a citation or a mindmap node to open the source page and inspect the evidence.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-[28px] border border-line bg-panel/95">
      <PDFToolbar
        document={currentDocument}
        page={currentPage}
        zoom={zoom}
        onZoomOut={() => setZoom(Math.max(0.5, zoom - 0.1))}
        onZoomIn={() => setZoom(Math.min(2.2, zoom + 0.1))}
        onFit={fitWidth}
        onPrevious={() => void previousPage()}
        onNext={() => void nextPage()}
        onJump={(page) => void loadPage(currentDocument, page)}
        onClose={close}
      />
      <div className="flex items-center justify-between px-4 py-2 text-xs text-muted">
        <span>{highlights.length ? `${highlights.length} highlight(s) on this page` : "No active highlight"}</span>
        <button type="button" className="text-accent" onClick={clearHighlights}>
          Clear
        </button>
      </div>
      <div className="min-h-0 flex-1 p-4">
        {loading && !pageData ? (
          <div className="flex h-full items-center justify-center">
            <LoadingSpinner className="h-6 w-6" />
          </div>
        ) : pageData ? (
          <PageRenderer page={pageData} zoom={zoom} highlights={highlights} />
        ) : null}
      </div>
    </div>
  );
}
