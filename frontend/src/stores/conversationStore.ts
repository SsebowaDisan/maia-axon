"use client";

import { create } from "zustand";

import { api } from "@/lib/api";
import type { ConversationDetail, ConversationSummary } from "@/lib/types";

interface ConversationState {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  activeConversation: ConversationDetail | null;
  searchTerm: string;
  loading: boolean;
  fetchConversations: (projectId?: string | null) => Promise<void>;
  loadConversation: (conversationId: string) => Promise<ConversationDetail>;
  setActiveConversationId: (conversationId: string | null) => void;
  setSearchTerm: (value: string) => void;
  deleteConversation: (conversationId: string) => Promise<void>;
  startNewConversation: () => void;
}

export const useConversationStore = create<ConversationState>((set) => ({
  conversations: [],
  activeConversationId: null,
  activeConversation: null,
  searchTerm: "",
  loading: false,
  async fetchConversations(projectId) {
    set({ loading: true });
    try {
      const conversations = await api.listConversations(projectId);
      set({ conversations });
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
      conversations: state.conversations.filter((item) => item.id !== conversationId),
      activeConversationId:
        state.activeConversationId === conversationId ? null : state.activeConversationId,
      activeConversation:
        state.activeConversationId === conversationId ? null : state.activeConversation,
    }));
  },
  startNewConversation() {
    set({
      activeConversationId: null,
      activeConversation: null,
    });
  },
}));
