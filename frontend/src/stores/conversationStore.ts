"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { api } from "@/lib/api";
import type { ConversationDetail, ConversationSummary } from "@/lib/types";

const DELETE_TOMBSTONE_MS = 1200;

interface ConversationState {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  activeConversation: ConversationDetail | null;
  deletedConversationIds: Record<string, true>;
  searchTerm: string;
  loading: boolean;
  isHydrated: boolean;
  setHydrated: () => void;
  fetchConversations: (projectId?: string | null) => Promise<void>;
  loadConversation: (conversationId: string) => Promise<ConversationDetail>;
  setActiveConversationId: (conversationId: string | null) => void;
  setSearchTerm: (value: string) => void;
  deleteConversation: (conversationId: string) => Promise<void>;
  startNewConversation: () => void;
}

export const useConversationStore = create<ConversationState>()(
  persist(
    (set, get) => ({
      conversations: [],
      activeConversationId: null,
      activeConversation: null,
      deletedConversationIds: {},
      searchTerm: "",
      loading: false,
      isHydrated: false,
      setHydrated() {
        set({ isHydrated: true });
      },
      async fetchConversations(projectId) {
        set({ loading: true });
        try {
          const conversations = await api.listConversations(projectId);
          const activeConversationId = get().activeConversationId;
          const stillExists = conversations.some((conversation) => conversation.id === activeConversationId);
          set({
            conversations,
            activeConversationId: stillExists ? activeConversationId : null,
            activeConversation: stillExists ? get().activeConversation : null,
          });
        } finally {
          set({ loading: false });
        }
      },
      async loadConversation(conversationId) {
        set({ loading: true });
        try {
          const detail = await api.getConversation(conversationId);
          set({
            activeConversationId: conversationId,
            activeConversation: detail,
          });
          return detail;
        } finally {
          set({ loading: false });
        }
      },
      setActiveConversationId(conversationId) {
        set({ activeConversationId: conversationId });
      },
      setSearchTerm(value) {
        set({ searchTerm: value });
      },
      async deleteConversation(conversationId) {
        await api.deleteConversation(conversationId);
        set((state) => ({
          deletedConversationIds: {
            ...state.deletedConversationIds,
            [conversationId]: true,
          },
          activeConversationId:
            state.activeConversationId === conversationId ? null : state.activeConversationId,
          activeConversation:
            state.activeConversationId === conversationId ? null : state.activeConversation,
        }));

        window.setTimeout(() => {
          set((state) => {
            const nextDeletedConversationIds = { ...state.deletedConversationIds };
            delete nextDeletedConversationIds[conversationId];

            return {
              deletedConversationIds: nextDeletedConversationIds,
              conversations: state.conversations.filter((item) => item.id !== conversationId),
            };
          });
        }, DELETE_TOMBSTONE_MS);
      },
      startNewConversation() {
        set({
          activeConversationId: null,
          activeConversation: null,
        });
      },
    }),
    {
      name: "maia-axon-conversation",
      partialize: (state) => ({ activeConversationId: state.activeConversationId }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated();
      },
    },
  ),
);
