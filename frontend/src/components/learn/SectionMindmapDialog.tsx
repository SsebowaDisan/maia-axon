"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Network, X } from "lucide-react";

import { SectionMindmapCanvas } from "./SectionMindmapCanvas";

interface Props {
  documentId: string;
  documentName: string;
  open: boolean;
  onClose: () => void;
  onJumpToPage: (page: number) => void;
  onLearnSection?: (sectionId: string, title: string) => void;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Reasonable defaults — about 80% of a 14" laptop viewport, centred.
function defaultBox(): Box {
  if (typeof window === "undefined") {
    return { x: 60, y: 60, width: 1000, height: 640 };
  }
  const w = Math.min(window.innerWidth * 0.82, 1200);
  const h = Math.min(window.innerHeight * 0.78, 760);
  return {
    x: Math.max(20, (window.innerWidth - w) / 2),
    y: Math.max(20, (window.innerHeight - h) / 2),
    width: w,
    height: h,
  };
}

function clampBox(box: Box): Box {
  if (typeof window === "undefined") return box;
  const minW = 480;
  const minH = 360;
  const width = Math.max(minW, Math.min(box.width, window.innerWidth - 20));
  const height = Math.max(minH, Math.min(box.height, window.innerHeight - 20));
  const x = Math.max(0, Math.min(box.x, window.innerWidth - width));
  const y = Math.max(0, Math.min(box.y, window.innerHeight - height));
  return { x, y, width, height };
}

export function SectionMindmapDialog({
  documentId,
  documentName,
  open,
  onClose,
  onJumpToPage,
  onLearnSection,
}: Props) {
  const [box, setBox] = useState<Box>(() => defaultBox());
  const [maximized, setMaximized] = useState(false);
  // Stash the floating box when maximised so we can restore it.
  const restoreBox = useRef<Box | null>(null);

  // Re-centre on first open after the doc changes.
  useEffect(() => {
    if (open) {
      setBox((prev) => clampBox(prev));
    }
  }, [open]);

  // ---- Drag the title bar ----
  const dragStart = useRef<{ x: number; y: number; box: Box } | null>(null);

  const onDragStart = useCallback(
    (e: React.PointerEvent) => {
      // Only the title-bar surface initiates drag — buttons inside
      // it stopPropagation so they keep working.
      if (maximized) return;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      dragStart.current = { x: e.clientX, y: e.clientY, box };
    },
    [box, maximized],
  );

  const onDragMove = useCallback((e: React.PointerEvent) => {
    if (!dragStart.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setBox(
      clampBox({
        x: dragStart.current.box.x + dx,
        y: dragStart.current.box.y + dy,
        width: dragStart.current.box.width,
        height: dragStart.current.box.height,
      }),
    );
  }, []);

  const onDragEnd = useCallback(() => {
    dragStart.current = null;
  }, []);

  // ---- Resize from the bottom-right corner ----
  const resizeStart = useRef<{ x: number; y: number; box: Box } | null>(null);

  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      if (maximized) return;
      e.stopPropagation();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      resizeStart.current = { x: e.clientX, y: e.clientY, box };
    },
    [box, maximized],
  );

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    if (!resizeStart.current) return;
    const dx = e.clientX - resizeStart.current.x;
    const dy = e.clientY - resizeStart.current.y;
    setBox(
      clampBox({
        x: resizeStart.current.box.x,
        y: resizeStart.current.box.y,
        width: resizeStart.current.box.width + dx,
        height: resizeStart.current.box.height + dy,
      }),
    );
  }, []);

  const onResizeEnd = useCallback(() => {
    resizeStart.current = null;
  }, []);

  const toggleMaximize = () => {
    if (maximized) {
      setMaximized(false);
      if (restoreBox.current) {
        setBox(clampBox(restoreBox.current));
        restoreBox.current = null;
      }
    } else {
      restoreBox.current = box;
      setMaximized(true);
    }
  };

  // Esc closes the dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const style: React.CSSProperties = maximized
    ? { left: 0, top: 0, width: "100vw", height: "100vh" }
    : { left: box.x, top: box.y, width: box.width, height: box.height };

  return (
    // Backdrop is intentionally non-blocking — users can interact with
    // the PDF underneath while the mindmap floats above. Click-outside
    // does NOT close, so opening the mindmap doesn't dismiss the PDF
    // reading flow.
    <div
      className="pointer-events-none fixed inset-0 z-40"
      aria-hidden={!open}
    >
      <div
        className="pointer-events-auto absolute flex flex-col overflow-hidden rounded-[22px] border border-black/[0.08] bg-panel shadow-[0_30px_60px_rgba(17,17,17,0.18)]"
        style={style}
        role="dialog"
        aria-label={`Mindmap for ${documentName}`}
      >
        <div
          className="flex shrink-0 cursor-move select-none items-center justify-between gap-3 border-b border-black/[0.05] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(244,243,239,0.95))] px-4 py-2"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        >
          <div className="flex min-w-0 items-center gap-2">
            <Network className="h-4 w-4 text-accent" />
            <p className="truncate text-[13px] font-semibold text-ink">
              Mindmap · {documentName}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={toggleMaximize}
              className="rounded-full p-1 text-black/55 hover:bg-black/[0.05] hover:text-black"
              aria-label={maximized ? "Restore size" : "Maximize"}
              title={maximized ? "Restore" : "Maximize"}
            >
              {maximized ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onClose}
              className="rounded-full p-1 text-black/55 hover:bg-black/[0.05] hover:text-black"
              aria-label="Close mindmap"
              title="Close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 bg-[#f7f6f2]">
          <SectionMindmapCanvas
            documentId={documentId}
            documentName={documentName}
            onJumpToPage={onJumpToPage}
            onLearnSection={onLearnSection}
          />
        </div>
        {!maximized ? (
          <div
            className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
            onPointerDown={onResizeStart}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeEnd}
            onPointerCancel={onResizeEnd}
            // Visual hint (two diagonal lines) at the resize handle.
            style={{
              backgroundImage:
                "linear-gradient(135deg, transparent 35%, rgba(0,0,0,0.18) 35%, rgba(0,0,0,0.18) 45%, transparent 45%, transparent 60%, rgba(0,0,0,0.18) 60%, rgba(0,0,0,0.18) 70%, transparent 70%)",
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
