"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState } from "react";
import { Check, Copy, ExternalLink, FileText, TableProperties, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDialogDismiss } from "@/hooks/useDialogDismiss";
import type { ExportDestination } from "@/lib/types";
import { useExportDestinationStore } from "@/stores/exportDestinationStore";

function destinationLabel(type: "google_doc" | "google_sheet") {
  return type === "google_doc" ? "Google Docs" : "Google Sheets";
}

export function DestinationManagerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const destinations = useExportDestinationStore((state) => state.destinations);
  const serviceAccountEmail = useExportDestinationStore((state) => state.serviceAccountEmail);
  const loading = useExportDestinationStore((state) => state.loading);
  const fetchInfo = useExportDestinationStore((state) => state.fetchInfo);
  const fetchDestinations = useExportDestinationStore((state) => state.fetchDestinations);
  const saveDestination = useExportDestinationStore((state) => state.saveDestination);
  const deleteDestination = useExportDestinationStore((state) => state.deleteDestination);

  const [type, setType] = useState<"google_doc" | "google_sheet">("google_doc");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const {
    handleOpenChange,
    handlePointerDownOutside,
    handleEscapeKeyDown,
    handleFocusOutside,
    handleInteractOutside,
    requestClose,
  } = useDialogDismiss(() => onOpenChange(false));

  useEffect(() => {
    if (!open) {
      setFeedback(null);
      setError(null);
      setSubmitting(false);
      setDeletingId(null);
      setCopied(false);
      return;
    }

    void fetchInfo();
    void fetchDestinations();
  }, [fetchDestinations, fetchInfo, open]);

  const filteredDestinations = useMemo(
    () => destinations.filter((destination) => destination.type === type),
    [destinations, type],
  );

  async function handleCopyEmail() {
    if (!serviceAccountEmail) {
      return;
    }
    try {
      await navigator.clipboard.writeText(serviceAccountEmail);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setError("Could not copy the service email.");
    }
  }

  async function handleSaveDestination() {
    if (!url.trim()) {
      setError(`Paste a ${destinationLabel(type)} link first.`);
      return;
    }

    setSubmitting(true);
    setFeedback(null);
    setError(null);
    try {
      await saveDestination({
        type,
        title: title.trim() || null,
        url: url.trim(),
      });
      setFeedback(`${destinationLabel(type)} destination saved.`);
      setTitle("");
      setUrl("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not save destination");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(destinationId: string) {
    setDeletingId(destinationId);
    setError(null);
    try {
      await deleteDestination(destinationId);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not delete destination");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/18 backdrop-blur-[18px]" onDoubleClick={requestClose} />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[80] flex w-[min(920px,calc(100vw-2rem))] max-h-[min(860px,calc(100vh-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[32px] border border-black/[0.06] bg-white p-6 shadow-[0_24px_60px_rgba(17,17,17,0.12)] outline-none"
          onPointerDownOutside={handlePointerDownOutside}
          onEscapeKeyDown={handleEscapeKeyDown}
          onFocusOutside={handleFocusOutside}
          onInteractOutside={handleInteractOutside}
        >
          <div className="flex items-start justify-between gap-4 border-b border-black/[0.06] pb-5">
            <div className="flex items-center gap-4">
              <span className="rounded-full bg-black p-3 text-white">
                <TableProperties className="h-5 w-5" />
              </span>
              <div>
                <Dialog.Title className="font-display text-[1.75rem] font-semibold tracking-[-0.04em] text-ink">
                  Destinations
                </Dialog.Title>
                <p className="mt-1 text-sm text-muted">
                  Add Google Docs and Google Sheets destinations once, then reuse them from any answer.
                </p>
              </div>
            </div>
            <button
              type="button"
              className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
              aria-label="Close destinations"
              onClick={requestClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-5 grid min-h-0 flex-1 gap-5 overflow-hidden lg:grid-cols-[0.95fr_1.05fr]">
            <section className="min-h-0 space-y-4 overflow-y-auto pr-2 scrollbar-thin">
              <div className="rounded-[24px] border border-black/[0.06] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(247,247,246,0.94))] p-5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Step 1</p>
                <p className="mt-2 text-lg font-semibold tracking-[-0.03em] text-ink">Copy Maia Google access email</p>
                <p className="mt-2 text-sm leading-6 text-muted">
                  Use this same Maia email for Google Docs, Google Sheets, GA4, and Google Ads access.
                  Share Docs and Sheets with it as an editor before you save the file URL.
                </p>
                <div className="mt-4 rounded-[20px] border border-black/[0.06] bg-white px-4 py-4">
                  <p className="break-all text-sm text-ink">
                    {serviceAccountEmail || "Set GOOGLE_SERVICE_ACCOUNT_EMAIL on the backend to show Maia's Google access email."}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  className="mt-3"
                  disabled={!serviceAccountEmail}
                  onClick={() => void handleCopyEmail()}
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? "Copied" : "Copy Email"}
                </Button>
              </div>

              <div className="rounded-[24px] border border-black/[0.06] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(247,247,246,0.94))] p-5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Step 2</p>
                <p className="mt-2 text-lg font-semibold tracking-[-0.03em] text-ink">Add destination</p>
                <div className="mt-4 flex gap-2">
                  {(["google_doc", "google_sheet"] as const).map((option) => {
                    const active = type === option;
                    const Icon = option === "google_doc" ? FileText : TableProperties;
                    return (
                      <button
                        key={option}
                        type="button"
                        className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition ${
                          active
                            ? "border-black bg-black text-white"
                            : "border-black/[0.08] bg-white text-ink hover:bg-black/[0.03]"
                        }`}
                        onClick={() => setType(option)}
                      >
                        <Icon className="h-4 w-4" />
                        {destinationLabel(option)}
                      </button>
                    );
                  })}
                </div>

                <div className="mt-4 space-y-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Destination Name</p>
                    <Input
                      className="mt-2"
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      placeholder={type === "google_doc" ? "Weekly report doc" : "Board reporting sheet"}
                    />
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">File URL</p>
                    <Input
                      className="mt-2"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      placeholder={
                        type === "google_doc"
                          ? "https://docs.google.com/document/d/..."
                          : "https://docs.google.com/spreadsheets/d/..."
                      }
                    />
                    <p className="mt-2 text-xs leading-5 text-muted">
                      Maia verifies access before saving. Sheets exports write a new report tab with tables and charts.
                    </p>
                  </div>
                </div>

                <Button
                  type="button"
                  className="mt-4 w-full"
                  disabled={submitting || loading}
                  onClick={() => void handleSaveDestination()}
                >
                  {submitting ? "Saving..." : "Save Destination"}
                </Button>
              </div>
            </section>

            <section className="min-h-0 overflow-hidden rounded-[24px] border border-black/[0.06] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(247,247,246,0.94))] p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Saved</p>
                  <p className="mt-2 text-lg font-semibold tracking-[-0.03em] text-ink">
                    {destinationLabel(type)} destinations
                  </p>
                </div>
                <span className="rounded-full border border-black/[0.06] bg-white px-3 py-1.5 text-xs font-medium text-muted">
                  {filteredDestinations.length}
                </span>
              </div>

              <div className="mt-4 h-[calc(100%-4.75rem)] space-y-2 overflow-y-auto pr-1 scrollbar-thin">
                {filteredDestinations.map((destination: ExportDestination) => (
                  <div key={destination.id} className="rounded-[20px] border border-black/[0.06] bg-white p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-ink">{destination.title}</p>
                        <p className="mt-1 truncate text-xs text-muted">{destination.url}</p>
                        <p className="mt-2 text-[11px] uppercase tracking-[0.14em] text-muted">
                          {destination.last_verified_at ? "Verified" : destination.status}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <a
                          href={destination.url}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
                          aria-label="Open destination"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                        <button
                          type="button"
                          className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
                          disabled={deletingId === destination.id}
                          aria-label="Delete destination"
                          onClick={() => void handleDelete(destination.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}

                {!filteredDestinations.length ? (
                  <div className="rounded-[20px] border border-dashed border-black/[0.08] bg-white px-5 py-8 text-sm text-muted">
                    No saved {destinationLabel(type)} destinations yet.
                  </div>
                ) : null}
              </div>
            </section>
          </div>

          {feedback ? (
            <div className="mt-5 rounded-[22px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              {feedback}
            </div>
          ) : null}

          {error ? (
            <div className="mt-5 rounded-[22px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
