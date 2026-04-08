"use client";

import { useState } from "react";
import { PencilLine, Plus, Trash2 } from "lucide-react";

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
  const createGroup = useGroupStore((state) => state.createGroup);
  const updateGroup = useGroupStore((state) => state.updateGroup);
  const deleteGroup = useGroupStore((state) => state.deleteGroup);
  const [draft, setDraft] = useState({ name: "", description: "" });
  const [editing, setEditing] = useState<Group | null>(null);

  async function handleSubmit() {
    if (!draft.name.trim()) {
      return;
    }

    if (editing) {
      await updateGroup(editing.id, draft);
      setEditing(null);
    } else {
      const group = await createGroup(draft);
      onSelectGroup(group.id);
    }
    setDraft({ name: "", description: "" });
  }

  return (
    <div className="space-y-4">
      <div className="rounded-[26px] border border-line bg-white/60 p-4">
        <p className="mb-3 text-sm font-semibold">{editing ? "Edit group" : "Create group"}</p>
        <div className="space-y-3">
          <Input
            placeholder="Group name"
            value={draft.name}
            onChange={(event) => setDraft((state) => ({ ...state, name: event.target.value }))}
          />
          <Input
            placeholder="Description"
            value={draft.description}
            onChange={(event) => setDraft((state) => ({ ...state, description: event.target.value }))}
          />
          <Button type="button" className="w-full" onClick={() => void handleSubmit()}>
            <Plus className="h-4 w-4" />
            {editing ? "Save group" : "Create group"}
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        {groups.map((group) => (
          <div
            key={group.id}
            className={`block w-full rounded-[26px] border px-4 py-4 text-left transition ${
              selectedGroupId === group.id
                ? "border-accent bg-accentSoft/50"
                : "border-line bg-panel/80 hover:bg-white/70"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <button type="button" className="text-left" onClick={() => onSelectGroup(group.id)}>
                  <p className="text-sm font-semibold text-ink">{group.name}</p>
                  <p className="mt-1 text-xs text-muted">
                    {group.document_count} docs · {group.user_count} users
                  </p>
                </button>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={(event) => {
                    event.stopPropagation();
                    setEditing(group);
                    setDraft({
                      name: group.name,
                      description: group.description ?? "",
                    });
                  }}
                >
                  <PencilLine className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (window.confirm(`Delete ${group.name}?`)) {
                      void deleteGroup(group.id);
                      onSelectGroup(selectedGroupId === group.id ? null : selectedGroupId);
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
