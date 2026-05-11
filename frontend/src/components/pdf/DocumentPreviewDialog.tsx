"use client";

import * as Dialog from "@radix-ui/react-dialog";
import dynamic from "next/dynamic";
import { useEffect } from "react";
import { X } from "lucide-react";

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

  // Push the picked document into the shared viewer store when the
  // dialog opens; tear it down on close so the chat panel doesn't
  // keep showing the doc the user just dismissed.
  useEffect(() => {
    if (!document) {
      return;
    }
    void loadPage(document, 1, []);
    return () => {
      closeStore();
    };
  }, [document, loadPage, closeStore]);

  return (
    <Dialog.Root open={document !== null} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[70] bg-black/18 backdrop-blur-[18px]"
          onDoubleClick={requestClose}
        />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[80] flex h-[min(860px,calc(100vh-3rem))] w-[min(1180px,calc(100vw-3rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden border border-black/[0.08] bg-white shadow-[0_18px_48px_rgba(15,23,42,0.10)] outline-none"
          onPointerDownOutside={handlePointerDownOutside}
          onEscapeKeyDown={handleEscapeKeyDown}
          onFocusOutside={handleFocusOutside}
          onInteractOutside={handleInteractOutside}
        >
          <Dialog.Title className="sr-only">
            {document?.filename ?? "PDF Preview"}
          </Dialog.Title>
          {/* Floating close button — the embedded PDFViewer's toolbar
              doesn't ship its own close action, so this is the explicit
              way out beyond ESC / click-outside. */}
          <button
            type="button"
            aria-label="Close preview"
            onClick={requestClose}
            className="absolute right-3 top-3 z-50 inline-flex h-9 w-9 items-center justify-center rounded-full border border-black/[0.10] bg-white text-muted shadow-md transition hover:bg-black hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="min-h-0 flex-1">
            {document ? <PDFViewer /> : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
