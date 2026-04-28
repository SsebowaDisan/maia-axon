"use client";

import * as Tooltip from "@radix-ui/react-tooltip";
import { useEffect, useMemo, useState } from "react";

import { api, getCachedPageData } from "@/lib/api";
import type { Citation } from "@/lib/types";
import { cn } from "@/lib/utils";
import { usePDFViewerStore } from "@/stores/pdfViewerStore";

function pageKey(documentId: string, pageNumber: number) {
  return `${documentId}:${pageNumber}`;
}

export function CitationChip({
  citation,
  label,
  onClick,
  className,
}: {
  citation: Citation;
  label?: React.ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  const cachedPage = usePDFViewerStore((state) =>
    citation.source_type === "pdf" && citation.document_id
      ? state.pageCache[pageKey(citation.document_id, citation.page)] ?? null
      : null,
  );
  const sessionCachedPage = useMemo(
    () =>
      citation.source_type === "pdf" && citation.document_id
        ? getCachedPageData(citation.document_id, citation.page)
        : null,
    [citation.document_id, citation.page, citation.source_type],
  );
  const [loadedPageLabel, setLoadedPageLabel] = useState<number | null | undefined>(undefined);
  const visiblePageLabel =
    cachedPage?.printed_page_label ??
    sessionCachedPage?.printed_page_label ??
    (loadedPageLabel === undefined ? null : loadedPageLabel) ??
    citation.page;

  useEffect(() => {
    setLoadedPageLabel(undefined);
  }, [citation.document_id, citation.page]);

  const loadVisiblePageLabel = async (open: boolean) => {
    if (
      !open ||
      citation.source_type !== "pdf" ||
      !citation.document_id ||
      cachedPage?.printed_page_label ||
      sessionCachedPage?.printed_page_label ||
      loadedPageLabel !== undefined
    ) {
      return;
    }

    try {
      const page = await api.getPage(citation.document_id, citation.page);
      setLoadedPageLabel(page.printed_page_label ?? null);
    } catch {
      // Keep the internal page number fallback if page metadata is unavailable.
    }
  };

  return (
    <Tooltip.Provider delayDuration={120}>
      <Tooltip.Root onOpenChange={(open) => void loadVisiblePageLabel(open)}>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className={cn(
              "mx-0.5 inline-flex items-center rounded-full border border-black/10 bg-black/[0.04] px-2.5 py-1 text-xs font-semibold text-black transition hover:bg-black hover:text-white",
              className,
            )}
            onClick={onClick}
          >
            {label ?? `[${citation.id}]`}
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            sideOffset={8}
            className="z-50 max-w-[280px] rounded-[22px] border border-black/10 bg-white px-3 py-3 text-left text-xs text-ink shadow-[0_18px_48px_rgba(15,23,42,0.08)]"
          >
            <p className="font-semibold">{citation.document_name || citation.title || "Source"}</p>
            <p className="mt-1 text-muted">
              {citation.source_type === "pdf" ? `Page ${visiblePageLabel}` : citation.url}
            </p>
            {citation.snippet ? <p className="mt-2 line-clamp-4 text-ink/85">{citation.snippet}</p> : null}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
