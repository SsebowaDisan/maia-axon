"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Shield } from "lucide-react";

import { DeleteConfirmDialog } from "@/components/shared/DeleteConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { User } from "@/lib/types";
import { useGroupStore } from "@/stores/groupStore";

export function UserAssignment({ groupId }: { groupId: string }) {
  const groupUsers = useGroupStore((state) => state.groupUsers);
  const fetchGroupUsers = useGroupStore((state) => state.fetchGroupUsers);
  const assignUser = useGroupStore((state) => state.assignUser);
  const removeUser = useGroupStore((state) => state.removeUser);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState({ username: "", password: "", role: "user" });
  const [createError, setCreateError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<User | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const assignedUsers = useMemo(() => groupUsers[groupId] ?? [], [groupId, groupUsers]);

  const refreshUsers = useCallback(() => {
    return api.listUsers().then(setAllUsers).catch(() => undefined);
  }, []);

  useEffect(() => {
    void fetchGroupUsers(groupId);
    void refreshUsers();
  }, [fetchGroupUsers, groupId, refreshUsers]);

  const assignedIds = useMemo(() => new Set(assignedUsers.map((user) => user.id)), [assignedUsers]);

  const availableUsers = allUsers.filter((user) => {
    if (assignedIds.has(user.id)) {
      return false;
    }
    const needle = query.toLowerCase();
    return user.name.toLowerCase().includes(needle) || user.email.toLowerCase().includes(needle);
  });

  async function handleCreateUser() {
    const username = draft.username.trim();
    const password = draft.password.trim();

    if (!username || !password) {
      setCreateError("Username and password are required");
      return;
    }

    setIsCreating(true);
    setCreateError(null);

    try {
      const user = await api.createUser({
        username,
        password,
        role: draft.role,
      });
      await assignUser(groupId, user.id);
      await refreshUsers();
      setDraft({ username: "", password: "", role: "user" });
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Failed to create user");
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-[24px] border border-line bg-white/55 p-4">
        <p className="mb-3 text-sm font-semibold text-ink">Create user</p>
        <div className="space-y-3">
          <Input
            placeholder="Username"
            value={draft.username}
            onChange={(event) => setDraft((state) => ({ ...state, username: event.target.value }))}
          />
          <Input
            type="password"
            placeholder="Password"
            value={draft.password}
            onChange={(event) => setDraft((state) => ({ ...state, password: event.target.value }))}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant={draft.role === "user" ? "primary" : "secondary"}
              className="flex-1"
              onClick={() => setDraft((state) => ({ ...state, role: "user" }))}
            >
              User
            </Button>
            <Button
              type="button"
              variant={draft.role === "admin" ? "primary" : "secondary"}
              className="flex-1"
              onClick={() => setDraft((state) => ({ ...state, role: "admin" }))}
            >
              <Shield className="h-4 w-4" />
              Admin
            </Button>
          </div>
          {createError ? <p className="text-sm text-danger">{createError}</p> : null}
          <Button type="button" className="w-full" disabled={isCreating} onClick={() => void handleCreateUser()}>
            <Plus className="h-4 w-4" />
            {isCreating ? "Creating..." : "Create and assign"}
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        {assignedUsers.map((user) => (
          <div key={user.id} className="flex items-center justify-between rounded-[24px] border border-line bg-panel/80 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-ink">{user.name}</p>
              <p className="text-xs uppercase tracking-[0.14em] text-muted">{user.role}</p>
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={() => setRemoveTarget(user)}>
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
                <span className="text-xs uppercase tracking-[0.14em] text-muted">{user.role}</span>
              </span>
              <span className="text-xs text-accent">Assign</span>
            </button>
          ))}
          {!availableUsers.length ? (
            <p className="text-center text-sm text-muted">No users available for assignment.</p>
          ) : null}
        </div>
      </div>

      <DeleteConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveTarget(null);
          }
        }}
        title="Remove user"
        description={
          <>
            Type <span className="font-semibold text-ink">delete</span> to remove{" "}
            <span className="font-semibold text-ink">{removeTarget?.name ?? "this user"}</span> from the group.
          </>
        }
        confirmLabel="Remove user"
        isDeleting={isRemoving}
        onConfirm={async () => {
          if (!removeTarget) {
            return;
          }
          setIsRemoving(true);
          try {
            await removeUser(groupId, removeTarget.id);
            setRemoveTarget(null);
          } finally {
            setIsRemoving(false);
          }
        }}
      />
    </div>
  );
}
