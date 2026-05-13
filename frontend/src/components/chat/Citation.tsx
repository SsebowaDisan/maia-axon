"use client";

import * as Tooltip from "@radix-ui/react-tooltip";
import { useEffect, useMemo, useState } from "react";

import { api, getCachedPageData } from "@/lib/api";
import type { Citation } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useDocumentStore } from "@/stores/documentStore";
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

  const prefetchPages = usePDFViewerStore((state) => state.prefetchPages);
  const documentsByGroup = useDocumentStore((state) => state.documentsByGroup);

  const loadVisiblePageLabel = async (open: boolean) => {
    if (!open || citation.source_type !== "pdf" || !citation.document_id) {
      return;
    }

    // Hover-prefetch: opening the tooltip means the user is considering
    // clicking the chip. Warm the page (and its neighbours) now so the
    // PDF viewer renders instantly when they actually click. We look the
    // Document up in the cached document store rather than hitting the
    // network for it — if it isn't loaded the fallback path inside
    // openCitation will handle the lookup.
    const allDocuments = Object.values(documentsByGroup).flat();
    const document = allDocuments.find((item) => item.id === citation.document_id);
    if (document) {
      void prefetchPages(document, [
        citation.page - 1,
        citation.page,
        citation.page + 1,
      ]);
    }

    if (
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
            // z-[120] sits above the preview dialog (z-[80]) and its
            // overlay (z-[70]) so hover cards appear over the chat pane
            // inside the dialog, not behind it. Main-app chat is fine
            // either way (no parent stacking context above z-50).
            className="z-[120] max-w-[280px] rounded-[22px] border border-black/10 bg-white px-3 py-3 text-left text-xs text-ink shadow-[0_18px_48px_rgba(15,23,42,0.08)]"
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
