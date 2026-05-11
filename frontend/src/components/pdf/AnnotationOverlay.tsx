"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageSquare, Trash2 } from "lucide-react";

import type { Annotation, AnnotationColor } from "@/lib/types";
import { useAnnotationsStore } from "@/stores/annotationsStore";

const COLOR_FILL: Record<AnnotationColor, string> = {
  yellow: "rgba(255, 214, 10, 0.34)",
  green: "rgba(16, 185, 129, 0.30)",
  blue: "rgba(59, 130, 246, 0.30)",
  pink: "rgba(236, 72, 153, 0.30)",
  orange: "rgba(249, 115, 22, 0.32)",
};

const COLOR_BORDER: Record<AnnotationColor, string> = {
  yellow: "rgba(245, 158, 11, 0.55)",
  green: "rgba(5, 150, 105, 0.55)",
  blue: "rgba(37, 99, 235, 0.55)",
  pink: "rgba(219, 39, 119, 0.55)",
  orange: "rgba(234, 88, 12, 0.55)",
};

interface AnnotationOverlayProps {
  pageNumber: number;
  annotations: Annotation[];
  coordinateWidth: number;
  coordinateHeight: number;
  renderedWidth: number;
  renderedHeight: number;
  // The page-container DOM element that hosts both the PDF text layer
  // and this overlay. We attach the highlight-click detector here so
  // the boxes themselves can stay `pointer-events: none` (essential
  // for clean drag-selection on top of highlighted text).
  pageContainerRef: React.RefObject<HTMLElement | null>;
  // ID of the user looking at this; only their own annotations get the
  // delete button so teammates' notes are read-only.
  currentUserId: string | null;
}

export function AnnotationOverlay({
  pageNumber,
  annotations,
  coordinateWidth,
  coordinateHeight,
  renderedWidth,
  renderedHeight,
  pageContainerRef,
  currentUserId,
}: AnnotationOverlayProps) {
  const remove = useAnnotationsStore((state) => state.remove);
  const [openId, setOpenId] = useState<string | null>(null);
  // Viewport coordinates for the centered comment popover. Captured at
  // click time so the popover anchors in the middle of the PDF panel
  // regardless of where the clicked highlight sits.
  const [popoverAnchor, setPopoverAnchor] = useState<{ left: number; top: number } | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  // Close the menu when the user clicks anywhere outside the overlay
  // or the portaled popover.
  useEffect(() => {
    if (!openId) {
      return;
    }
    const handler = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return;
      if (overlayRef.current?.contains(event.target)) return;
      const popoverHost = (event.target as Element).closest?.(
        "[data-maia-comment-popover='true']",
      );
      if (popoverHost) return;
      setOpenId(null);
      setPopoverAnchor(null);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [openId]);

  // Detect clicks that land inside a highlight box via coordinate
  // math on the page container — that lets the boxes themselves stay
  // `pointer-events: none` so they never block drag-selection on the
  // text layer beneath them. Only opens the popover on a *click*
  // (mouseup with no selection drag); otherwise leaves the text-layer
  // selection flow untouched.
  useEffect(() => {
    const container = pageContainerRef.current;
    if (!container) return;
    if (!coordinateWidth || !coordinateHeight || !renderedWidth || !renderedHeight) {
      return;
    }
    const scaleX = renderedWidth / coordinateWidth;
    const scaleY = renderedHeight / coordinateHeight;

    const handler = (event: MouseEvent) => {
      // If the user just finished a text selection, let the page's
      // own mouseup handler create a new draft — don't hijack with a
      // "click on existing highlight."
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;

      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      for (const annotation of annotations) {
        const boxes = annotation.boxes?.filter(
          (box): box is number[] =>
            Array.isArray(box) && box.length === 4 && box[2] > box[0] && box[3] > box[1],
        ) ?? [];
        for (const box of boxes) {
          const [x1, y1, x2, y2] = box;
          const left = x1 * scaleX;
          const top = y1 * scaleY;
          const right = x2 * scaleX;
          const bottom = y2 * scaleY;
          if (x >= left && x <= right && y >= top && y <= bottom) {
            const targetRect = {
              left: rect.left + left,
              right: rect.left + right,
              top: rect.top + top,
              bottom: rect.top + bottom,
            };
            const panelEl = container.closest<HTMLElement>(
              '[data-pdf-scroll="true"]',
            );
            const panelRect = panelEl?.getBoundingClientRect();
            const POPOVER_W = 300;
            const POPOVER_H = 220;
            const MARGIN = 12;
            const bLeft = panelRect?.left ?? 0;
            const bRight = panelRect?.right ?? window.innerWidth;
            const bTop = panelRect?.top ?? 0;
            const bBottom = panelRect?.bottom ?? window.innerHeight;
            const center = (bLeft + bRight) / 2;
            const popoverLeft = Math.min(
              Math.max(center - POPOVER_W / 2, bLeft + MARGIN),
              Math.max(bLeft + MARGIN, bRight - POPOVER_W - MARGIN),
            );
            const popoverTop = Math.min(
              Math.max(targetRect.bottom + 12, bTop + MARGIN),
              Math.max(bTop + MARGIN, bBottom - POPOVER_H - MARGIN),
            );
            setPopoverAnchor({ left: popoverLeft, top: popoverTop });
            setOpenId(annotation.id);
            event.stopPropagation();
            return;
          }
        }
      }
    };

    container.addEventListener("click", handler);
    return () => container.removeEventListener("click", handler);
  }, [annotations, coordinateWidth, coordinateHeight, renderedWidth, renderedHeight, pageContainerRef]);

  if (
    !coordinateWidth ||
    !coordinateHeight ||
    !renderedWidth ||
    !renderedHeight ||
    !annotations.length
  ) {
    return null;
  }

  const scaleX = renderedWidth / coordinateWidth;
  const scaleY = renderedHeight / coordinateHeight;

  const isRenderable = (box: number[] | null | undefined): box is number[] =>
    Array.isArray(box) && box.length === 4 && box[2] > box[0] && box[3] > box[1];

  return (
    // pointer-events-none on the wrapper so empty space between
    // highlights doesn't intercept drag-selection on the underlying
    // PDF text layer. Each individual highlight box re-enables
    // pointer events for itself so click-to-open still works.
    <div ref={overlayRef} className="pointer-events-none absolute inset-0">
      {annotations.map((annotation) => {
        const boxes = annotation.boxes?.filter(isRenderable) ?? [];
        if (!boxes.length) return null;
        const fill = COLOR_FILL[annotation.color] ?? COLOR_FILL.yellow;
        const border = COLOR_BORDER[annotation.color] ?? COLOR_BORDER.yellow;
        const isOpen = openId === annotation.id;

        return boxes.map((box, index) => {
          const [x1, y1, x2, y2] = box;
          const left = Math.max(x1 * scaleX, 0);
          const top = Math.max(y1 * scaleY, 0);
          const width = Math.max((x2 - x1) * scaleX, 4);
          const height = Math.max((y2 - y1) * scaleY, 8);
          const isLastBox = index === boxes.length - 1;

          return (
            <div
              key={`${annotation.id}-${index}`}
              // Purely visual; pointer-events:none so drag-select on
              // text under the highlight reaches the PDF text layer.
              // Click detection happens at the page-container level
              // via coordinate math in the effect above.
              className="pointer-events-none absolute"
              style={{ left, top, width, height }}
            >
              <div
                className="absolute inset-0 rounded-[3px] border"
                style={{ backgroundColor: fill, borderColor: border }}
              />
              {/* Sticky-note marker so users see at a glance which
                  highlights have a comment attached. */}
              {annotation.comment && isLastBox ? (
                <span
                  className="pointer-events-none absolute -right-3 -top-2 flex h-4 w-4 items-center justify-center rounded-full bg-white text-[8px] shadow-sm"
                  style={{ color: border }}
                >
                  <MessageSquare className="h-2.5 w-2.5" />
                </span>
              ) : null}
              {isOpen && isLastBox && popoverAnchor && typeof document !== "undefined"
                ? createPortal(
                    <div
                      data-maia-comment-popover="true"
                      className="pointer-events-auto fixed z-[110] w-[300px] max-w-[calc(100vw_-_24px)] rounded-lg border border-black/[0.10] bg-white p-3 text-left shadow-xl"
                      style={{ top: popoverAnchor.top, left: popoverAnchor.left }}
                      onMouseDown={(event) => event.stopPropagation()}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted">
                          {annotation.user_name || "Note"}
                          {annotation.visibility === "group_shared" ? " · shared" : " · private"}
                        </p>
                        {/* Always render Delete; the backend enforces
                            owner-only auth (returns 403 otherwise). This
                            avoids a client-side gating bug from silently
                            hiding the button when auth state is racy. */}
                        <button
                          type="button"
                          title="Delete highlight"
                          aria-label="Delete highlight"
                          onClick={() => {
                            if (window.confirm("Delete this highlight?")) {
                              setOpenId(null);
                              void remove(annotation.id);
                            }
                          }}
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-danger/30 bg-danger/[0.08] px-2.5 text-[11px] font-semibold text-danger transition hover:bg-danger hover:text-white"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </button>
                      </div>
                      {annotation.comment ? (
                        <p className="mt-2 whitespace-pre-wrap text-[12px] leading-5 text-ink">
                          {annotation.comment}
                        </p>
                      ) : (
                        <p className="mt-2 italic text-[11px] text-muted">No note attached.</p>
                      )}
                    </div>,
                    document.body,
                  )
                : null}
            </div>
          );
        });
      })}
    </div>
  );
}
