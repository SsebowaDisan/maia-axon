"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, Settings2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDialogDismiss } from "@/hooks/useDialogDismiss";
import type { ChatMessage, ExportDestination } from "@/lib/types";
import { useCompanyStore } from "@/stores/companyStore";
import { useExportDestinationStore } from "@/stores/exportDestinationStore";

function dialogTitle(type: "google_doc" | "google_sheet") {
  return type === "google_doc" ? "Write to Docs" : "Write to Sheets";
}

function defaultReportTitle(message: ChatMessage) {
  const modeLabel =
    message.searchMode === "google_analytics"
      ? "GA4"
      : message.searchMode === "google_ads"
        ? "Google Ads"
        : message.searchMode === "deep_search"
          ? "Deep Search"
          : message.searchMode === "standard"
            ? "Standard"
            : "Library";
  return `Maia ${modeLabel} Report`;
}

export function ExportDialog({
  open,
  onOpenChange,
  type,
  message,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: "google_doc" | "google_sheet";
  message: ChatMessage;
}) {
  const { companies, selectedCompanyByMode } = useCompanyStore();
  const destinations = useExportDestinationStore((state) => state.destinations);
  const loading = useExportDestinationStore((state) => state.loading);
  const fetchDestinations = useExportDestinationStore((state) => state.fetchDestinations);
  const writeDestination = useExportDestinationStore((state) => state.writeDestination);

  const [title, setTitle] = useState("");
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const {
    handleOpenChange,
    handlePointerDownOutside,
    handleEscapeKeyDown,
    handleFocusOutside,
    handleInteractOutside,
    requestClose,
  } = useDialogDismiss(() => onOpenChange(false));

  const filteredDestinations = useMemo(
    () => destinations.filter((destination) => destination.type === type),
    [destinations, type],
  );

  const companyName = useMemo(() => {
    if (message.searchMode !== "google_analytics" && message.searchMode !== "google_ads") {
      return null;
    }
    const selectedId = selectedCompanyByMode[message.searchMode];
    return companies.find((company) => company.id === selectedId)?.name ?? null;
  }, [companies, message.searchMode, selectedCompanyByMode]);

  useEffect(() => {
    if (!open) {
      setFeedback(null);
      setError(null);
      setSubmittingId(null);
      return;
    }

    if (!title) {
      setTitle(defaultReportTitle(message));
    }
    void fetchDestinations();
  }, [fetchDestinations, message, open, title]);

  async function handleWrite(destination: ExportDestination) {
    setSubmittingId(destination.id);
    setError(null);
    setFeedback(null);
    try {
      await writeDestination({
        destination_id: destination.id,
        title: title.trim() || defaultReportTitle(message),
        content: message.content,
        search_mode: message.searchMode,
        company_name: companyName,
        visualizations: message.visualizations,
      });
      setFeedback(type === "google_doc" ? "Report written to Google Docs." : "Report written to Google Sheets.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Export failed");
    } finally {
      setSubmittingId(null);
    }
  }

  function openDestinationSettings() {
    window.dispatchEvent(new CustomEvent("maia:open-destinations"));
    onOpenChange(false);
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/18 backdrop-blur-[18px]" onDoubleClick={requestClose} />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[80] w-[min(680px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[30px] border border-black/[0.06] bg-white p-6 shadow-[0_24px_60px_rgba(17,17,17,0.12)] outline-none"
          onPointerDownOutside={handlePointerDownOutside}
          onEscapeKeyDown={handleEscapeKeyDown}
          onFocusOutside={handleFocusOutside}
          onInteractOutside={handleInteractOutside}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="font-display text-[1.5rem] font-semibold tracking-[-0.04em] text-ink">
                {dialogTitle(type)}
              </Dialog.Title>
              <p className="mt-2 text-sm leading-6 text-muted">
                Choose a saved destination. Add or manage Docs and Sheets destinations from Settings.
              </p>
            </div>
            <button
              type="button"
              className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
              aria-label="Close export dialog"
              onClick={requestClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Report Title</p>
            <Input
              className="mt-2"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Weekly paid media report"
            />
          </div>

          <div className="mt-5 flex items-center justify-between gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Saved Destinations</p>
            <Button type="button" variant="secondary" className="h-9 px-3" onClick={openDestinationSettings}>
              <Settings2 className="h-4 w-4" />
              Manage In Settings
            </Button>
          </div>

          <div className="mt-2 max-h-[360px] space-y-2 overflow-y-auto pr-1 scrollbar-thin">
            {filteredDestinations.map((destination) => (
              <div
                key={destination.id}
                className="rounded-[22px] border border-black/8 bg-white p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{destination.title}</p>
                    <p className="mt-1 truncate text-xs text-muted">{destination.url}</p>
                  </div>
                  <a
                    href={destination.url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
                    aria-label="Open destination"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-9 px-3"
                    disabled={submittingId !== null || loading}
                    onClick={() => void handleWrite(destination)}
                  >
                    <Check className="mr-2 h-3.5 w-3.5" />
                    {submittingId === destination.id ? "Writing..." : "Write Now"}
                  </Button>
                </div>
              </div>
            ))}
            {!filteredDestinations.length ? (
              <div className="rounded-[22px] border border-dashed border-black/10 bg-black/[0.02] p-5 text-sm text-muted">
                No saved {type === "google_doc" ? "Docs" : "Sheets"} destinations yet. Add one in Settings first.
              </div>
            ) : null}
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
