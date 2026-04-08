"use client";

import { CheckSquare, FileText, Square } from "lucide-react";

import { Input } from "@/components/ui/input";
import type { Document } from "@/lib/types";

export function DocumentSelector({
  documents,
  query,
  selectedIds,
  onQueryChange,
  onToggleDocument,
  onSelectAll,
}: {
  documents: Document[];
  query: string;
  selectedIds: string[];
  onQueryChange: (value: string) => void;
  onToggleDocument: (documentId: string) => void;
  onSelectAll: () => void;
}) {
  const allSelected = selectedIds.length === 0;

  return (
    <div className="absolute bottom-full left-14 mb-3 w-[360px] rounded-[24px] border border-line bg-panel p-3 shadow-card">
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
            <button
              key={document.id}
              type="button"
              className="flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left transition hover:bg-black/5"
              onClick={() => onToggleDocument(document.id)}
            >
              <span className="flex items-center gap-3">
                {checked ? (
                  <CheckSquare className="h-4 w-4 text-accent" />
                ) : (
                  <Square className="h-4 w-4 text-muted" />
                )}
                <span className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-muted" />
                  <span className="text-sm font-medium">{document.filename}</span>
                </span>
              </span>
              <span className="text-xs text-muted">{document.page_count ?? "?"} pages</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
