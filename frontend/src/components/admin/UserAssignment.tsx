"use client";

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { User } from "@/lib/types";
import { useGroupStore } from "@/stores/groupStore";

export function UserAssignment({ groupId }: { groupId: string }) {
  const assignedUsers = useGroupStore((state) => state.groupUsers[groupId] ?? []);
  const fetchGroupUsers = useGroupStore((state) => state.fetchGroupUsers);
  const assignUser = useGroupStore((state) => state.assignUser);
  const removeUser = useGroupStore((state) => state.removeUser);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void fetchGroupUsers(groupId);
    api.listUsers().then(setAllUsers).catch(() => undefined);
  }, [fetchGroupUsers, groupId]);

  const assignedIds = useMemo(() => new Set(assignedUsers.map((user) => user.id)), [assignedUsers]);

  const availableUsers = allUsers.filter((user) => {
    if (assignedIds.has(user.id)) {
      return false;
    }
    const needle = query.toLowerCase();
    return user.name.toLowerCase().includes(needle) || user.email.toLowerCase().includes(needle);
  });

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {assignedUsers.map((user) => (
          <div key={user.id} className="flex items-center justify-between rounded-[24px] border border-line bg-panel/80 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-ink">{user.name}</p>
              <p className="text-xs text-muted">{user.email}</p>
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={() => void removeUser(groupId, user.id)}>
              Remove
            </Button>
          </div>
        ))}
      </div>

      <div className="rounded-[24px] border border-line bg-white/55 p-4">
        <p className="mb-3 text-sm font-semibold text-ink">Assign user</p>
        <Input
          placeholder="Search users..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="mt-3 max-h-56 space-y-2 overflow-y-auto scrollbar-thin">
          {availableUsers.map((user) => (
            <button
              key={user.id}
              type="button"
              className="flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left transition hover:bg-black/5"
              onClick={() => void assignUser(groupId, user.id)}
            >
              <span>
                <span className="block text-sm font-medium">{user.name}</span>
                <span className="text-xs text-muted">{user.email}</span>
              </span>
              <span className="text-xs text-accent">Assign</span>
            </button>
          ))}
          {!availableUsers.length ? (
            <p className="text-center text-sm text-muted">No users available for assignment.</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
