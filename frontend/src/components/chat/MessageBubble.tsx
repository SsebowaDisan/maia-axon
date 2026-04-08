"use client";

import { AlertTriangle, Bot, Brain, FileText, User2 } from "lucide-react";

import { CalculationSteps } from "@/components/chat/CalculationSteps";
import { CitationChip } from "@/components/chat/Citation";
import { StreamingIndicator } from "@/components/chat/StreamingIndicator";
import { Badge } from "@/components/ui/badge";
import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer";
import type { ChatMessage, Citation, Document } from "@/lib/types";
import { formatRelativeTime } from "@/lib/utils";
import { useDocumentStore } from "@/stores/documentStore";
import { useGroupStore } from "@/stores/groupStore";
import { usePDFViewerStore } from "@/stores/pdfViewerStore";

function useCitationOpener() {
  const activeGroupId = useGroupStore((state) => state.activeGroupId);
  const documents = useDocumentStore((state) =>
    activeGroupId ? state.documentsByGroup[activeGroupId] ?? [] : [],
  );
  const openCitation = usePDFViewerStore((state) => state.openCitation);

  return async (citation: Citation) => {
    const document = documents.find((item) => item.id === citation.document_id) ?? null;
    await openCitation(citation, document as Document | null);
  };
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  const openCitation = useCitationOpener();

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-[28px] rounded-br-lg bg-accent px-5 py-4 text-sm text-white shadow-[0_20px_45px_rgba(23,97,122,0.22)]">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-white/75">
            <User2 className="h-3.5 w-3.5" />
            You
          </div>
          <p className="whitespace-pre-wrap leading-7">{message.content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] rounded-[30px] rounded-tl-lg border border-line bg-panel/95 px-5 py-4 shadow-card">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 text-sm font-semibold">
            <span className="rounded-2xl bg-accentSoft p-2 text-accent">
              <Bot className="h-4 w-4" />
            </span>
            Maia Axon
          </span>
          <Badge>{message.searchMode === "deep_search" ? "Deep Search" : "Library"}</Badge>
          <span className="text-xs text-muted">{formatRelativeTime(message.createdAt)}</span>
          <StreamingIndicator status={message.status} />
        </div>

        {message.warnings.length ? (
          <div className="mb-4 rounded-[24px] border border-warn/25 bg-warn/10 p-4 text-sm text-ink">
            <div className="flex items-center gap-2 font-medium text-warn">
              <AlertTriangle className="h-4 w-4" />
              OCR / retrieval warning
            </div>
            <ul className="mt-2 space-y-1 text-sm text-ink/85">
              {message.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {message.needsClarification ? (
          <div className="rounded-[26px] border border-accent/20 bg-accentSoft/60 p-4">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-accent">
              <Brain className="h-4 w-4" />
              Clarification needed
            </div>
            <p className="whitespace-pre-wrap text-sm leading-7 text-ink">{message.content}</p>
          </div>
        ) : (
          <>
            <CalculationSteps
              content={message.content}
              citations={message.citations}
              onCitationClick={openCitation}
            />
            <div className="mt-4">
              <MarkdownRenderer
                content={message.content || (message.isStreaming ? " " : "")}
                citations={message.citations}
                onCitationClick={openCitation}
              />
            </div>
          </>
        )}

        {message.citations.length ? (
          <div className="mt-5 rounded-[26px] border border-line bg-white/65 p-4 dark:bg-panel/80">
            <div className="mb-3 flex items-center gap-2">
              <FileText className="h-4 w-4 text-accent" />
              <h4 className="font-display text-sm uppercase tracking-[0.18em] text-muted">Sources</h4>
            </div>
            <div className="space-y-3">
              {message.citations.map((citation, index) => (
                <div
                  key={citation.id}
                  className="rounded-2xl border border-line bg-panel/80 px-4 py-3 transition hover:border-accent/30 hover:bg-accentSoft/35"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-ink">
                        [{index + 1}] {citation.document_name || citation.title}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        {citation.source_type === "pdf" ? `Page ${citation.page}` : citation.url}
                      </p>
                      {citation.snippet ? (
                        <p className="mt-2 line-clamp-3 text-sm text-ink/75">{citation.snippet}</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <CitationChip citation={citation} />
                      <button
                        type="button"
                        className="rounded-full border border-accent/15 bg-accentSoft px-3 py-1 text-xs font-semibold text-accent"
                        onClick={() => openCitation(citation)}
                      >
                        Open
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
