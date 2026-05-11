"use client";

import { forwardRef } from "react";
import { CheckSquare, FileText, Square } from "lucide-react";

import { Input } from "@/components/ui/input";
import type { Document } from "@/lib/types";

export const DocumentSelector = forwardRef<HTMLDivElement, {
  documents: Document[];
  query: string;
  selectedIds: string[];
  onQueryChange: (value: string) => void;
  onToggleDocument: (documentId: string) => void;
  onSelectAll: () => void;
  onPreviewDocument: (document: Document) => void;
}>(function DocumentSelector(
  { documents, query, selectedIds, onQueryChange, onToggleDocument, onSelectAll, onPreviewDocument },
  ref,
) {
  const allSelected = selectedIds.length === 0;

  return (
    <div ref={ref} className="absolute bottom-full left-14 mb-3 w-[360px] rounded-[24px] border border-line bg-panel p-3 shadow-card">
      <Input
        autoFocus
        placeholder="Search documents..."
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      <p className="mt-2 px-1 text-[10px] font-medium uppercase tracking-[0.16em] text-muted">
        Click a PDF to read · checkbox to include in chat
      </p>
      <div className="mt-2 max-h-72 space-y-1 overflow-y-auto scrollbar-thin">
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left transition hover:bg-black/5"
          onClick={onSelectAll}
        >
          <span className="flex items-center gap-3">
            {allSelected ? (
              <CheckSquare className="h-4 w-4 text-accent" />
            ) : (
              <Square className="h-4 w-4 text-muted" />
            )}
            <span className="text-sm font-medium">All documents</span>
          </span>
          <span className="text-xs text-muted">default</span>
        </button>
        {documents.map((document) => {
          const checked = selectedIds.includes(document.id);
          const isReady = document.status === "ready";
          return (
            <div
              key={document.id}
              className="group flex items-center gap-1 rounded-2xl px-1 py-1 transition hover:bg-black/5"
            >
              {/* Explicit selection target — small, distinct from the
                  "open to read" surface so users don't accidentally
                  attach a doc when they meant to preview it. */}
              <button
                type="button"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition hover:bg-black/[0.08]"
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleDocument(document.id);
                }}
                aria-label={checked ? `Deselect ${document.filename}` : `Select ${document.filename}`}
                title={checked ? "Deselect" : "Include in chat"}
              >
                {checked ? (
                  <CheckSquare className="h-4 w-4 text-accent" />
                ) : (
                  <Square className="h-4 w-4 text-muted" />
                )}
              </button>

              {/* Primary action: click the row to open the PDF for
                  reading. Disabled when the document is still being
                  processed so users don't try to preview an empty
                  viewer. */}
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-2xl px-2 py-1.5 text-left transition hover:bg-black/[0.05] disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!isReady}
                onClick={(event) => {
                  event.stopPropagation();
                  if (isReady) {
                    onPreviewDocument(document);
                  }
                }}
                title={isReady ? "Open and read" : `Status: ${document.status}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <FileText className="h-4 w-4 shrink-0 text-muted" />
                  <span className="truncate text-sm font-medium">{document.filename}</span>
                </span>
                <span className="shrink-0 text-xs text-muted">
                  {isReady ? `${document.page_count ?? "?"} pages` : document.status}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
});
