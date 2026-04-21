"use client";

import type { Document } from "@/lib/types";

export function PDFToolbar({
  document,
  zoom,
}: {
  document: Document;
  zoom: number;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-ink">{document.filename}</p>
      </div>
      <div className="shrink-0 text-[11px] font-medium uppercase tracking-[0.16em] text-muted">
        {Math.round(zoom * 100)}%
      </div>
    </div>
  );
}
