"use client";

import { forwardRef } from "react";
import { FolderOpen } from "lucide-react";

import { Input } from "@/components/ui/input";
import type { Group } from "@/lib/types";

export const GroupSelector = forwardRef<HTMLDivElement, {
  groups: Group[];
  query: string;
  onQueryChange: (value: string) => void;
  onSelect: (group: Group) => void;
}>(function GroupSelector(
  { groups, query, onQueryChange, onSelect },
  ref,
) {
  return (
    <div ref={ref} className="absolute bottom-full left-14 mb-3 w-[320px] rounded-[24px] border border-line bg-panel p-3 shadow-card">
      <Input
        autoFocus
        placeholder="Search groups..."
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      <div className="mt-3 max-h-64 space-y-1 overflow-y-auto scrollbar-thin">
        {groups.length ? (
          groups.map((group) => (
            <button
              key={group.id}
              type="button"
              className="flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left transition hover:bg-black/5"
              onClick={() => onSelect(group)}
            >
              <span className="flex items-center gap-3">
                <span className="rounded-2xl bg-accentSoft p-2 text-accent">
                  <FolderOpen className="h-4 w-4" />
                </span>
                <span>
                  <span className="block text-sm font-medium">{group.name}</span>
                  <span className="text-xs text-muted">{group.description || "Engineering knowledge group"}</span>
                </span>
              </span>
              <span className="text-xs text-muted">{group.document_count} docs</span>
            </button>
          ))
        ) : (
          <p className="px-2 py-6 text-center text-sm text-muted">No groups matched your search.</p>
        )}
      </div>
    </div>
  );
});
