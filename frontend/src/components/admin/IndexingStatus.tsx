"use client";

import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { Document, DocumentStatusValue } from "@/lib/types";
import { formatBytes, statusLabel } from "@/lib/utils";
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
}: {
  document: Document;
  groupId: string;
}) {
  const deleteDocument = useDocumentStore((state) => state.deleteDocument);
  const reindexDocument = useDocumentStore((state) => state.reindexDocument);
  const statusOverride = useDocumentStore((state) => state.documentStatuses[document.id]);

  const status = statusOverride?.status ?? document.status;
  const Icon = iconByStatus[status];
  const isProcessing = !["ready", "failed"].includes(status);

  return (
    <div className="rounded-[24px] border border-line bg-panel/80 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-ink">{document.filename}</p>
          <p className="mt-1 text-xs text-muted">
            {formatBytes(document.file_size_bytes)} · {document.page_count ?? "?"} pages
          </p>
        </div>
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
      {document.error_detail ? <p className="mt-2 text-xs text-danger">{document.error_detail}</p> : null}
      <div className="mt-4 flex items-center gap-2">
        {status === "failed" ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => void reindexDocument(document.id)}>
            <RotateCcw className="h-3.5 w-3.5" />
            Retry
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            if (window.confirm("Delete this document from the group?")) {
              void deleteDocument(document.id, groupId);
            }
          }}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}
