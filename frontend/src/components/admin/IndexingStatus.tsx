"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, Upload } from "lucide-react";

import { DeleteConfirmDialog } from "@/components/shared/DeleteConfirmDialog";
import { Button } from "@/components/ui/button";
import type { Document, DocumentStatusValue } from "@/lib/types";
import { documentProgressLabel, formatBytes, statusLabel } from "@/lib/utils";
import { useDocumentStore } from "@/stores/documentStore";

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
}: {
  document: Document;
  groupId: string;
  onOpen?: (document: Document) => void;
}) {
  const deleteDocument = useDocumentStore((state) => state.deleteDocument);
  const reindexDocument = useDocumentStore((state) => state.reindexDocument);
  const statusOverride = useDocumentStore((state) => state.documentStatuses[document.id]);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const status = statusOverride?.status ?? document.status;
  const progressCurrent = statusOverride?.progress_current ?? document.progress_current;
  const progressTotal = statusOverride?.progress_total ?? document.progress_total;
  const currentStage = statusOverride?.current_stage ?? document.current_stage;
  const errorDetail = statusOverride?.error_detail ?? document.error_detail;
  const Icon = iconByStatus[status];
  const isProcessing = !["ready", "failed"].includes(status);
  const isPreviewable = status === "ready" && (document.page_count ?? 0) > 0 && !!onOpen;
  const progressLabel = documentProgressLabel(progressCurrent, progressTotal);

  return (
    <div className="rounded-[24px] border border-line bg-panel/80 p-4">
      <div className="flex items-start justify-between gap-4">
        <button
          type="button"
          className={`min-w-0 text-left ${isPreviewable ? "cursor-pointer transition hover:opacity-80" : "cursor-default"}`}
          onClick={() => {
            if (isPreviewable) {
              onOpen(document);
            }
          }}
          disabled={!isPreviewable}
        >
          <p className="truncate text-sm font-semibold text-ink">{document.filename}</p>
          <p className="mt-1 text-xs text-muted">
            {formatBytes(document.file_size_bytes)} · {document.page_count ?? "?"} pages
            {isPreviewable ? " · Open preview" : ""}
          </p>
        </button>
        <div
          className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${
            status === "ready"
              ? "bg-success/10 text-success"
              : status === "failed"
                ? "bg-danger/10 text-danger"
                : "bg-accentSoft text-accent"
          }`}
        >
          <Icon className={`h-3.5 w-3.5 ${isProcessing ? "animate-spin" : ""}`} />
          {statusLabel(status)}
        </div>
      </div>
      {isProcessing && progressLabel ? (
        <p className="mt-2 text-xs text-muted">
          {statusLabel((currentStage ?? status) as DocumentStatusValue)} · {progressLabel}
        </p>
      ) : null}
      {errorDetail ? <p className="mt-2 text-xs text-danger">{errorDetail}</p> : null}
      <div className="mt-4 flex items-center gap-2">
        {status === "failed" ? (
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
          onClick={(event) => {
            event.stopPropagation();
            setDeleteOpen(true);
          }}
        >
          Delete
        </Button>
      </div>
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
