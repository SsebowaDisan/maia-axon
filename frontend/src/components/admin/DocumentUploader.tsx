"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FileUp, Plus, X } from "lucide-react";
import { useDropzone } from "react-dropzone";

import { IndexingStatus } from "@/components/admin/IndexingStatus";
import { DocumentPreviewDialog } from "@/components/pdf/DocumentPreviewDialog";
import { Button } from "@/components/ui/button";
import type { Document } from "@/lib/types";
import { useDocumentStore } from "@/stores/documentStore";

export function DocumentUploader({ groupId }: { groupId: string | null }) {
  const uploadDocument = useDocumentStore((state) => state.uploadDocument);
  const documentsByGroup = useDocumentStore((state) => state.documentsByGroup);
  const uploadStates = useDocumentStore((state) => state.uploadStates);
  const documentStatuses = useDocumentStore((state) => state.documentStatuses);
  const documents = useMemo(
    () => (groupId ? documentsByGroup[groupId] ?? [] : []),
    [documentsByGroup, groupId],
  );
  const uploadEnabled = !!groupId;
  const activeUploads = useMemo(
    () =>
      uploadStates
        .filter(
          (upload) => !upload.documentId || documents.some((document) => document.id === upload.documentId),
        )
        .map((upload) => {
          if (!upload.documentId) {
            return upload;
          }
          const document = documents.find((entry) => entry.id === upload.documentId);
          const backendStatus = documentStatuses[upload.documentId]?.status ?? document?.status;
          const backendError = documentStatuses[upload.documentId]?.error_detail ?? document?.error_detail ?? upload.error;

          if (!backendStatus) {
            return upload;
          }

          return {
            ...upload,
            status:
              backendStatus === "failed"
                ? "failed"
                : backendStatus === "ready"
                  ? "done"
                  : "processing",
            progress: backendStatus === "ready" ? 100 : Math.max(upload.progress, 100),
            error: backendError ?? upload.error,
          };
        })
        .filter((upload) => upload.status !== "done"),
    [documentStatuses, documents, uploadStates],
  );

  const [previewDocument, setPreviewDocument] = useState<Document | null>(null);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [pendingAutoCloseFiles, setPendingAutoCloseFiles] = useState<string[]>([]);

  useEffect(() => {
    if (!uploadDialogOpen || pendingAutoCloseFiles.length === 0) {
      return;
    }

    const startedProcessing = uploadStates.some(
      (upload) =>
        pendingAutoCloseFiles.includes(upload.fileName) &&
        upload.status === "processing",
    );

    if (startedProcessing) {
      setUploadDialogOpen(false);
      setPendingAutoCloseFiles([]);
    }
  }, [pendingAutoCloseFiles, uploadDialogOpen, uploadStates]);

  const onDrop = useCallback(
    (files: File[]) => {
      if (!groupId) {
        return;
      }
      if (files.length > 0) {
        setPendingAutoCloseFiles(files.map((file) => file.name));
      }
      files.forEach((file) => {
        void uploadDocument(groupId, file);
      });
    },
    [groupId, uploadDocument],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    accept: { "application/pdf": [".pdf"] },
    onDrop,
    noClick: true,
  });

  const uploadStatusLabel = (status: string, error?: string) => {
    if (status === "failed") {
      return error ?? "failed";
    }
    if (status === "processing") {
      return "processing";
    }
    return status;
  };

  return (
    <>
      <div className="flex h-full min-h-0 flex-col gap-4">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[28px] border border-black/[0.06] bg-black/[0.02]">
          <div className="flex items-center justify-between gap-3 border-b border-black/[0.06] px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-ink">PDF Library</p>
              <p className="mt-1 text-xs text-muted">
                {uploadEnabled
                  ? "Click a PDF to open a preview."
                  : "Select a project first, then use + to upload PDFs."}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="icon"
                variant="secondary"
                className="rounded-full"
                onClick={() => setUploadDialogOpen(true)}
                disabled={!uploadEnabled}
                title={uploadEnabled ? "Upload PDFs" : "Select a project first"}
                aria-label={uploadEnabled ? "Upload PDFs" : "Select a project first"}
              >
                <Plus className="h-4 w-4" />
              </Button>
              <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-ink shadow-[0_4px_12px_rgba(17,17,17,0.05)]">
                {documents.length} PDFs
              </span>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pr-3 scrollbar-thin">
            {documents.length ? (
              <div className="space-y-3">
                {documents.map((document) => (
                  <IndexingStatus
                    key={document.id}
                    document={document}
                    groupId={groupId ?? ""}
                    onOpen={(selected) => setPreviewDocument(selected)}
                  />
                ))}
              </div>
            ) : (
              <div className="flex h-full min-h-[220px] items-center justify-center rounded-[22px] border border-dashed border-line bg-white/55 px-6 text-center text-sm text-muted">
                No PDFs in this project yet.
              </div>
            )}
          </div>
        </div>
      </div>

      <Dialog.Root open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/18 backdrop-blur-[18px]" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-[80] w-[min(620px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[30px] border border-black/[0.06] bg-white p-6 shadow-[0_24px_60px_rgba(17,17,17,0.12)] outline-none"
            onPointerDownOutside={() => setUploadDialogOpen(false)}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="font-display text-[1.5rem] font-semibold tracking-[-0.04em] text-ink">
                  Upload PDFs
                </Dialog.Title>
                <p className="mt-2 text-sm leading-6 text-muted">
                  {uploadEnabled
                    ? "Add PDFs to the selected project and prepare them for retrieval."
                    : "Select a project first. PDF upload stays disabled until a project is selected."}
                </p>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
                  aria-label="Close upload dialog"
                >
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>

            <div className="mt-5 space-y-4">
              <div
                {...getRootProps()}
                className={`rounded-[26px] border border-dashed p-6 text-center transition ${
                  !uploadEnabled
                    ? "border-black/[0.08] bg-black/[0.025] opacity-70"
                    : isDragActive
                      ? "border-accent bg-accentSoft/50"
                      : "border-line bg-white/50"
                }`}
              >
                <input {...getInputProps()} />
                <div className="mx-auto flex max-w-xs flex-col items-center gap-3">
                  <div className="rounded-full bg-accentSoft p-4 text-accent">
                    <FileUp className="h-6 w-6" />
                  </div>
                  <div>
                    <p className="font-medium text-ink">Drop PDFs here or browse</p>
                    <p className="mt-1 text-sm text-muted">
                      {uploadEnabled
                        ? "Upload calculation manuals, scans, handbooks, and datasheets."
                        : "Create or select a project first to unlock PDF upload."}
                    </p>
                  </div>
                  <Button type="button" variant="secondary" onClick={open} disabled={!uploadEnabled}>
                    Choose files
                  </Button>
                </div>
              </div>

              {activeUploads.length ? (
                <div className="rounded-[24px] border border-black/[0.06] bg-black/[0.02] p-3">
                  <div className="mb-3 flex items-center justify-between gap-3 px-1">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">Uploads</p>
                    <span className="text-xs text-muted">{activeUploads.length}</span>
                  </div>
                  <div className="max-h-40 space-y-2 overflow-y-auto pr-1 scrollbar-thin">
                    {activeUploads.map((upload) => (
                      <div
                        key={`${upload.fileName}-${upload.documentId ?? "pending"}-dialog`}
                        className="rounded-[22px] border border-line bg-panel/80 p-3"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-medium">{upload.fileName}</span>
                          <span className="text-xs text-muted">{uploadStatusLabel(upload.status, upload.error)}</span>
                        </div>
                        <div className="mt-2 h-2 rounded-full bg-black/5">
                          <div
                            className="h-full rounded-full bg-accent transition-all"
                            style={{ width: `${upload.progress}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <DocumentPreviewDialog
        document={previewDocument}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewDocument(null);
          }
        }}
      />
    </>
  );
}
