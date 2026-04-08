"use client";

import { create } from "zustand";

import { chatSocket } from "@/lib/ws";
import type { ChatMessage, ChatQueryPayload, SearchMode, WsServerEvent } from "@/lib/types";
import { useAuthStore } from "@/stores/authStore";
import { useConversationStore } from "@/stores/conversationStore";
import { useDocumentStore } from "@/stores/documentStore";
import { useGroupStore } from "@/stores/groupStore";
import { useMindmapStore } from "@/stores/mindmapStore";

function makeMessage(
  partial: Partial<ChatMessage> & Pick<ChatMessage, "role" | "content" | "searchMode">,
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: partial.role,
    content: partial.content,
    createdAt: new Date().toISOString(),
    citations: partial.citations ?? [],
    mindmap: partial.mindmap ?? null,
    warnings: partial.warnings ?? [],
    searchMode: partial.searchMode,
    isStreaming: partial.isStreaming ?? false,
    status: partial.status ?? "idle",
    needsClarification: partial.needsClarification ?? false,
  };
}

interface ChatState {
  messages: ChatMessage[];
  mode: SearchMode;
  streaming: boolean;
  connectionError: string | null;
  initialized: boolean;
  initialize: () => void;
  setMode: (mode: SearchMode) => void;
  clearChat: () => void;
  hydrateMessages: (messages: ChatMessage[]) => void;
  sendMessage: (message: string) => Promise<void>;
}

function lastAssistantIndex(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      return index;
    }
  }
  return -1;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  mode: "library",
  streaming: false,
  connectionError: null,
  initialized: false,
  initialize() {
    if (get().initialized) {
      return;
    }

    chatSocket.subscribe((event) => {
      const updateAssistant = (updater: (message: ChatMessage) => ChatMessage) => {
        set((state) => {
          const index = lastAssistantIndex(state.messages);
          if (index === -1) {
            return state;
          }
          const next = [...state.messages];
          next[index] = updater(next[index]);
          return { ...state, messages: next };
        });
      };

      switch (event.type) {
        case "status":
          updateAssistant((message) => ({ ...message, status: event.status, isStreaming: true }));
          set({ streaming: true });
          break;
        case "token":
          updateAssistant((message) => ({
            ...message,
            content: `${message.content}${event.content}`,
            isStreaming: true,
          }));
          break;
        case "citations":
          updateAssistant((message) => ({ ...message, citations: event.data }));
          break;
        case "mindmap":
          updateAssistant((message) => ({ ...message, mindmap: event.data }));
          useMindmapStore.getState().setMindmapData(event.data);
          break;
        case "warnings":
          updateAssistant((message) => ({ ...message, warnings: event.data }));
          break;
        case "done":
          updateAssistant((message) => ({
            ...message,
            isStreaming: false,
            status: "done",
            needsClarification: message.citations.length === 0 && /\?$/.test(message.content.trim()),
          }));
          useConversationStore.getState().setActiveConversationId(event.conversation_id);
          void useConversationStore.getState().fetchConversations(
            useGroupStore.getState().activeGroupId,
          );
          set({ streaming: false });
          break;
        case "error":
          updateAssistant((message) => ({
            ...message,
            content: event.message,
            warnings: [event.message],
            isStreaming: false,
            status: "done",
          }));
          set({ streaming: false, connectionError: event.message });
          break;
      }
    });

    chatSocket.onError((error) => {
      set({ streaming: false, connectionError: error.message });
    });

    set({ initialized: true });
  },
  setMode(mode) {
    set({ mode });
  },
  clearChat() {
    useMindmapStore.getState().clearMindmap();
    set({ messages: [], streaming: false });
  },
  hydrateMessages(messages) {
    set({ messages });
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    useMindmapStore.getState().setMindmapData(lastAssistant?.mindmap ?? null);
  },
  async sendMessage(content) {
    const { mode } = get();
    const token = useAuthStore.getState().token;
    const groupId = useGroupStore.getState().activeGroupId;
    const documentIds = useDocumentStore.getState().selectedDocumentIds;
    const conversationId = useConversationStore.getState().activeConversationId;

    if (!token || !groupId || !content.trim()) {
      return;
    }

    get().initialize();

    const userMessage = makeMessage({
      role: "user",
      content,
      searchMode: mode,
    });
    const assistantMessage = makeMessage({
      role: "assistant",
      content: "",
      searchMode: mode,
      isStreaming: true,
      status: "retrieving",
    });

    set((state) => ({
      messages: [...state.messages, userMessage, assistantMessage],
      streaming: true,
      connectionError: null,
    }));

    const payload: ChatQueryPayload = {
      type: "query",
      group_id: groupId,
      document_ids: documentIds,
      mode,
      message: content,
      conversation_id: conversationId,
    };

    try {
      await chatSocket.send(payload);
    } catch (error) {
      set((state) => ({
        messages: state.messages.map((message, index) =>
          index === state.messages.length - 1
            ? {
                ...message,
                content: error instanceof Error ? error.message : "Failed to send message",
                isStreaming: false,
                warnings: [error instanceof Error ? error.message : "Failed to send message"],
              }
            : message,
        ),
        streaming: false,
      }));
      throw error;
    }
  },
}));
