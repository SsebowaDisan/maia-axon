"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { api } from "@/lib/api";
import type { Group, User } from "@/lib/types";

interface GroupState {
  groups: Group[];
  groupUsers: Record<string, User[]>;
  activeGroupId: string | null;
  loading: boolean;
  error: string | null;
  fetchGroups: () => Promise<void>;
  setActiveGroup: (groupId: string | null) => void;
  createGroup: (payload: { name: string; description?: string }) => Promise<Group>;
  updateGroup: (groupId: string, payload: { name?: string; description?: string }) => Promise<Group>;
  deleteGroup: (groupId: string) => Promise<void>;
  fetchGroupUsers: (groupId: string) => Promise<void>;
  assignUser: (groupId: string, userId: string) => Promise<void>;
  removeUser: (groupId: string, userId: string) => Promise<void>;
}

export const useGroupStore = create<GroupState>()(
  persist(
    (set, get) => ({
      groups: [],
      groupUsers: {},
      activeGroupId: null,
      loading: false,
      error: null,
      async fetchGroups() {
        set({ loading: true, error: null });
        try {
          const groups = await api.listGroups();
          const activeGroupId = get().activeGroupId;
          const stillExists = groups.some((group) => group.id === activeGroupId);
          set({
            groups,
            activeGroupId: stillExists ? activeGroupId : groups[0]?.id ?? null,
          });
        } catch (error) {
          set({ error: error instanceof Error ? error.message : "Failed to load groups" });
        } finally {
          set({ loading: false });
        }
      },
      setActiveGroup(groupId) {
        set({ activeGroupId: groupId });
      },
      async createGroup(payload) {
        const group = await api.createGroup(payload);
        set((state) => ({ groups: [...state.groups, group].sort((a, b) => a.name.localeCompare(b.name)) }));
        return group;
      },
      async updateGroup(groupId, payload) {
        const group = await api.updateGroup(groupId, payload);
        set((state) => ({
          groups: state.groups.map((item) => (item.id === groupId ? group : item)),
        }));
        return group;
      },
      async deleteGroup(groupId) {
        await api.deleteGroup(groupId);
        set((state) => ({
          groups: state.groups.filter((group) => group.id !== groupId),
          activeGroupId: state.activeGroupId === groupId ? null : state.activeGroupId,
        }));
      },
      async fetchGroupUsers(groupId) {
        const users = await api.listGroupUsers(groupId);
        set((state) => ({ groupUsers: { ...state.groupUsers, [groupId]: users } }));
      },
      async assignUser(groupId, userId) {
        await api.assignUser(groupId, userId);
        await get().fetchGroupUsers(groupId);
      },
      async removeUser(groupId, userId) {
        await api.removeUser(groupId, userId);
        await get().fetchGroupUsers(groupId);
      },
    }),
    {
      name: "maia-axon-group",
      partialize: (state) => ({ activeGroupId: state.activeGroupId }),
    },
  ),
);
