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
  const groups = useGroupStore((state) => state.groups);
  const groupUsers = useGroupStore((state) => state.groupUsers);
  const deletedGroupUserIds = useGroupStore((state) => state.deletedGroupUserIds);
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
  const deletedUserIds = deletedGroupUserIds[groupId] ?? {};
  const group = useMemo(() => groups.find((item) => item.id === groupId) ?? null, [groupId, groups]);

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
    <div className="space-y-5">
      <div className="rounded-[28px] border border-black/[0.06] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(244,244,243,0.94))] p-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">People access</p>
        <p className="mt-2 font-display text-[1.45rem] font-semibold tracking-[-0.04em] text-ink">
          {group?.name ?? "Selected group"}
        </p>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
          Create Maia users, choose their role, and assign them to this group so they can work with the right document space.
        </p>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <div className="rounded-[28px] border border-black/[0.06] bg-white/80 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-ink">Create user</p>
              <p className="mt-1 text-xs leading-5 text-muted">
                Add a Maia account and assign it to this group immediately.
              </p>
            </div>
            <span className="rounded-full bg-black/[0.04] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
              New user
            </span>
          </div>

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
            <div className="grid grid-cols-2 gap-2 rounded-[22px] border border-black/[0.06] bg-black/[0.03] p-1.5">
              <Button
                type="button"
                variant={draft.role === "user" ? "primary" : "ghost"}
                className={`h-11 rounded-[18px] ${draft.role === "user" ? "" : "bg-transparent hover:bg-white"}`}
                onClick={() => setDraft((state) => ({ ...state, role: "user" }))}
              >
                User
              </Button>
              <Button
                type="button"
                variant={draft.role === "admin" ? "primary" : "ghost"}
                className={`h-11 rounded-[18px] ${draft.role === "admin" ? "" : "bg-transparent hover:bg-white"}`}
                onClick={() => setDraft((state) => ({ ...state, role: "admin" }))}
              >
                <Shield className="h-4 w-4" />
                Admin
              </Button>
            </div>
            {createError ? <p className="text-sm text-danger">{createError}</p> : null}
            <Button
              type="button"
              className="h-12 w-full rounded-[20px]"
              disabled={isCreating}
              onClick={() => void handleCreateUser()}
            >
              <Plus className="h-4 w-4" />
              {isCreating ? "Creating..." : "Create and assign"}
            </Button>
          </div>
        </div>

        <div className="rounded-[28px] border border-black/[0.06] bg-white/80 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-ink">Assigned users</p>
              <p className="mt-1 text-xs leading-5 text-muted">
                Users who already have access to this group.
              </p>
            </div>
            <span className="rounded-full bg-black px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-white">
              {assignedUsers.length} assigned
            </span>
          </div>

          <div className="space-y-3">
            {assignedUsers.length ? (
              assignedUsers.map((user) => {
                const isDeleted = !!deletedUserIds[user.id];

                return (
                  <div
                    key={user.id}
                    className={`flex items-center justify-between rounded-[24px] border px-4 py-4 ${
                      isDeleted ? "border-danger/20 bg-danger/5 opacity-70" : "border-black/[0.06] bg-panel/90"
                    }`}
                  >
                    <div>
                      <p className="text-sm font-semibold text-ink">{isDeleted ? "Deleted" : user.name}</p>
                      <p className="mt-1 text-xs uppercase tracking-[0.14em] text-muted">
                        {isDeleted ? "Deleting..." : user.role}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={isDeleted}
                      onClick={() => setRemoveTarget(user)}
                    >
                      {isDeleted ? "Deleted" : "Remove"}
                    </Button>
                  </div>
                );
              })
            ) : (
              <div className="rounded-[24px] border border-dashed border-black/[0.08] bg-black/[0.02] px-5 py-8 text-center text-sm text-muted">
                No users assigned yet.
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-[28px] border border-black/[0.06] bg-white/80 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-ink">Assign existing user</p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Search current Maia accounts and add them to this group.
            </p>
          </div>
          <span className="rounded-full bg-black/[0.04] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
            Available users
          </span>
        </div>

        <Input
          placeholder="Search users..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="mt-4 max-h-72 space-y-2 overflow-y-auto scrollbar-thin">
          {availableUsers.map((user) => (
            <button
              key={user.id}
              type="button"
              className="flex w-full items-center justify-between rounded-[22px] border border-transparent bg-black/[0.02] px-4 py-3 text-left transition hover:border-black/[0.06] hover:bg-white"
              onClick={() => void assignUser(groupId, user.id)}
            >
              <span>
                <span className="block text-sm font-medium text-ink">{user.name}</span>
                <span className="mt-1 block text-xs uppercase tracking-[0.14em] text-muted">{user.role}</span>
              </span>
              <span className="rounded-full bg-black px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-white">
                Assign
              </span>
            </button>
          ))}
          {!availableUsers.length ? (
            <p className="rounded-[22px] bg-black/[0.02] px-5 py-6 text-center text-sm text-muted">
              No users available for assignment.
            </p>
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
