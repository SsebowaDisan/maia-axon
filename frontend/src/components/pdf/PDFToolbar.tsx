"use client";

import { useState } from "react";

import type { Document } from "@/lib/types";

export function PDFToolbar({
  document,
  zoom,
}: {
  document: Document;
  zoom: number;
}) {
  const [value, setValue] = useState("");

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
      <div>
        <p className="font-medium text-ink">{document.filename}</p>
        <p className="text-xs text-muted">Zoom {Math.round(zoom * 100)}%</p>
      </div>
    </div>
  );
}
