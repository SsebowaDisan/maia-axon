"use client";

import { ChevronLeft, ChevronRight, Minus, Plus, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Document } from "@/lib/types";

export function PDFToolbar({
  document,
  page,
  zoom,
  onZoomOut,
  onZoomIn,
  onFit,
  onPrevious,
  onNext,
  onJump,
  onClose,
}: {
  document: Document;
  page: number;
  zoom: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFit: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onJump: (page: number) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(String(page));

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
      <div>
        <p className="font-medium text-ink">{document.filename}</p>
        <p className="text-xs text-muted">Zoom {Math.round(zoom * 100)}%</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="icon" variant="ghost" onClick={onZoomOut}>
          <Minus className="h-4 w-4" />
        </Button>
        <Button type="button" size="icon" variant="ghost" onClick={onZoomIn}>
          <Plus className="h-4 w-4" />
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onFit}>
          Fit
        </Button>
        <Button type="button" size="icon" variant="ghost" onClick={onPrevious}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-2 rounded-full border border-line px-2 py-1">
          <Input
            className="h-8 w-16 border-0 bg-transparent px-2 text-center focus:ring-0"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                const nextPage = Number(value);
                if (!Number.isNaN(nextPage) && nextPage >= 1) {
                  onJump(nextPage);
                }
              }
            }}
          />
          <span className="text-xs text-muted">of {document.page_count ?? "?"}</span>
        </div>
        <Button type="button" size="icon" variant="ghost" onClick={onNext}>
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button type="button" size="icon" variant="ghost" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
