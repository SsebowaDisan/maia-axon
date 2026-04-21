"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { PencilLine, Plus, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Group } from "@/lib/types";
import { useGroupStore } from "@/stores/groupStore";

export function GroupManager({
  selectedGroupId,
  onSelectGroup,
}: {
  selectedGroupId: string | null;
  onSelectGroup: (groupId: string | null) => void;
}) {
  const groups = useGroupStore((state) => state.groups);
  const deletedGroupIds = useGroupStore((state) => state.deletedGroupIds);
  const createGroup = useGroupStore((state) => state.createGroup);
  const updateGroup = useGroupStore((state) => state.updateGroup);
  const deleteGroup = useGroupStore((state) => state.deleteGroup);
  const [draft, setDraft] = useState({ name: "", description: "" });
  const [editing, setEditing] = useState<Group | null>(null);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Group | null>(null);
  const [deleteText, setDeleteText] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);

  function resetProjectDraft() {
    setDraft({ name: "", description: "" });
    setEditing(null);
  }

  async function handleSubmit() {
    if (!draft.name.trim()) {
      return;
    }

    if (editing) {
      await updateGroup(editing.id, draft);
    } else {
      const group = await createGroup(draft);
      onSelectGroup(group.id);
    }

    resetProjectDraft();
    setProjectDialogOpen(false);
  }

  async function handleDeleteProject() {
    if (!deleteTarget || deleteText.trim().toLowerCase() !== "delete") {
      return;
    }

    setIsDeleting(true);
    try {
      await deleteGroup(deleteTarget.id);
      onSelectGroup(selectedGroupId === deleteTarget.id ? null : selectedGroupId);
      setDeleteTarget(null);
      setDeleteText("");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <>
      <div className="flex h-full min-h-0 flex-col gap-4">
        <button
          type="button"
          className="flex w-full items-center gap-4 rounded-[26px] border border-dashed border-line bg-white/60 px-5 py-5 text-left transition hover:bg-white/80"
          onClick={() => {
            resetProjectDraft();
            setProjectDialogOpen(true);
          }}
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black text-white">
            <Plus className="h-5 w-5" />
          </span>
          <div>
            <p className="text-sm font-semibold text-ink">Create group</p>
            <p className="mt-1 text-xs text-muted">Add a new group for PDF upload and RAG.</p>
          </div>
        </button>

        <div className="min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-thin">
          <div className="space-y-3">
          {groups.map((group) => (
            (() => {
              const isDeleted = !!deletedGroupIds[group.id];

              return (
            <div
              key={group.id}
              role="button"
              tabIndex={0}
              onClick={() => {
                if (!isDeleted) {
                  onSelectGroup(group.id);
                }
              }}
              onKeyDown={(event) => {
                if (!isDeleted && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault();
                  onSelectGroup(group.id);
                }
              }}
              className={`group block w-full cursor-pointer rounded-[26px] border px-4 py-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/15 ${
                isDeleted
                  ? "border-danger/20 bg-danger/5 opacity-70"
                  : selectedGroupId === group.id
                  ? "border-accent bg-accentSoft/50"
                  : "border-line bg-panel/80 hover:bg-white/70"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-ink">{isDeleted ? "Deleted" : group.name}</p>
                  <p className="mt-1 text-xs text-muted">{isDeleted ? "Deleting..." : `${group.document_count} PDFs`}</p>
                </div>
                <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    disabled={isDeleted}
                    onClick={(event) => {
                      event.stopPropagation();
                      setEditing(group);
                      setDraft({
                        name: group.name,
                        description: group.description ?? "",
                      });
                      setProjectDialogOpen(true);
                    }}
                  >
                    <PencilLine className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    disabled={isDeleted}
                    onClick={(event) => {
                      event.stopPropagation();
                      setDeleteTarget(group);
                      setDeleteText("");
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
              );
            })()
          ))}
          </div>
        </div>
      </div>

      <Dialog.Root
        open={projectDialogOpen}
        onOpenChange={(open) => {
          setProjectDialogOpen(open);
          if (!open) {
            resetProjectDraft();
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/18 backdrop-blur-[18px]" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-[80] w-[min(460px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[30px] border border-black/[0.06] bg-white p-6 shadow-[0_24px_60px_rgba(17,17,17,0.12)] outline-none"
            onPointerDownOutside={() => setProjectDialogOpen(false)}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="font-display text-[1.5rem] font-semibold tracking-[-0.04em] text-ink">
                  {editing ? "Edit group" : "Create group"}
                </Dialog.Title>
                <p className="mt-2 text-sm leading-6 text-muted">
                  {editing
                    ? "Update the group name and description."
                    : "Add a group name and description before uploading PDFs for RAG."}
                </p>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
                  aria-label="Close group dialog"
                >
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>

            <div className="mt-5 space-y-3">
              <Input
                placeholder="Group name"
                value={draft.name}
                onChange={(event) => setDraft((state) => ({ ...state, name: event.target.value }))}
              />
              <Input
                placeholder="Description"
                value={draft.description}
                onChange={(event) =>
                  setDraft((state) => ({ ...state, description: event.target.value }))
                }
              />
              <Button type="button" className="w-full" onClick={() => void handleSubmit()}>
                <Plus className="h-4 w-4" />
                {editing ? "Save group" : "Create group"}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteText("");
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/18 backdrop-blur-[18px]" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-[80] w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[30px] border border-black/[0.06] bg-white p-6 shadow-[0_24px_60px_rgba(17,17,17,0.12)] outline-none"
            onPointerDownOutside={() => {
              setDeleteTarget(null);
              setDeleteText("");
            }}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="font-display text-[1.5rem] font-semibold tracking-[-0.04em] text-ink">
                  Delete group
                </Dialog.Title>
                <p className="mt-2 text-sm leading-6 text-muted">
                  Type <span className="font-semibold text-ink">delete</span> to remove{" "}
                  <span className="font-semibold text-ink">{deleteTarget?.name ?? "this group"}</span>.
                </p>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
                  aria-label="Close delete dialog"
                >
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>

            <div className="mt-5 space-y-3">
              <Input
                placeholder='Type "delete"'
                value={deleteText}
                onChange={(event) => setDeleteText(event.target.value)}
              />
              <div className="flex gap-3">
                <Dialog.Close asChild>
                  <Button type="button" variant="secondary" className="flex-1">
                    Cancel
                  </Button>
                </Dialog.Close>
                <Button
                  type="button"
                  variant="danger"
                  className="flex-1"
                  disabled={deleteText.trim().toLowerCase() !== "delete" || isDeleting}
                  onClick={() => void handleDeleteProject()}
                >
                  {isDeleting ? "Deleting..." : "Delete group"}
                </Button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
