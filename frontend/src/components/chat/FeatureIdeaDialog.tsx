"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { Lightbulb, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useDialogDismiss } from "@/hooks/useDialogDismiss";
import { api } from "@/lib/api";
import type { FeatureIdeaPriority } from "@/lib/types";

const categories = ["New feature", "Google Ads / Analytics", "Documents", "Dashboard", "UI/UX", "Bug"];
const priorities: { value: FeatureIdeaPriority; label: string }[] = [
  { value: "nice_to_have", label: "Nice to have" },
  { value: "important", label: "Important" },
  { value: "blocking", label: "Blocking" },
];

export function FeatureIdeaDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [category, setCategory] = useState(categories[0]);
  const [priority, setPriority] = useState<FeatureIdeaPriority>("nice_to_have");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

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
      setFeedback(null);
    }
  }, [open]);

  async function submit() {
    if (!description.trim()) {
      setFeedback("Add a short description first.");
      return;
    }

    setSaving(true);
    setFeedback(null);
    try {
      await api.submitFeatureIdea({
        category,
        title: title.trim() || null,
        description: description.trim(),
        priority,
      });
      setTitle("");
      setDescription("");
      setCategory(categories[0]);
      setPriority("nice_to_have");
      onOpenChange(false);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Could not save idea.");
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
          className="fixed left-1/2 top-1/2 z-[90] w-[min(620px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[32px] border border-black/[0.06] bg-white p-6 shadow-[0_30px_80px_rgba(17,17,17,0.16)] outline-none"
          onPointerDownOutside={handlePointerDownOutside}
          onEscapeKeyDown={handleEscapeKeyDown}
          onFocusOutside={handleFocusOutside}
          onInteractOutside={handleInteractOutside}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="rounded-full bg-black p-3 text-white">
                <Lightbulb className="h-4 w-4" />
              </span>
              <div>
                <Dialog.Title className="font-display text-[1.55rem] font-semibold tracking-[-0.04em] text-ink">
                  Suggest an idea
                </Dialog.Title>
                <p className="mt-1 text-sm leading-6 text-muted">
                  Share features, workflow improvements, bugs, or dashboard ideas Maia should learn next.
                </p>
              </div>
            </div>
            <button
              type="button"
              className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
              aria-label="Close idea dialog"
              onClick={requestClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted">Category</p>
              <div className="flex flex-wrap gap-2">
                {categories.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                      category === item
                        ? "border-black bg-black text-white"
                        : "border-black/[0.08] bg-black/[0.03] text-ink hover:bg-black/[0.06]"
                    }`}
                    onClick={() => setCategory(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted">Priority</p>
              <div className="grid gap-2">
                {priorities.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    className={`rounded-full border px-3 py-2 text-sm font-medium transition ${
                      priority === item.value
                        ? "border-black bg-black text-white"
                        : "border-black/[0.08] bg-black/[0.03] text-ink hover:bg-black/[0.06]"
                    }`}
                    onClick={() => setPriority(item.value)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <Input
            className="mt-5"
            placeholder="Optional title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Textarea
            className="mt-3 min-h-[150px] resize-none"
            placeholder="What should Maia do better?"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />

          {feedback ? <p className="mt-3 text-sm text-muted">{feedback}</p> : null}

          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={requestClose} disabled={saving}>
              Close
            </Button>
            <Button type="button" onClick={() => void submit()} disabled={saving}>
              {saving ? "Saving..." : "Submit idea"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
