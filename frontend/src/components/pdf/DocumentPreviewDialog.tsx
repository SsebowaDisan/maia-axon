"use client";

import * as Dialog from "@radix-ui/react-dialog";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { GripHorizontal, Maximize2, Minimize2, X } from "lucide-react";

import { useDialogDismiss } from "@/hooks/useDialogDismiss";
import type { Document } from "@/lib/types";
import { usePDFViewerStore } from "@/stores/pdfViewerStore";

// Re-use the chat's full PDFViewer (search, highlights, annotations,
// outline, ask-Maia, etc.) inside the library preview dialog. SSR
// disabled because pdfjs-dist touches browser globals (DOMMatrix) at
// import time. The shared store means the chat-side viewer and the
// dialog viewer drive the same `currentDocument` — fine because the
// dialog is modal and stacks above the chat panel.
const PDFViewer = dynamic(
  () => import("@/components/pdf/PDFViewer").then((mod) => mod.PDFViewer),
  { ssr: false },
);

// Bounds. MIN_* keep the dialog usable; VIEWPORT_INSET stops it from
// kissing the browser edges when maximized.
const MIN_WIDTH = 640;
const MIN_HEIGHT = 480;
const VIEWPORT_INSET = 16;
// Keep at least this many pixels of the dialog visible after a drag,
// so the title bar never goes fully off-screen and the user can grab
// it again.
const DRAG_KEEP_VISIBLE = 80;
const STORAGE_KEY = "pdfDialogSize";

type Size = { width: number; height: number };
type Position = { x: number; y: number };

function readStoredSize(): Size | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.width === "number" &&
      typeof parsed.height === "number" &&
      parsed.width > 0 &&
      parsed.height > 0
    ) {
      return parsed as Size;
    }
  } catch {
    /* ignore corrupt storage */
  }
  return null;
}

function defaultSize(): Size {
  if (typeof window === "undefined") return { width: 1180, height: 860 };
  return {
    width: Math.min(1180, window.innerWidth - 48),
    height: Math.min(860, window.innerHeight - 48),
  };
}

function clampSize(size: Size): Size {
  if (typeof window === "undefined") return size;
  return {
    width: Math.max(MIN_WIDTH, Math.min(size.width, window.innerWidth - VIEWPORT_INSET)),
    height: Math.max(MIN_HEIGHT, Math.min(size.height, window.innerHeight - VIEWPORT_INSET)),
  };
}

function centeredPosition(size: Size): Position {
  if (typeof window === "undefined") return { x: 0, y: 0 };
  return {
    x: Math.max(VIEWPORT_INSET / 2, Math.round((window.innerWidth - size.width) / 2)),
    y: Math.max(VIEWPORT_INSET / 2, Math.round((window.innerHeight - size.height) / 2)),
  };
}

function clampPosition(position: Position, size: Size): Position {
  if (typeof window === "undefined") return position;
  // Keep the title bar reachable: at least DRAG_KEEP_VISIBLE px of the
  // dialog must stay on each axis, and we never let the top edge fall
  // above the viewport.
  const minX = DRAG_KEEP_VISIBLE - size.width;
  const maxX = window.innerWidth - DRAG_KEEP_VISIBLE;
  const minY = 0;
  const maxY = window.innerHeight - DRAG_KEEP_VISIBLE;
  return {
    x: Math.min(maxX, Math.max(minX, position.x)),
    y: Math.min(maxY, Math.max(minY, position.y)),
  };
}

type ResizeDirection = "se" | "sw" | "ne" | "nw";

export function DocumentPreviewDialog({
  document,
  onOpenChange,
}: {
  document: Document | null;
  onOpenChange: (open: boolean) => void;
}) {
  const loadPage = usePDFViewerStore((state) => state.loadPage);
  const closeStore = usePDFViewerStore((state) => state.close);
  const {
    handleOpenChange,
    handlePointerDownOutside,
    handleEscapeKeyDown,
    handleFocusOutside,
    handleInteractOutside,
    requestClose,
  } = useDialogDismiss(() => onOpenChange(false));

  // Initialise size from localStorage (so the user's preferred size
  // sticks across opens) clamped to the current viewport. Position
  // always centres on first open — feels more predictable than
  // restoring a stale screen coordinate that might be on a monitor
  // that's no longer attached.
  const [size, setSize] = useState<Size>(() => {
    const stored = readStoredSize();
    return clampSize(stored ?? defaultSize());
  });
  const [position, setPosition] = useState<Position>(() => {
    const stored = readStoredSize();
    return centeredPosition(clampSize(stored ?? defaultSize()));
  });
  const [maximized, setMaximized] = useState(false);
  // Track whether the user is mid-drag/resize so we can suppress
  // text selection and lock pointer style at the body level.
  const [interacting, setInteracting] = useState<null | "drag" | ResizeDirection>(null);
  // Remember the pre-maximize geometry so Restore goes back where the
  // user had it.
  const preMaxRef = useRef<{ size: Size; position: Position } | null>(null);

  // Persist size on change (but not the transient maximized one).
  useEffect(() => {
    if (typeof window === "undefined" || maximized) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(size));
    } catch {
      /* ignore quota errors */
    }
  }, [size, maximized]);

  // Keep the dialog usable when the browser is resized — clamp both
  // size and position to the new viewport.
  useEffect(() => {
    const onResize = () => {
      setSize((current) => clampSize(current));
      setPosition((current) => clampPosition(current, size));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [size]);

  // Push the picked document into the shared viewer store when the
  // dialog opens; tear it down on close so the chat panel doesn't
  // keep showing the doc the user just dismissed. Also re-centre on
  // open so each library click feels predictable.
  useEffect(() => {
    if (!document) return;
    void loadPage(document, 1, []);
    setPosition((current) => {
      // If the dialog was already open and the user had moved it, leave
      // the position alone. Only re-centre when first opening (i.e.
      // we're transitioning from "no document" to "document").
      return current;
    });
    return () => {
      closeStore();
    };
  }, [document, loadPage, closeStore]);

  // Re-centre whenever the dialog opens fresh.
  useEffect(() => {
    if (!document) return;
    setPosition(centeredPosition(size));
    setMaximized(false);
    // Intentionally only re-run on document identity (open events),
    // not on every size change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document]);

  const startDrag = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (maximized) return;
      // Don't intercept clicks on buttons inside the title bar.
      const target = event.target as HTMLElement;
      if (target.closest("button")) return;
      event.preventDefault();
      const startMouseX = event.clientX;
      const startMouseY = event.clientY;
      const startPos = position;

      setInteracting("drag");
      const previousCursor = window.document.body.style.cursor;
      const previousSelect = window.document.body.style.userSelect;
      window.document.body.style.cursor = "grabbing";
      window.document.body.style.userSelect = "none";

      const onMove = (moveEvent: MouseEvent) => {
        setPosition(
          clampPosition(
            {
              x: startPos.x + (moveEvent.clientX - startMouseX),
              y: startPos.y + (moveEvent.clientY - startMouseY),
            },
            size,
          ),
        );
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
    },
    [maximized, position, size],
  );

  // Drag resize from a corner. Position-aware: the corner the user
  // grabs follows their mouse, the *opposite* corner stays pinned.
  // This is what every native window does, and it requires updating
  // both position and size for the n/w directions.
  const startResize = useCallback(
    (direction: ResizeDirection) =>
      (event: React.MouseEvent<HTMLDivElement>) => {
        if (maximized) return;
        event.preventDefault();
        event.stopPropagation();
        const startMouseX = event.clientX;
        const startMouseY = event.clientY;
        const startSize = size;
        const startPos = position;

        setInteracting(direction);
        const cursorStyle =
          direction === "se" || direction === "nw" ? "nwse-resize" : "nesw-resize";
        const previousCursor = window.document.body.style.cursor;
        const previousSelect = window.document.body.style.userSelect;
        window.document.body.style.cursor = cursorStyle;
        window.document.body.style.userSelect = "none";

        const onMove = (moveEvent: MouseEvent) => {
          const dx = moveEvent.clientX - startMouseX;
          const dy = moveEvent.clientY - startMouseY;
          let nextW = startSize.width;
          let nextH = startSize.height;
          let nextX = startPos.x;
          let nextY = startPos.y;
          if (direction.includes("e")) nextW = startSize.width + dx;
          if (direction.includes("s")) nextH = startSize.height + dy;
          if (direction.includes("w")) {
            nextW = startSize.width - dx;
            nextX = startPos.x + dx;
          }
          if (direction.includes("n")) {
            nextH = startSize.height - dy;
            nextY = startPos.y + dy;
          }
          // Clamp width/height. When shrinking via a top/left edge we
          // also clamp the matching position so the opposite corner
          // stays pinned.
          const maxW = window.innerWidth - VIEWPORT_INSET;
          const maxH = window.innerHeight - VIEWPORT_INSET;
          if (nextW < MIN_WIDTH) {
            if (direction.includes("w")) nextX -= MIN_WIDTH - nextW;
            nextW = MIN_WIDTH;
          }
          if (nextW > maxW) {
            if (direction.includes("w")) nextX += nextW - maxW;
            nextW = maxW;
          }
          if (nextH < MIN_HEIGHT) {
            if (direction.includes("n")) nextY -= MIN_HEIGHT - nextH;
            nextH = MIN_HEIGHT;
          }
          if (nextH > maxH) {
            if (direction.includes("n")) nextY += nextH - maxH;
            nextH = maxH;
          }
          setSize({ width: nextW, height: nextH });
          setPosition({ x: nextX, y: nextY });
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
      },
    [maximized, position, size],
  );

  const toggleMaximize = useCallback(() => {
    if (maximized) {
      const restored = preMaxRef.current;
      preMaxRef.current = null;
      setMaximized(false);
      if (restored) {
        setSize(restored.size);
        setPosition(restored.position);
      }
    } else {
      preMaxRef.current = { size, position };
      setMaximized(true);
    }
  }, [maximized, size, position]);

  // Double-click the drag bar to toggle maximize, just like every
  // desktop window manager.
  const onDragBarDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest("button")) return;
      toggleMaximize();
    },
    [toggleMaximize],
  );

  // Effective rendered geometry (maximized fills viewport with inset).
  const renderedSize: Size = maximized
    ? typeof window !== "undefined"
      ? { width: window.innerWidth - VIEWPORT_INSET, height: window.innerHeight - VIEWPORT_INSET }
      : size
    : size;
  const renderedPos: Position = maximized
    ? { x: VIEWPORT_INSET / 2, y: VIEWPORT_INSET / 2 }
    : position;

  const resizeHandleClass = (cursor: string, edge: string) =>
    `absolute z-40 ${edge} ${cursor} ${maximized ? "pointer-events-none opacity-0" : ""}`;

  return (
    <Dialog.Root open={document !== null} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[70] bg-black/18 backdrop-blur-[18px]"
          onDoubleClick={requestClose}
        />
        <Dialog.Content
          aria-describedby={undefined}
          style={{
            left: renderedPos.x,
            top: renderedPos.y,
            width: renderedSize.width,
            height: renderedSize.height,
          }}
          className={`fixed z-[80] flex flex-col overflow-hidden rounded-[30px] border border-black/[0.06] bg-panel shadow-[0_24px_60px_rgba(17,17,17,0.12)] outline-none ${
            interacting ? "select-none" : ""
          }`}
          onPointerDownOutside={handlePointerDownOutside}
          onEscapeKeyDown={handleEscapeKeyDown}
          onFocusOutside={handleFocusOutside}
          onInteractOutside={handleInteractOutside}
        >
          <Dialog.Title className="sr-only">
            {document?.filename ?? "PDF Preview"}
          </Dialog.Title>
          {/* Window-style title bar. Left: grip + drag-anywhere area.
              Right: maximize + close. Double-click anywhere on the
              bar (except buttons) to toggle maximize. */}
          <div
            onMouseDown={startDrag}
            onDoubleClick={onDragBarDoubleClick}
            className={`relative flex h-9 shrink-0 items-center justify-end border-b border-black/[0.06] bg-[#f7f7f6] px-2 ${
              maximized ? "cursor-default" : "cursor-grab active:cursor-grabbing"
            }`}
          >
            {/* Centered "drag to move" label sits in an absolute layer
                so it lines up with the dialog midpoint regardless of
                what's on either side. pointer-events-none lets the
                drag handler on the parent still receive the mouse. */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted/70">
              <GripHorizontal className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              <span className="select-none text-[10px] font-medium uppercase tracking-[0.18em]">
                Drag to move
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label={maximized ? "Restore size" : "Maximize"}
                title={maximized ? "Restore size" : "Maximize"}
                onClick={toggleMaximize}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-muted transition hover:border-black/[0.10] hover:bg-white hover:text-ink"
              >
                {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                aria-label="Close preview"
                onClick={requestClose}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-muted transition hover:border-black/[0.10] hover:bg-white hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            {document ? <PDFViewer /> : null}
          </div>
          {/* Corner resize handles. Invisible — the cursor change on
              hover is the affordance, same pattern Notion / Figma /
              Slack use. Generous 22px target so they're easy to grab
              even against the 30px corner radius. */}
          <div
            aria-hidden="true"
            onMouseDown={startResize("se")}
            className={resizeHandleClass(
              "cursor-nwse-resize",
              "bottom-0 right-0 h-[22px] w-[22px]",
            )}
          />
          <div
            aria-hidden="true"
            onMouseDown={startResize("sw")}
            className={resizeHandleClass(
              "cursor-nesw-resize",
              "bottom-0 left-0 h-[22px] w-[22px]",
            )}
          />
          <div
            aria-hidden="true"
            onMouseDown={startResize("ne")}
            className={resizeHandleClass(
              "cursor-nesw-resize",
              "top-0 right-0 h-[22px] w-[22px]",
            )}
          />
          <div
            aria-hidden="true"
            onMouseDown={startResize("nw")}
            className={resizeHandleClass(
              "cursor-nwse-resize",
              "top-0 left-0 h-[22px] w-[22px]",
            )}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
