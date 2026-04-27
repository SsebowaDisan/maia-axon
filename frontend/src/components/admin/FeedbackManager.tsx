"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState } from "react";
import { Bot, Lightbulb, ThumbsDown, ThumbsUp, X } from "lucide-react";

import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer";
import { Button } from "@/components/ui/button";
import { useDialogDismiss } from "@/hooks/useDialogDismiss";
import { api } from "@/lib/api";
import type { AdminFeatureIdea, AdminMessageFeedback, FeatureIdeaStatus } from "@/lib/types";
import { formatRelativeTime } from "@/lib/utils";

const statuses: FeatureIdeaStatus[] = ["new", "reviewed", "planned", "done"];

function statusLabel(status: FeatureIdeaStatus | string) {
  return status.replaceAll("_", " ");
}

export function FeedbackManager() {
  const [messageFeedback, setMessageFeedback] = useState<AdminMessageFeedback[]>([]);
  const [ideas, setIdeas] = useState<AdminFeatureIdea[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openResponse, setOpenResponse] = useState<AdminMessageFeedback | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [feedbackRows, ideaRows] = await Promise.all([
        api.listMessageFeedback(),
        api.listFeatureIdeas(),
      ]);
      setMessageFeedback(feedbackRows);
      setIdeas(ideaRows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load feedback.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const upCount = useMemo(() => messageFeedback.filter((item) => item.rating === "up").length, [messageFeedback]);
  const downCount = messageFeedback.length - upCount;

  async function updateIdeaStatus(idea: AdminFeatureIdea, status: FeatureIdeaStatus) {
    const previous = ideas;
    setIdeas((current) => current.map((item) => (item.id === idea.id ? { ...item, status } : item)));
    try {
      await api.updateFeatureIdeaStatus(idea.id, status);
    } catch {
      setIdeas(previous);
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-[24px] border border-black/[0.06] bg-white p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Positive</p>
          <p className="mt-2 text-3xl font-semibold tracking-[-0.05em] text-ink">{upCount}</p>
        </div>
        <div className="rounded-[24px] border border-black/[0.06] bg-white p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Poor</p>
          <p className="mt-2 text-3xl font-semibold tracking-[-0.05em] text-ink">{downCount}</p>
        </div>
        <div className="rounded-[24px] border border-black/[0.06] bg-white p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Ideas</p>
          <p className="mt-2 text-3xl font-semibold tracking-[-0.05em] text-ink">{ideas.length}</p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">Response ratings</p>
          <p className="mt-1 text-xs text-muted">Recent thumbs up/down feedback from Maia responses.</p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
          Refresh
        </Button>
      </div>

      {error ? <div className="rounded-[20px] border border-danger/20 bg-danger/5 p-4 text-sm text-danger">{error}</div> : null}

      <div className="space-y-3">
        {messageFeedback.map((item) => (
          <div key={item.id} className="rounded-[24px] border border-black/[0.06] bg-white p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex h-8 w-8 items-center justify-center rounded-full ${item.rating === "up" ? "bg-black text-white" : "bg-black/[0.06] text-ink"}`}>
                {item.rating === "up" ? <ThumbsUp className="h-3.5 w-3.5" /> : <ThumbsDown className="h-3.5 w-3.5" />}
              </span>
              <span className="text-sm font-semibold text-ink">{item.user_name}</span>
              <span className="text-xs text-muted">{item.user_email}</span>
              <span className="ml-auto text-xs text-muted">{formatRelativeTime(item.updated_at)}</span>
            </div>
            {item.tags?.length ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {item.tags.map((tag) => (
                  <span key={tag} className="rounded-full bg-black/[0.04] px-2.5 py-1 text-xs font-medium text-ink">
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}
            {item.comment ? <p className="mt-3 text-sm leading-6 text-ink">{item.comment}</p> : null}
            <div className="mt-3 max-h-[135px] overflow-hidden rounded-[18px] bg-black/[0.03] p-4 text-sm leading-6 text-ink/80">
              <MarkdownRenderer content={item.message_content} citations={[]} />
            </div>
            <div className="mt-3 flex justify-end">
              <Button type="button" variant="secondary" size="sm" onClick={() => setOpenResponse(item)}>
                Open full response
              </Button>
            </div>
          </div>
        ))}
        {!loading && !messageFeedback.length ? (
          <div className="rounded-[24px] border border-dashed border-line p-6 text-center text-sm text-muted">
            No response feedback yet.
          </div>
        ) : null}
      </div>

      <div className="pt-2">
        <div className="mb-3 flex items-center gap-2">
          <Lightbulb className="h-4 w-4 text-muted" />
          <p className="text-sm font-semibold text-ink">Feature ideas</p>
        </div>
        <div className="space-y-3">
          {ideas.map((idea) => (
            <div key={idea.id} className="rounded-[24px] border border-black/[0.06] bg-white p-4">
              <div className="flex flex-wrap items-start gap-2">
                <span className="rounded-full bg-black/[0.04] px-2.5 py-1 text-xs font-semibold text-ink">
                  {idea.category}
                </span>
                <span className="rounded-full bg-black/[0.04] px-2.5 py-1 text-xs font-semibold text-ink">
                  {statusLabel(idea.priority)}
                </span>
                <span className="ml-auto text-xs text-muted">{formatRelativeTime(idea.created_at)}</span>
              </div>
              <p className="mt-3 text-base font-semibold text-ink">{idea.title || "Untitled idea"}</p>
              <p className="mt-2 text-sm leading-6 text-ink/86">{idea.description}</p>
              <p className="mt-2 text-xs text-muted">Submitted by {idea.user_name} · {idea.user_email}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {statuses.map((status) => (
                  <button
                    key={status}
                    type="button"
                    className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                      idea.status === status
                        ? "border-black bg-black text-white"
                        : "border-black/[0.08] bg-black/[0.03] text-ink hover:bg-black/[0.06]"
                    }`}
                    onClick={() => void updateIdeaStatus(idea, status)}
                  >
                    {statusLabel(status)}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {!loading && !ideas.length ? (
            <div className="rounded-[24px] border border-dashed border-line p-6 text-center text-sm text-muted">
              No feature ideas yet.
            </div>
          ) : null}
        </div>
      </div>

      {loading ? (
        <div className="rounded-[24px] border border-black/[0.06] bg-white p-6 text-center text-sm text-muted">
          Loading feedback...
        </div>
      ) : null}

      <FullResponseDialog feedback={openResponse} onOpenChange={(open) => !open && setOpenResponse(null)} />
    </div>
  );
}

function FullResponseDialog({
  feedback,
  onOpenChange,
}: {
  feedback: AdminMessageFeedback | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = feedback !== null;
  const {
    handleOpenChange,
    handlePointerDownOutside,
    handleEscapeKeyDown,
    handleFocusOutside,
    handleInteractOutside,
    requestClose,
  } = useDialogDismiss(() => onOpenChange(false));

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/18 backdrop-blur-[18px]" onDoubleClick={requestClose} />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[100] flex h-[min(780px,calc(100vh-2rem))] w-[min(900px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[34px] border border-black/[0.06] bg-white p-6 shadow-[0_30px_80px_rgba(17,17,17,0.16)] outline-none"
          onPointerDownOutside={handlePointerDownOutside}
          onEscapeKeyDown={handleEscapeKeyDown}
          onFocusOutside={handleFocusOutside}
          onInteractOutside={handleInteractOutside}
        >
          <div className="flex items-start justify-between gap-4 border-b border-black/[0.06] pb-5">
            <div className="flex items-start gap-3">
              <span className="rounded-full bg-black p-3 text-white">
                <Bot className="h-4 w-4" />
              </span>
              <div>
                <Dialog.Title className="font-display text-[1.6rem] font-semibold tracking-[-0.04em] text-ink">
                  Full Maia response
                </Dialog.Title>
                <p className="mt-1 text-sm text-muted">
                  {feedback ? `${feedback.user_name} rated this ${feedback.rating === "up" ? "positively" : "poorly"}.` : ""}
                </p>
              </div>
            </div>
            <button
              type="button"
              className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
              aria-label="Close full response"
              onClick={requestClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {feedback ? (
            <div className="mt-5 min-h-0 flex-1 overflow-y-auto rounded-[24px] border border-black/[0.06] bg-black/[0.02] p-5 scrollbar-thin">
              <MarkdownRenderer content={feedback.message_content} citations={[]} />
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
