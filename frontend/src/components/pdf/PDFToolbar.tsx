"use client";

import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, Maximize2, Minus, Plus, Search, X } from "lucide-react";

import type { Document } from "@/lib/types";
import type { PdfSearchState } from "@/components/pdf/usePdfSearch";

interface PDFToolbarProps {
  document: Document;
  zoom: number;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onFitWidth?: () => void;
  search?: PdfSearchState;
}

export function PDFToolbar({ document, zoom, onZoomIn, onZoomOut, onFitWidth, search }: PDFToolbarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Ctrl/Cmd+F focuses the in-PDF search instead of the browser's find bar.
  useEffect(() => {
    if (!search) {
      return;
    }
    const handleKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [search]);

  const showCounter = !!search && search.query.trim().length > 0;
  const matchCount = search?.matches.length ?? 0;
  const human = matchCount === 0 ? (search?.searching ? "Searching…" : "No matches") : `${search!.currentIndex + 1} / ${matchCount}`;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">{document.filename}</p>
      </div>
      {search ? (
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-md border border-black/[0.10] bg-white px-2 py-1.5">
            <Search className="h-3.5 w-3.5 text-muted" />
            <input
              ref={inputRef}
              type="text"
              placeholder="Find in document"
              value={search.query}
              onChange={(event) => search.setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (event.shiftKey) {
                    search.goPrev();
                  } else {
                    search.goNext();
                  }
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  search.clear();
                  inputRef.current?.blur();
                }
              }}
              className="w-44 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
            />
            {showCounter ? (
              <span className="select-none whitespace-nowrap text-[11px] tabular-nums text-muted">
                {human}
              </span>
            ) : null}
            {search.query ? (
              <button
                type="button"
                onClick={search.clear}
                title="Clear search"
                aria-label="Clear search"
                className="text-muted transition hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
          <button
            type="button"
            disabled={matchCount === 0}
            onClick={search.goPrev}
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-black/[0.10] bg-white text-ink transition hover:bg-black hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white disabled:hover:text-ink"
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={matchCount === 0}
            onClick={search.goNext}
            title="Next match (Enter)"
            aria-label="Next match"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-black/[0.10] bg-white text-ink transition hover:bg-black hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white disabled:hover:text-ink"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>
      ) : null}
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onZoomOut}
          disabled={!onZoomOut}
          title="Zoom out (Ctrl+−)"
          aria-label="Zoom out"
          className="flex h-7 w-7 items-center justify-center rounded-md border border-black/[0.10] bg-white text-ink transition hover:bg-black hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white disabled:hover:text-ink"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <span className="min-w-[44px] select-none text-center text-[11px] font-medium uppercase tracking-[0.16em] tabular-nums text-muted">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={onZoomIn}
          disabled={!onZoomIn}
          title="Zoom in (Ctrl+=)"
          aria-label="Zoom in"
          className="flex h-7 w-7 items-center justify-center rounded-md border border-black/[0.10] bg-white text-ink transition hover:bg-black hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white disabled:hover:text-ink"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onFitWidth}
          disabled={!onFitWidth}
          title="Fit to width (Ctrl+0)"
          aria-label="Fit to width"
          className="ml-1 flex h-7 w-7 items-center justify-center rounded-md border border-black/[0.10] bg-white text-ink transition hover:bg-black hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-white disabled:hover:text-ink"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
