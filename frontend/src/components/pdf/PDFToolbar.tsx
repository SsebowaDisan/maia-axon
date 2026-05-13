"use client";

import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, Maximize2, MessageSquare, Minus, Network, PanelRightClose, Plus, Search, X } from "lucide-react";

import type { Document } from "@/lib/types";
import type { PdfSearchState } from "@/components/pdf/usePdfSearch";
import { usePDFViewerStore } from "@/stores/pdfViewerStore";

interface PDFToolbarProps {
  document: Document;
  zoom: number;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onFitWidth?: () => void;
  onOpenMindmap?: () => void;
  search?: PdfSearchState;
}

export function PDFToolbar({ document, zoom, onZoomIn, onZoomOut, onFitWidth, onOpenMindmap, search }: PDFToolbarProps) {
  // The Chat toggle only renders when a chat surface is mounted next
  // to the viewer — that's the case when the user opened the PDF via
  // the preview dialog. In the main app there's no embedded chat to
  // toggle, so the button stays hidden.
  const chatPaneAvailable = usePDFViewerStore((s) => s.chatPaneAvailable);
  const chatPaneOpen = usePDFViewerStore((s) => s.chatPaneOpen);
  const toggleChatPane = usePDFViewerStore((s) => s.toggleChatPane);
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
      {/*
        Zoom controls grouped into a single bordered pill so they read
        as one control instead of three orphan icon buttons. Dividers
        replace borders between segments.
      */}
      {onOpenMindmap ? (
        <button
          type="button"
          onClick={onOpenMindmap}
          title="Open the section mindmap for this document"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-black/[0.10] bg-white px-2.5 py-[5px] text-[12px] font-medium text-ink transition hover:bg-[#2a2522] hover:text-white"
        >
          <Network className="h-3.5 w-3.5" />
          Mindmap
        </button>
      ) : null}
      {chatPaneAvailable ? (
        <button
          type="button"
          onClick={toggleChatPane}
          title={chatPaneOpen ? "Hide chat panel" : "Show chat panel"}
          aria-label={chatPaneOpen ? "Hide chat" : "Show chat"}
          aria-pressed={chatPaneOpen}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-[5px] text-[12px] font-medium transition ${
            chatPaneOpen
              ? "border-black/[0.16] bg-[#2a2522] text-white hover:bg-[#3a3530]"
              : "border-black/[0.10] bg-white text-ink hover:bg-[#2a2522] hover:text-white"
          }`}
        >
          {chatPaneOpen ? (
            <PanelRightClose className="h-3.5 w-3.5" />
          ) : (
            <MessageSquare className="h-3.5 w-3.5" />
          )}
          Chat
        </button>
      ) : null}
      <div className="flex shrink-0 items-center overflow-hidden rounded-md border border-black/[0.10] bg-white">
        <button
          type="button"
          onClick={onZoomOut}
          disabled={!onZoomOut}
          title="Zoom out (Ctrl+−)"
          aria-label="Zoom out"
          className="flex h-7 w-7 items-center justify-center text-ink transition hover:bg-black hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <span className="min-w-[48px] select-none border-x border-black/[0.10] px-1 text-center text-[11px] font-medium tabular-nums text-ink">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={onZoomIn}
          disabled={!onZoomIn}
          title="Zoom in (Ctrl+=)"
          aria-label="Zoom in"
          className="flex h-7 w-7 items-center justify-center text-ink transition hover:bg-black hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <span aria-hidden="true" className="h-5 w-px self-center bg-black/[0.10]" />
        <button
          type="button"
          onClick={onFitWidth}
          disabled={!onFitWidth}
          title="Fit to width (Ctrl+0)"
          aria-label="Fit to width"
          className="flex h-7 w-7 items-center justify-center text-ink transition hover:bg-black hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
