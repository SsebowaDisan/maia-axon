"use client";

import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Network, RotateCcw, Upload } from "lucide-react";

import { DeleteConfirmDialog } from "@/components/shared/DeleteConfirmDialog";
import { Button } from "@/components/ui/button";
import { prefetchPdfFile } from "@/lib/api";
import type { Document, DocumentStatusValue } from "@/lib/types";
import { documentProgressLabel, formatBytes, statusLabel } from "@/lib/utils";
import { useDocumentStore } from "@/stores/documentStore";
import { usePDFViewerStore } from "@/stores/pdfViewerStore";

const iconByStatus: Record<DocumentStatusValue, React.ComponentType<{ className?: string }>> = {
  uploading: Upload,
  splitting: Loader2,
  glm_ocr: Loader2,
  captioning: Loader2,
  embedding: Loader2,
  ready: CheckCircle2,
  failed: AlertTriangle,
};

export function IndexingStatus({
  document,
  groupId,
  onOpen,
  readOnly = false,
}: {
  document: Document;
  groupId: string;
  onOpen?: (document: Document) => void;
  // When true (non-admin library view), the Delete and Retry actions
  // are hidden so the card becomes a pure click-to-read row. Backend
  // already enforces admin-only on those endpoints, so this is purely
  // a UI cleanup.
  readOnly?: boolean;
}) {
  const deleteDocument = useDocumentStore((state) => state.deleteDocument);
  const isDeleted = useDocumentStore((state) => !!state.deletedDocumentIds[document.id]);
  const reindexDocument = useDocumentStore((state) => state.reindexDocument);
  const statusOverride = useDocumentStore((state) => state.documentStatuses[document.id]);
  const setPendingAutoOpen = usePDFViewerStore((state) => state.setPendingAutoOpen);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Hover-prefetch debounce: only kick off a PDF download if the
  // pointer has been on the card for > 220ms. Below that the user
  // is just sweeping the cursor across the library list and we
  // don't want to burn bandwidth on every card they pass over.
  const prefetchTimer = useRef<number | null>(null);

  const status = statusOverride?.status ?? document.status;
  const progressCurrent = statusOverride?.progress_current ?? document.progress_current;
  const progressTotal = statusOverride?.progress_total ?? document.progress_total;
  const currentStage = statusOverride?.current_stage ?? document.current_stage;
  const errorDetail = statusOverride?.error_detail ?? document.error_detail;
  const Icon = iconByStatus[status];
  const isProcessing = !["ready", "failed"].includes(status) && !isDeleted;
  const isPreviewable = status === "ready" && (document.page_count ?? 0) > 0 && !!onOpen && !isDeleted;
  const progressLabel = documentProgressLabel(progressCurrent, progressTotal);
  const hasMindmap = (document.section_count ?? 0) > 0 && isPreviewable;

  const startHoverPrefetch = () => {
    if (!isPreviewable) return;
    if (prefetchTimer.current !== null) return;
    prefetchTimer.current = window.setTimeout(() => {
      void prefetchPdfFile(document.id);
      prefetchTimer.current = null;
    }, 220);
  };
  const cancelHoverPrefetch = () => {
    if (prefetchTimer.current !== null) {
      window.clearTimeout(prefetchTimer.current);
      prefetchTimer.current = null;
    }
  };

  return (
    <div
      className={`rounded-[24px] border p-4 ${isDeleted ? "border-danger/20 bg-danger/5 opacity-70" : "border-line bg-panel/80"}`}
      onMouseEnter={startHoverPrefetch}
      onMouseLeave={cancelHoverPrefetch}
    >
      <div className="flex items-start justify-between gap-4">
        <button
          type="button"
          className={`min-w-0 text-left ${isPreviewable ? "cursor-pointer transition hover:opacity-80" : "cursor-default"}`}
          onClick={() => {
            if (isPreviewable && onOpen) {
              // Kick the PDF fetch off immediately so pdf.js finds
              // the response in the HTTP cache when the dialog mounts.
              void prefetchPdfFile(document.id);
              onOpen(document);
            }
          }}
          disabled={!isPreviewable}
        >
          <p className="truncate text-sm font-semibold text-ink">{isDeleted ? "Deleted" : document.filename}</p>
          <p className="mt-1 text-xs text-muted">
            {isDeleted
              ? "Deleting..."
              : `${formatBytes(document.file_size_bytes)} · ${document.page_count ?? "?"} pages${isPreviewable ? " · Open preview" : ""}`}
          </p>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {hasMindmap ? (
            <button
              type="button"
              title="This book has a mindmap. Click to open it."
              aria-label="Open mindmap for this book"
              onClick={(event) => {
                event.stopPropagation();
                if (!onOpen) return;
                // Set the auto-open flag BEFORE triggering the open so
                // the PDFViewer's effect picks it up on first mount.
                setPendingAutoOpen("mindmap");
                onOpen(document);
              }}
              className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accentSoft/70 px-2 py-1 text-[11px] font-medium text-accent transition hover:bg-accent hover:text-white"
            >
              <Network className="h-3 w-3" />
              Mindmap
            </button>
          ) : null}
          <div
            className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${
              isDeleted
                ? "bg-danger/10 text-danger"
                : status === "ready"
                  ? "bg-success/10 text-success"
                  : status === "failed"
                    ? "bg-danger/10 text-danger"
                    : "bg-accentSoft text-accent"
            }`}
          >
            <Icon className={`h-3.5 w-3.5 ${isProcessing ? "animate-spin" : ""}`} />
            {isDeleted ? "Deleted" : statusLabel(status)}
          </div>
        </div>
      </div>
      {isProcessing && progressLabel ? (
        <p className="mt-2 text-xs text-muted">
          {statusLabel((currentStage ?? status) as DocumentStatusValue)} · {progressLabel}
        </p>
      ) : null}
      {errorDetail ? <p className="mt-2 text-xs text-danger">{errorDetail}</p> : null}
      {!readOnly ? (
        <div className="mt-4 flex items-center gap-2">
          {status === "failed" && !isDeleted ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={(event) => {
                event.stopPropagation();
                void reindexDocument(document.id);
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Retry
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={isDeleted}
            onClick={(event) => {
              event.stopPropagation();
              setDeleteOpen(true);
            }}
          >
            Delete
          </Button>
        </div>
      ) : null}
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete document"
        description={
          <>
            Type <span className="font-semibold text-ink">delete</span> to remove{" "}
            <span className="font-semibold text-ink">{document.filename}</span>.
          </>
        }
        confirmLabel="Delete document"
        isDeleting={deleting}
        onConfirm={async () => {
          setDeleting(true);
          try {
            await deleteDocument(document.id, groupId);
            setDeleteOpen(false);
          } finally {
            setDeleting(false);
          }
        }}
      />
    </div>
  );
}
