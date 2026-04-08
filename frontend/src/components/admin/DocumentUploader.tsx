"use client";

import { useCallback } from "react";
import { FileUp } from "lucide-react";
import { useDropzone } from "react-dropzone";

import { IndexingStatus } from "@/components/admin/IndexingStatus";
import { Button } from "@/components/ui/button";
import { useDocumentStore } from "@/stores/documentStore";

export function DocumentUploader({ groupId }: { groupId: string }) {
  const uploadDocument = useDocumentStore((state) => state.uploadDocument);
  const documents = useDocumentStore((state) => state.documentsByGroup[groupId] ?? []);
  const uploadStates = useDocumentStore((state) => state.uploadStates);

  const onDrop = useCallback(
    (files: File[]) => {
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

  return (
    <div className="space-y-4">
      <div
        {...getRootProps()}
        className={`rounded-[26px] border border-dashed p-5 text-center transition ${
          isDragActive ? "border-accent bg-accentSoft/50" : "border-line bg-white/50"
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
              Upload calculation manuals, scans, handbooks, and datasheets.
            </p>
          </div>
          <Button type="button" variant="secondary" onClick={open}>
            Choose files
          </Button>
        </div>
      </div>

      {uploadStates.length ? (
        <div className="space-y-2">
          {uploadStates.map((upload) => (
            <div key={`${upload.fileName}-${upload.documentId ?? "pending"}`} className="rounded-[22px] border border-line bg-panel/80 p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">{upload.fileName}</span>
                <span className="text-xs text-muted">{upload.status}</span>
              </div>
              <div className="mt-2 h-2 rounded-full bg-black/5">
                <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${upload.progress}%` }} />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="space-y-3">
        {documents.map((document) => (
          <IndexingStatus key={document.id} document={document} groupId={groupId} />
        ))}
      </div>
    </div>
  );
}
