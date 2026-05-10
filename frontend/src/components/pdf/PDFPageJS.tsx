"use client";

import "@/components/pdf/pdfjsSetup";

import { useEffect, useRef, useState } from "react";
import { Page } from "react-pdf";

import { HighlightOverlay } from "@/components/pdf/HighlightOverlay";
import type { Citation } from "@/lib/types";

interface PDFPageJSProps {
  pageNumber: number;
  zoom: number;
  highlights: Citation[];
  onRenderSuccess?: (info: { pageNumber: number; width: number; height: number }) => void;
  onHighlightReady?: () => void;
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
  highlights,
  onRenderSuccess,
  onHighlightReady,
}: PDFPageJSProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [pageSize, setPageSize] = useState<{
    width: number;
    height: number;
    pdfWidth: number;
    pdfHeight: number;
  } | null>(null);
  const lastReadyKeyRef = useRef<string | null>(null);

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

  return (
    <div
      ref={containerRef}
      className="relative mx-auto bg-white shadow-[0_4px_18px_rgba(15,23,42,0.06)]"
    >
      <Page
        pageNumber={pageNumber}
        scale={zoom}
        renderTextLayer
        renderAnnotationLayer
        onRenderSuccess={handleRenderSuccess}
        loading={
          <div className="flex h-[600px] w-[480px] items-center justify-center text-sm text-muted">
            Loading page {pageNumber}…
          </div>
        }
        error={
          <div className="flex h-[400px] w-[480px] items-center justify-center text-sm text-warn">
            Failed to render page {pageNumber}
          </div>
        }
      />
      {pageSize ? (
        <HighlightOverlay
          citations={highlights}
          coordinateWidth={pageSize.pdfWidth}
          coordinateHeight={pageSize.pdfHeight}
          renderedWidth={pageSize.width}
          renderedHeight={pageSize.height}
        />
      ) : null}
    </div>
  );
}
