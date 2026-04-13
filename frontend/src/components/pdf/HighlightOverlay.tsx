"use client";

import type { Citation } from "@/lib/types";

export function HighlightOverlay({
  citations,
  coordinateWidth,
  coordinateHeight,
  renderedWidth,
  renderedHeight,
}: {
  citations: Citation[];
  coordinateWidth: number;
  coordinateHeight: number;
  renderedWidth: number;
  renderedHeight: number;
}) {
  if (!coordinateWidth || !coordinateHeight || !citations.length) {
    return null;
  }

  const scaleX = renderedWidth / coordinateWidth;
  const scaleY = renderedHeight / coordinateHeight;

  return (
    <div className="pointer-events-none absolute inset-0">
      {citations
        .flatMap((citation) => {
          const boxes =
            citation.boxes?.filter((box) => Array.isArray(box) && box.length === 4) ??
            (citation.bbox && citation.bbox.length === 4 ? [citation.bbox] : []);
          return boxes.map((box, index) => ({ citationId: citation.id, box, index }));
        })
        .map(({ citationId, box, index }, overlayIndex) => {
          const [x1, y1, x2, y2] = box as number[];
          const paddedLeft = Math.max(x1 * scaleX - 3, 0);
          const paddedTop = Math.max(y1 * scaleY - 2, 0);
          const paddedWidth = Math.max((x2 - x1) * scaleX + 6, 18);
          const paddedHeight = Math.max((y2 - y1) * scaleY + 4, 14);
          return (
            <div
              key={`${citationId}-${index}`}
              className="absolute rounded-[8px] border border-amber-500/48 bg-[rgba(255,214,10,0.26)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.24),0_1px_4px_rgba(245,158,11,0.10)]"
              data-highlight-anchor={overlayIndex === 0 ? "true" : undefined}
              style={{
                left: paddedLeft,
                top: paddedTop,
                width: paddedWidth,
                height: paddedHeight,
              }}
            />
          );
        })}
    </div>
  );
}
