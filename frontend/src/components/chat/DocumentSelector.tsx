"use client";

import { forwardRef } from "react";
import { CheckSquare, Eye, FileText, Square } from "lucide-react";

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
      <div className="mt-3 max-h-72 space-y-1 overflow-y-auto scrollbar-thin">
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
          return (
            <div
              key={document.id}
              className="group flex items-center gap-2 rounded-2xl px-2 py-2 transition hover:bg-black/5"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-2xl px-1 py-1 text-left"
                onClick={() => onToggleDocument(document.id)}
              >
                <span className="flex min-w-0 items-center gap-3">
                  {checked ? (
                    <CheckSquare className="h-4 w-4 text-accent" />
                  ) : (
                    <Square className="h-4 w-4 text-muted" />
                  )}
                  <span className="flex min-w-0 items-center gap-2">
                    <FileText className="h-4 w-4 shrink-0 text-muted" />
                    <span className="truncate text-sm font-medium">{document.filename}</span>
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted">{document.page_count ?? "?"} pages</span>
              </button>
              {document.status === "ready" ? (
                <button
                  type="button"
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-black/[0.06] bg-white text-muted opacity-0 shadow-[0_8px_20px_rgba(15,23,42,0.04)] transition hover:border-black/[0.12] hover:text-ink group-hover:opacity-100 focus:opacity-100"
                  aria-label={`Preview ${document.filename}`}
                  title="Preview PDF"
                  onClick={(event) => {
                    event.stopPropagation();
                    onPreviewDocument(document);
                  }}
                >
                  <Eye className="h-4 w-4" />
                </button>
              ) : (
                <span className="inline-flex h-9 w-9 shrink-0" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
