"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { ThumbsDown, ThumbsUp, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer";
import { Textarea } from "@/components/ui/textarea";
import { useDialogDismiss } from "@/hooks/useDialogDismiss";
import { api } from "@/lib/api";
import type { ChatMessage, MessageFeedbackRating } from "@/lib/types";

const positiveGroups = [
  {
    label: "Quality",
    tags: ["Extraordinary", "Accurate", "Insightful"],
  },
  {
    label: "Usefulness",
    tags: ["Helpful", "Actionable", "Saved time"],
  },
  {
    label: "Presentation",
    tags: ["Clear", "Well structured", "Good dashboard"],
  },
];

const negativeGroups = [
  {
    label: "Correctness",
    tags: ["Incorrect", "Unsupported claim", "Bad calculation"],
  },
  {
    label: "Context",
    tags: ["Missing context", "Wrong source", "Did not answer"],
  },
  {
    label: "Presentation",
    tags: ["Too long", "Too short", "Bad formatting", "Confusing"],
  },
];

export function MessageFeedbackDialog({
  message,
  rating,
  open,
  onOpenChange,
  onSaved,
}: {
  message: ChatMessage;
  rating: MessageFeedbackRating;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (rating: MessageFeedbackRating) => void;
}) {
  const [selectedTags, setSelectedTags] = useState<string[]>(rating === "up" ? ["Extraordinary"] : []);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tagGroups = rating === "up" ? positiveGroups : negativeGroups;
  const title = rating === "up" ? "What made this response strong?" : "What should Maia improve?";
  const description =
    rating === "up"
      ? "Pick the signals Maia should repeat. Add a note only if there is something specific worth preserving."
      : "Classify the problem first, then add a short correction if Maia missed something important.";

  const {
    handleOpenChange,
    handlePointerDownOutside,
    handleEscapeKeyDown,
    handleFocusOutside,
    handleInteractOutside,
    requestClose,
  } = useDialogDismiss(() => onOpenChange(false));

  useEffect(() => {
    if (open) {
      setSelectedTags(rating === "up" ? ["Extraordinary"] : []);
      setComment("");
      setError(null);
    }
  }, [open, rating]);

  function toggleTag(tag: string) {
    setSelectedTags((current) =>
      current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag],
    );
  }

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await api.submitMessageFeedback({
        message_id: message.id,
        rating,
        tags: selectedTags,
        comment: comment.trim() || null,
      });
      onSaved(rating);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save feedback.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/18 backdrop-blur-[18px]" onDoubleClick={requestClose} />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[90] w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[30px] border border-black/[0.06] bg-white p-6 shadow-[0_30px_80px_rgba(17,17,17,0.16)] outline-none"
          onPointerDownOutside={handlePointerDownOutside}
          onEscapeKeyDown={handleEscapeKeyDown}
          onFocusOutside={handleFocusOutside}
          onInteractOutside={handleInteractOutside}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="rounded-full bg-black p-3 text-white">
                {rating === "up" ? <ThumbsUp className="h-4 w-4" /> : <ThumbsDown className="h-4 w-4" />}
              </span>
              <div>
                <Dialog.Title className="font-display text-[1.45rem] font-semibold tracking-[-0.04em] text-ink">
                  {title}
                </Dialog.Title>
                <p className="mt-1 text-sm leading-6 text-muted">{description}</p>
              </div>
            </div>
            <button
              type="button"
              className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
              aria-label="Close feedback"
              onClick={requestClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-5 rounded-[22px] border border-black/[0.06] bg-black/[0.025] p-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Response</p>
            <div className="mt-2 max-h-[150px] overflow-hidden text-sm leading-6 text-ink/80">
              <MarkdownRenderer content={message.content || "Maia response"} citations={message.citations} />
            </div>
          </div>

          <div className="mt-5 space-y-4">
            {tagGroups.map((group) => (
              <div key={group.label}>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                  {group.label}
                </p>
                <div className="flex flex-wrap gap-2">
                  {group.tags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                        selectedTags.includes(tag)
                          ? "border-black bg-black text-white"
                          : "border-black/[0.08] bg-black/[0.03] text-ink hover:bg-black/[0.06]"
                      }`}
                      onClick={() => toggleTag(tag)}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <Textarea
            className="mt-5 min-h-[120px] resize-none"
            placeholder={rating === "up" ? "Optional: what should Maia repeat next time?" : "Optional: what should Maia have answered instead?"}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />

          <p className="mt-2 text-xs leading-5 text-muted">
            {rating === "up"
              ? "A quick tag is enough. Notes are useful for exceptional responses."
              : "For poor answers, one concrete correction helps more than a general complaint."}
          </p>

          {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}

          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={requestClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void submit()} disabled={saving}>
              {saving ? "Saving..." : "Save feedback"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
