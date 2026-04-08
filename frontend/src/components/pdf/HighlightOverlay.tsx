"use client";

import type { Citation } from "@/lib/types";

export function HighlightOverlay({
  citations,
  naturalWidth,
  naturalHeight,
  renderedWidth,
  renderedHeight,
}: {
  citations: Citation[];
  naturalWidth: number;
  naturalHeight: number;
  renderedWidth: number;
  renderedHeight: number;
}) {
  if (!naturalWidth || !naturalHeight || !citations.length) {
    return null;
  }

  const scaleX = renderedWidth / naturalWidth;
  const scaleY = renderedHeight / naturalHeight;

  return (
    <div className="pointer-events-none absolute inset-0">
      {citations
        .filter((citation) => citation.bbox && citation.bbox.length === 4)
        .map((citation) => {
          const [x1, y1, x2, y2] = citation.bbox as number[];
          return (
            <div
              key={citation.id}
              className="absolute rounded-md border-2 border-amber-400/90 bg-amber-300/30 shadow-[0_0_0_9999px_rgba(251,191,36,0.02)]"
              style={{
                left: x1 * scaleX,
                top: y1 * scaleY,
                width: Math.max((x2 - x1) * scaleX, 12),
                height: Math.max((y2 - y1) * scaleY, 12),
              }}
            />
          );
        })}
    </div>
  );
}
