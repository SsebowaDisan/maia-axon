"use client";

import * as Tooltip from "@radix-ui/react-tooltip";

import type { Citation } from "@/lib/types";
import { cn } from "@/lib/utils";

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
  return (
    <Tooltip.Provider delayDuration={120}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className={cn(
              "mx-0.5 inline-flex items-center rounded-full border border-accent/20 bg-accentSoft px-2.5 py-1 text-xs font-semibold text-accent transition hover:bg-accent hover:text-white",
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
            className="z-50 max-w-[280px] rounded-2xl border border-line bg-panel px-3 py-2 text-left text-xs text-ink shadow-card"
          >
            <p className="font-semibold">{citation.document_name || citation.title || "Source"}</p>
            <p className="mt-1 text-muted">
              {citation.source_type === "pdf" ? `Page ${citation.page}` : citation.url}
            </p>
            {citation.snippet ? <p className="mt-2 line-clamp-4 text-ink/85">{citation.snippet}</p> : null}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
