"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  ChevronUp,
  GripHorizontal,
  Languages,
  Lock,
  MessageCircleQuestion,
  Users,
  X,
} from "lucide-react";

import type { AnnotationColor, AnnotationVisibility } from "@/lib/types";

const COLORS: { value: AnnotationColor; swatch: string; label: string; border: string }[] = [
  { value: "yellow", swatch: "bg-yellow-300", label: "Yellow", border: "rgba(245, 158, 11, 0.85)" },
  { value: "green", swatch: "bg-emerald-300", label: "Green", border: "rgba(5, 150, 105, 0.85)" },
  { value: "blue", swatch: "bg-blue-300", label: "Blue", border: "rgba(37, 99, 235, 0.85)" },
  { value: "pink", swatch: "bg-pink-300", label: "Pink", border: "rgba(219, 39, 119, 0.85)" },
  { value: "orange", swatch: "bg-orange-300", label: "Orange", border: "rgba(234, 88, 12, 0.85)" },
];

const COLOR_BY_VALUE = Object.fromEntries(COLORS.map((c) => [c.value, c])) as Record<
  AnnotationColor,
  (typeof COLORS)[number]
>;

const LS_COLOR_KEY = "maia-annotation-color";
const LS_VISIBILITY_KEY = "maia-annotation-visibility";

function loadColor(): AnnotationColor {
  if (typeof window === "undefined") return "yellow";
  const saved = window.localStorage.getItem(LS_COLOR_KEY);
  return (COLORS.some((c) => c.value === saved) ? (saved as AnnotationColor) : "yellow");
}

function loadVisibility(): AnnotationVisibility {
  if (typeof window === "undefined") return "private";
  const saved = window.localStorage.getItem(LS_VISIBILITY_KEY);
  return saved === "group_shared" ? "group_shared" : "private";
}

export interface AnnotationDraft {
  pageNumber: number;
  highlightedText: string;
  // Anchor in viewer coordinates so the popover can position itself.
  anchorLeft: number;
  anchorTop: number;
  // Pre-computed PDF-space boxes per visual line.
  boxes: number[][];
}

interface AnnotationPopoverProps {
  draft: AnnotationDraft;
  saving: boolean;
  onCancel: () => void;
  onSave: (input: {
    color: AnnotationColor;
    comment: string | null;
    visibility: AnnotationVisibility;
  }) => Promise<void> | void;
  onAskMaia?: () => void;
  onTranslate?: () => void;
}

export function AnnotationPopover({ draft, saving, onCancel, onSave, onAskMaia, onTranslate }: AnnotationPopoverProps) {
  // Defaults persisted across selections so users don't have to re-pick
  // "yellow + private" every time they highlight something.
  const [color, setColor] = useState<AnnotationColor>(loadColor);
  const [visibility, setVisibility] = useState<AnnotationVisibility>(loadVisibility);
  const [comment, setComment] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  // `compact` collapses button labels to icons only when the popover
  // is dragged narrow. Threshold (~330px) is just below the natural
  // width at which the action row starts to feel cramped.
  const [compact, setCompact] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerX: number;
    pointerY: number;
    startLeft: number;
    startTop: number;
    width: number;
    height: number;
  } | null>(null);

  // Reset transient state when the draft changes (fresh selection).
  useEffect(() => {
    setPosition(null);
    setExpanded(false);
    setComment("");
  }, [draft]);

  // Watch the popover's own width via ResizeObserver. The user can
  // drag the bottom-right corner to resize (CSS `resize: both`); we
  // flip into compact mode once the width drops below ~330px so the
  // buttons stay on one row.
  useEffect(() => {
    const el = popoverRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setCompact(el.clientWidth < 330);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Persist last-used color / visibility so users get their preferred
  // defaults on the next selection.
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LS_COLOR_KEY, color);
  }, [color]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LS_VISIBILITY_KEY, visibility);
  }, [visibility]);

  // ESC dismisses; mousedown-outside is handled by the page so we don't
  // need to listen here.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  const startDrag = (event: React.MouseEvent) => {
    event.preventDefault();
    const popover = popoverRef.current;
    if (!popover) return;
    const rect = popover.getBoundingClientRect();
    dragRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      width: rect.width,
      height: rect.height,
    };
    popover.style.left = `${rect.left}px`;
    popover.style.top = `${rect.top}px`;
    popover.style.cursor = "grabbing";
    popover.style.userSelect = "none";

    const handleMove = (moveEvent: MouseEvent) => {
      const origin = dragRef.current;
      if (!origin) return;
      const MARGIN = 8;
      const maxLeft = window.innerWidth - origin.width - MARGIN;
      const maxTop = window.innerHeight - origin.height - MARGIN;
      const dx = moveEvent.clientX - origin.pointerX;
      const dy = moveEvent.clientY - origin.pointerY;
      const nextLeft = Math.max(MARGIN, Math.min(origin.startLeft + dx, maxLeft));
      const nextTop = Math.max(MARGIN, Math.min(origin.startTop + dy, maxTop));
      popover.style.left = `${nextLeft}px`;
      popover.style.top = `${nextTop}px`;
    };

    const handleUp = () => {
      const finalLeft = parseFloat(popover.style.left);
      const finalTop = parseFloat(popover.style.top);
      dragRef.current = null;
      popover.style.cursor = "";
      popover.style.userSelect = "";
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      if (!Number.isNaN(finalLeft) && !Number.isNaN(finalTop)) {
        setPosition({ left: finalLeft, top: finalTop });
      }
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  const handleSave = async () => {
    await onSave({
      color,
      comment: comment.trim() ? comment.trim() : null,
      visibility,
    });
  };

  const effectiveLeft = position?.left ?? draft.anchorLeft;
  const effectiveTop = position?.top ?? draft.anchorTop;
  const accent = COLOR_BY_VALUE[color]?.border ?? COLOR_BY_VALUE.yellow.border;

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      ref={popoverRef}
      className="maia-popover-in pointer-events-auto fixed z-[120] flex flex-col overflow-hidden rounded-2xl border border-black/[0.08] bg-panel shadow-[0_18px_48px_rgba(15,23,42,0.18)]"
      style={{
        left: effectiveLeft,
        top: effectiveTop,
        width: 360,
        // Resizable in both directions. The popover body is a flex
        // column: header + quote + (optional note) + action row, with
        // the quote acting as the flexible region — so extra height
        // grows the visible quote area instead of leaving white space
        // below the actions.
        resize: "both",
        minWidth: 260,
        minHeight: 280,
        maxWidth: "min(calc(100vw - 24px), 720px)",
        maxHeight: "calc(100vh - 48px)",
      }}
    >
      {/* Drag handle */}
      <div
        onMouseDown={startDrag}
        className="flex cursor-grab items-center justify-center border-b border-black/[0.04] py-1.5 text-muted/60 transition hover:text-ink active:cursor-grabbing"
        title="Drag to move"
      >
        <GripHorizontal className="h-4 w-4" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-3">
        {/* Color picker + close */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            {COLORS.map((entry) => {
              const selected = entry.value === color;
              return (
                <button
                  key={entry.value}
                  type="button"
                  aria-label={`Highlight in ${entry.label.toLowerCase()}`}
                  title={`Highlight in ${entry.label.toLowerCase()}`}
                  onClick={() => setColor(entry.value)}
                  className={`flex h-7 w-7 items-center justify-center rounded-full ${entry.swatch} transition hover:scale-[1.08] ${
                    selected ? "ring-2 ring-black/85 ring-offset-2 ring-offset-white" : "opacity-80 hover:opacity-100"
                  }`}
                >
                  {selected ? <Check className="h-3.5 w-3.5 text-black/85" strokeWidth={3} /> : null}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            title="Cancel (Esc)"
            className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted transition hover:bg-black/[0.05] hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Quoted selection — pull-quote style, left border previews
            the chosen highlight color so the swatch feels connected to
            what it's about to colour. Flex-1 + overflow-y-auto so this
            is the region that grows when the user resizes the popover
            taller, and scrolls when the selection is longer than fits. */}
        <blockquote
          className="mt-3 min-h-[60px] flex-1 overflow-y-auto rounded-md bg-black/[0.03] py-2 pl-3 pr-2.5 font-serif text-[13px] italic leading-6 text-ink/90 scrollbar-thin"
          style={{ borderLeft: `3px solid ${accent}` }}
        >
          &ldquo;{draft.highlightedText}&rdquo;
        </blockquote>

        {/* Expandable section: note + visibility. Hidden by default so
            the casual "highlight in yellow" flow is one click. */}
        {expanded ? (
          <div className="mt-3 space-y-2">
            <textarea
              autoFocus
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Add a note (optional)…"
              rows={3}
              className="w-full resize-y rounded-md border border-black/[0.10] bg-white px-2 py-1.5 text-[13px] leading-5 text-ink outline-none transition focus:border-ink/40"
            />
            <button
              type="button"
              onClick={() => setVisibility(visibility === "private" ? "group_shared" : "private")}
              title={
                visibility === "private"
                  ? "Only you can see this"
                  : "Visible to other users with access"
              }
              className="flex w-full items-center justify-between rounded-md border border-black/[0.10] bg-white px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted transition hover:text-ink"
            >
              <span className="flex items-center gap-2">
                {visibility === "private" ? (
                  <Lock className="h-3 w-3" />
                ) : (
                  <Users className="h-3 w-3" />
                )}
                {visibility === "private" ? "Private" : "Shared"}
              </span>
              <span className="text-[10px] text-muted/70">tap to switch</span>
            </button>
          </div>
        ) : null}

        {/* Action row — uniform 32px button height, brand palette only.
            Secondary actions are outlined white-on-black-on-hover;
            Save is the primary, always black. */}
        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            title={expanded ? "Hide note and privacy" : "Show note and privacy"}
            aria-label={expanded ? "Show less" : "Show more options"}
            className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-muted transition hover:bg-black/[0.04] hover:text-ink"
          >
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {!compact ? (
              <span className="uppercase tracking-[0.14em]">{expanded ? "Less" : "More"}</span>
            ) : null}
          </button>
          <div className="flex items-center gap-1.5">
            {onTranslate ? (
              <button
                type="button"
                onClick={onTranslate}
                title="Translate this passage"
                aria-label="Translate this passage"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-black/[0.10] bg-white text-ink transition hover:border-black hover:bg-black hover:text-white"
              >
                <Languages className="h-3.5 w-3.5" />
              </button>
            ) : null}
            {onAskMaia ? (
              <button
                type="button"
                onClick={onAskMaia}
                title="Ask Maia about this passage"
                aria-label="Ask Maia about this passage"
                className={`inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-black/[0.10] bg-white text-[12px] font-medium text-ink transition hover:border-black hover:bg-black hover:text-white ${
                  compact ? "w-8 justify-center" : "px-2.5"
                }`}
              >
                <MessageCircleQuestion className="h-3.5 w-3.5" />
                {!compact ? "Ask Maia" : null}
              </button>
            ) : null}
            <button
              type="button"
              disabled={saving}
              onClick={handleSave}
              title="Save highlight"
              aria-label="Save highlight"
              className={`inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md bg-black text-[12px] font-semibold text-white transition hover:bg-black/85 disabled:cursor-not-allowed disabled:opacity-60 ${
                compact ? "w-8 justify-center" : "px-3"
              }`}
            >
              {saving ? (
                compact ? <Check className="h-3.5 w-3.5" /> : "Saving…"
              ) : (
                <>
                  <Check className="h-3.5 w-3.5" />
                  {!compact ? "Save" : null}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
