"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, GripHorizontal, Lock, MessageSquare, Trash2, Users, X } from "lucide-react";

import { DeleteConfirmDialog } from "@/components/shared/DeleteConfirmDialog";
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

// Swatch fill (more saturated than the highlight fill, so the dots in
// the color picker pop visually rather than being washed-out).
const COLOR_SWATCH: Record<AnnotationColor, string> = {
  yellow: "rgb(252, 211, 77)",
  green: "rgb(52, 211, 153)",
  blue: "rgb(96, 165, 250)",
  pink: "rgb(244, 114, 182)",
  orange: "rgb(251, 146, 60)",
};

const ANNOTATION_COLORS: AnnotationColor[] = ["yellow", "green", "blue", "pink", "orange"];

// Popover bounds. MIN keeps content readable, MAX prevents the
// user from accidentally enlarging it past the viewport.
const POPOVER_MIN_WIDTH = 300;
const POPOVER_MIN_HEIGHT = 220;
const POPOVER_DEFAULT_WIDTH = 340;
const POPOVER_DEFAULT_HEIGHT = 320;

function HighlightActionsPopover({
  anchor,
  annotation,
  noteDraft,
  onNoteChange,
  noteSaving,
  onSaveNote,
  onResetNote,
  onChangeColor,
  onToggleVisibility,
  onDelete,
  onClose,
}: {
  anchor: { left: number; top: number };
  annotation: Annotation;
  noteDraft: string;
  onNoteChange: (value: string) => void;
  noteSaving: boolean;
  onSaveNote: () => Promise<void> | void;
  onResetNote: () => void;
  onChangeColor: (color: AnnotationColor) => void;
  onToggleVisibility: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const isShared = annotation.visibility === "group_shared";
  const noteDirty = (noteDraft.trim() || null) !== (annotation.comment ?? null);
  const quote = annotation.highlighted_text ?? "";
  const quoteShown = quote.length > 140 ? `${quote.slice(0, 140)}…` : quote;

  // Drag offset (added to anchor) + user-resized dimensions. Offset
  // starts at 0/0 so the popover opens centred on the click anchor
  // exactly like before; the user can then grab the header to nudge
  // it out of the way, or pull the bottom-right corner to make
  // room for a longer note.
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({
    width: POPOVER_DEFAULT_WIDTH,
    height: POPOVER_DEFAULT_HEIGHT,
  });
  const [interacting, setInteracting] = useState<null | "drag" | "resize">(null);

  const startDrag = (event: React.MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const startMouseX = event.clientX;
    const startMouseY = event.clientY;
    const startOffset = dragOffset;
    setInteracting("drag");
    const previousCursor = window.document.body.style.cursor;
    const previousSelect = window.document.body.style.userSelect;
    window.document.body.style.cursor = "grabbing";
    window.document.body.style.userSelect = "none";
    const onMove = (moveEvent: MouseEvent) => {
      setDragOffset({
        x: startOffset.x + (moveEvent.clientX - startMouseX),
        y: startOffset.y + (moveEvent.clientY - startMouseY),
      });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.document.body.style.cursor = previousCursor;
      window.document.body.style.userSelect = previousSelect;
      setInteracting(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startResize = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startMouseX = event.clientX;
    const startMouseY = event.clientY;
    const startSize = size;
    setInteracting("resize");
    const previousCursor = window.document.body.style.cursor;
    const previousSelect = window.document.body.style.userSelect;
    window.document.body.style.cursor = "nwse-resize";
    window.document.body.style.userSelect = "none";
    const onMove = (moveEvent: MouseEvent) => {
      const maxW =
        typeof window !== "undefined" ? window.innerWidth - 24 : startSize.width;
      const maxH =
        typeof window !== "undefined" ? window.innerHeight - 24 : startSize.height;
      setSize({
        width: Math.max(
          POPOVER_MIN_WIDTH,
          Math.min(maxW, startSize.width + (moveEvent.clientX - startMouseX)),
        ),
        height: Math.max(
          POPOVER_MIN_HEIGHT,
          Math.min(maxH, startSize.height + (moveEvent.clientY - startMouseY)),
        ),
      });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.document.body.style.cursor = previousCursor;
      window.document.body.style.userSelect = previousSelect;
      setInteracting(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Same accent treatment as the creation popover — the blockquote's
  // left border previews the chosen highlight color so the swatch
  // feels tied to what it's about to paint.
  const accent = COLOR_BORDER[annotation.color] ?? COLOR_BORDER.yellow;

  return (
    <div
      data-maia-comment-popover="true"
      className={`maia-popover-in pointer-events-auto fixed z-[110] flex flex-col overflow-hidden rounded-2xl border border-black/[0.08] bg-panel shadow-[0_18px_48px_rgba(15,23,42,0.18)] ${
        interacting ? "select-none" : ""
      }`}
      style={{
        top: anchor.top + dragOffset.y,
        left: anchor.left + dragOffset.x,
        width: size.width,
        height: size.height,
        maxWidth: "calc(100vw - 24px)",
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {/* Drag handle bar — matches the creation popover exactly:
          centred GripHorizontal icon, thin bottom border, cursor
          flips to grab. */}
      <div
        onMouseDown={startDrag}
        className="flex shrink-0 cursor-grab items-center justify-center border-b border-black/[0.04] py-1.5 text-muted/60 transition hover:text-ink active:cursor-grabbing"
        title="Drag to move"
      >
        <GripHorizontal className="h-4 w-4" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-3">
        {/* Color picker + close — same row as creation popover. Each
            click instantly updates the highlight color via the store
            (edit mode, not draft mode), so there's no separate save. */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            {ANNOTATION_COLORS.map((color) => {
              const selected = color === annotation.color;
              return (
                <button
                  key={color}
                  type="button"
                  aria-label={`Change color to ${color}`}
                  title={`Color · ${color}`}
                  onClick={() => onChangeColor(color)}
                  className={`flex h-7 w-7 items-center justify-center rounded-full transition hover:scale-[1.08] ${
                    selected
                      ? "ring-2 ring-black/85 ring-offset-2 ring-offset-white"
                      : "opacity-80 hover:opacity-100"
                  }`}
                  style={{ backgroundColor: COLOR_SWATCH[color] }}
                >
                  {selected ? (
                    <Check className="h-3.5 w-3.5 text-black/85" strokeWidth={3} />
                  ) : null}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted transition hover:bg-black/[0.05] hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Quoted selection — pull-quote style with the color-tinted
            left border, matching the create popover. */}
        {quoteShown ? (
          <blockquote
            className="mt-3 min-h-[48px] overflow-y-auto rounded-md bg-black/[0.03] py-2 pl-3 pr-2.5 font-serif text-[13px] italic leading-6 text-ink/90 scrollbar-thin"
            style={{ borderLeft: `3px solid ${accent}` }}
          >
            &ldquo;{quoteShown}&rdquo;
          </blockquote>
        ) : null}

        {/* Note editor — flex-1 so it grows to fill whatever height
            the user has dragged the popover to. */}
        <textarea
          value={noteDraft}
          onChange={(event) => onNoteChange(event.target.value)}
          placeholder="Add a note (optional)…"
          className="mt-3 min-h-[60px] w-full flex-1 resize-none rounded-md border border-black/[0.10] bg-white px-2 py-1.5 text-[13px] leading-5 text-ink outline-none transition focus:border-ink/40"
        />

        {/* Visibility pill — full-width clickable, matches the create
            popover's "Private / Shared" toggle exactly. */}
        <button
          type="button"
          onClick={onToggleVisibility}
          title={isShared ? "Visible to teammates" : "Only you can see this"}
          className="mt-2 flex w-full items-center justify-between rounded-md border border-black/[0.10] bg-white px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted transition hover:text-ink"
        >
          <span className="flex items-center gap-2">
            {isShared ? <Users className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
            {isShared ? "Shared" : "Private"}
          </span>
          <span className="text-[10px] text-muted/70">tap to switch</span>
        </button>

        {/* Action row — Delete on the left (destructive, isolated by
            distance), Save changes on the right (only when dirty).
            Same 32px button height + brand palette as the create
            popover. */}
        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onDelete}
            title="Delete highlight"
            aria-label="Delete highlight"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-danger/30 bg-danger/[0.08] px-2.5 text-[12px] font-semibold text-danger transition hover:bg-danger hover:text-white"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
          {noteDirty ? (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={onResetNote}
                className="inline-flex h-8 items-center rounded-md px-2.5 text-[12px] font-medium text-muted transition hover:bg-black/[0.05] hover:text-ink"
              >
                Discard
              </button>
              <button
                type="button"
                disabled={noteSaving}
                onClick={() => void onSaveNote()}
                className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md bg-black px-3 text-[12px] font-semibold text-white transition hover:bg-black/85 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Check className="h-3.5 w-3.5" />
                {noteSaving ? "Saving…" : "Save"}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* Resize handle, bottom-right corner. Subtle diagonal stripe so
          the affordance is discoverable; cursor change confirms drag
          is available. */}
      <div
        aria-hidden="true"
        onMouseDown={startResize}
        className="absolute bottom-0 right-0 h-[18px] w-[18px] cursor-nwse-resize"
        style={{
          backgroundImage:
            "linear-gradient(135deg, transparent 0 45%, rgba(0,0,0,0.18) 45% 55%, transparent 55% 70%, rgba(0,0,0,0.18) 70% 80%, transparent 80%)",
        }}
      />
    </div>
  );
}

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
  const update = useAnnotationsStore((state) => state.update);
  const [openId, setOpenId] = useState<string | null>(null);
  // Viewport coordinates for the centered comment popover. Captured at
  // click time so the popover anchors in the middle of the PDF panel
  // regardless of where the clicked highlight sits.
  const [popoverAnchor, setPopoverAnchor] = useState<{ left: number; top: number } | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  // Annotation queued for deletion confirmation. Replaces the native
  // window.confirm() (the "localhost:3000 says…" browser dialog) with
  // our branded DeleteConfirmDialog.
  const [deletePending, setDeletePending] = useState<Annotation | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  // Draft state for the note editor. Initialised every time the
  // popover opens for a different annotation. Saved on user action,
  // not auto-saved — so accidental typing doesn't permanently mutate
  // someone else's collaborative note.
  const [noteDraft, setNoteDraft] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);

  useEffect(() => {
    if (!openId) {
      setNoteDraft("");
      return;
    }
    const annotation = annotations.find((a) => a.id === openId);
    setNoteDraft(annotation?.comment ?? "");
  }, [openId, annotations]);

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
              {/* No border / no rounding. Highlights are stored as
                  per-glyph-cluster boxes (no merging), so each box is
                  small. If we drew borders, adjacent boxes would show
                  visible seams between every word. A plain fill makes
                  contiguous selected text read as one solid strip. */}
              <div
                className="absolute inset-0"
                style={{ backgroundColor: fill }}
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
                    <HighlightActionsPopover
                      anchor={popoverAnchor}
                      annotation={annotation}
                      noteDraft={noteDraft}
                      onNoteChange={setNoteDraft}
                      noteSaving={noteSaving}
                      onSaveNote={async () => {
                        const next = noteDraft.trim() ? noteDraft : null;
                        const current = annotation.comment ?? null;
                        if (next === current) return;
                        setNoteSaving(true);
                        try {
                          await update(annotation.id, { comment: next });
                        } finally {
                          setNoteSaving(false);
                        }
                      }}
                      onResetNote={() => setNoteDraft(annotation.comment ?? "")}
                      onChangeColor={(color) => {
                        if (color === annotation.color) return;
                        void update(annotation.id, { color });
                      }}
                      onToggleVisibility={() => {
                        const next =
                          annotation.visibility === "group_shared"
                            ? "private"
                            : "group_shared";
                        void update(annotation.id, { visibility: next });
                      }}
                      onDelete={() => setDeletePending(annotation)}
                      onClose={() => {
                        setOpenId(null);
                        setPopoverAnchor(null);
                      }}
                    />,
                    document.body,
                  )
                : null}
            </div>
          );
        });
      })}
      {/*
        Branded delete confirmation. Uses the shared DeleteConfirmDialog
        (rounded card, branded buttons) so highlights aren't deleted
        through the OS's native "localhost:3000 says…" alert. No
        "type DELETE" requirement — a highlight is a low-stakes
        deletion and friction here would feel punitive.
      */}
      <DeleteConfirmDialog
        open={deletePending !== null}
        onOpenChange={(open) => {
          if (!open) setDeletePending(null);
        }}
        title="Delete highlight?"
        description={
          deletePending?.highlighted_text ? (
            <span>
              The selection{" "}
              <span className="italic text-ink/90">
                “{deletePending.highlighted_text.length > 80
                  ? `${deletePending.highlighted_text.slice(0, 80)}…`
                  : deletePending.highlighted_text}”
              </span>{" "}
              and any note attached to it will be removed. This can't be undone.
            </span>
          ) : (
            "This highlight and any note attached to it will be removed. This can't be undone."
          )
        }
        confirmLabel="Delete highlight"
        isDeleting={isDeleting}
        requireDeleteText={false}
        onConfirm={async () => {
          if (!deletePending) return;
          setIsDeleting(true);
          try {
            setOpenId(null);
            await remove(deletePending.id);
            setDeletePending(null);
          } finally {
            setIsDeleting(false);
          }
        }}
      />
    </div>
  );
}
