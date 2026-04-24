"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDialogDismiss } from "@/hooks/useDialogDismiss";

export function DeleteConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  isDeleting = false,
  requireDeleteText = true,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  isDeleting?: boolean;
  requireDeleteText?: boolean;
  onConfirm: () => Promise<void> | void;
}) {
  const [deleteText, setDeleteText] = useState("");
  const {
    handleOpenChange,
    handlePointerDownOutside,
    handleEscapeKeyDown,
    handleFocusOutside,
    handleInteractOutside,
    requestClose,
  } =
    useDialogDismiss(() => onOpenChange(false));

  useEffect(() => {
    if (!open) {
      setDeleteText("");
    }
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/18 backdrop-blur-[18px]" onDoubleClick={requestClose} />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[80] w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[30px] border border-black/[0.06] bg-white p-6 shadow-[0_24px_60px_rgba(17,17,17,0.12)] outline-none"
          onPointerDownOutside={handlePointerDownOutside}
          onEscapeKeyDown={handleEscapeKeyDown}
          onFocusOutside={handleFocusOutside}
          onInteractOutside={handleInteractOutside}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="font-display text-[1.5rem] font-semibold tracking-[-0.04em] text-ink">
                {title}
              </Dialog.Title>
              <div className="mt-2 text-sm leading-6 text-muted">{description}</div>
            </div>
            <button
              type="button"
              className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
              aria-label="Close delete dialog"
              onClick={requestClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-5 space-y-3">
            {requireDeleteText ? (
              <Input
                placeholder='Type "delete"'
                value={deleteText}
                onChange={(event) => setDeleteText(event.target.value)}
              />
            ) : null}
            <div className="flex gap-3">
              <Button type="button" variant="secondary" className="flex-1" onClick={requestClose}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                className="flex-1"
                disabled={(requireDeleteText && deleteText.trim().toLowerCase() !== "delete") || isDeleting}
                onClick={() => void onConfirm()}
              >
                {isDeleting ? "Deleting..." : confirmLabel}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
