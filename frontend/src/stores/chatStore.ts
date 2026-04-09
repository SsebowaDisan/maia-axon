"use client";

import { create } from "zustand";

import { api } from "@/lib/api";
import { chatSocket } from "@/lib/ws";
import type {
  ChatMessage,
  ChatQueryPayload,
  PromptAttachment,
  SearchMode,
  WsServerEvent,
} from "@/lib/types";
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
    attachments: partial.attachments ?? [],
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
  draft: string;
  promptAttachments: PromptAttachment[];
  draftMode: "compose" | "user_edit" | "assistant_edit";
  mode: SearchMode;
  streaming: boolean;
  welcomeStreaming: boolean;
  connectionError: string | null;
  initialized: boolean;
  initialize: () => void;
  setMode: (mode: SearchMode) => void;
  setDraft: (draft: string) => void;
  setWelcomeStreaming: (streaming: boolean) => void;
  addPromptAttachments: (files: FileList | File[]) => Promise<void>;
  removePromptAttachment: (attachmentId: string) => void;
  clearPromptAttachments: () => void;
  setDraftMode: (draftMode: "compose" | "user_edit" | "assistant_edit") => void;
  updateMessageContent: (messageId: string, content: string) => void;
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
  draft: "",
  promptAttachments: [],
  draftMode: "compose",
  mode: "library",
  streaming: false,
  welcomeStreaming: false,
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
          void useConversationStore.getState().fetchConversations();
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
  setDraft(draft) {
    set({ draft });
  },
  setWelcomeStreaming(welcomeStreaming) {
    set({ welcomeStreaming });
  },
  async addPromptAttachments(files) {
    const entries = Array.from(files);
    const uploaded = await Promise.all(entries.map((file) => api.uploadPromptAttachment(file)));
    set((state) => ({
      promptAttachments: [...state.promptAttachments, ...uploaded],
    }));
  },
  removePromptAttachment(attachmentId) {
    set((state) => ({
      promptAttachments: state.promptAttachments.filter((attachment) => attachment.id !== attachmentId),
    }));
  },
  clearPromptAttachments() {
    set({ promptAttachments: [] });
  },
  setDraftMode(draftMode) {
    set({ draftMode });
  },
  updateMessageContent(messageId, content) {
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              content,
              needsClarification: false,
            }
          : message,
      ),
    }));
  },
  clearChat() {
    useMindmapStore.getState().clearMindmap();
    set({ messages: [], streaming: false, draft: "", draftMode: "compose", promptAttachments: [] });
  },
  hydrateMessages(messages) {
    set({ messages });
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    useMindmapStore.getState().setMindmapData(lastAssistant?.mindmap ?? null);
  },
  async sendMessage(content) {
    const { mode, promptAttachments } = get();
    const token = useAuthStore.getState().token;
    const groupState = useGroupStore.getState();
    const conversationState = useConversationStore.getState();
    const groupId =
      mode === "standard"
        ? groupState.activeGroupId ?? groupState.groups[0]?.id ?? null
        : groupState.activeGroupId;
    const documentIds = useDocumentStore.getState().selectedDocumentIds;
    const activeConversationGroupId =
      conversationState.activeConversation?.group_id ??
      conversationState.conversations.find(
        (conversation) => conversation.id === conversationState.activeConversationId,
      )?.group_id ??
      null;
    const conversationId =
      conversationState.activeConversationId && activeConversationGroupId === groupId
        ? conversationState.activeConversationId
        : null;

    if (!token || !groupId || (!content.trim() && promptAttachments.length === 0)) {
      return;
    }

    get().initialize();

    const visibleUserContent =
      content.trim() ||
      `Attached: ${promptAttachments.map((attachment) => attachment.filename).join(", ")}`;

    const userMessage = makeMessage({
      role: "user",
      content: visibleUserContent,
      attachments: promptAttachments,
      searchMode: mode,
    });
    const assistantMessage = makeMessage({
      role: "assistant",
      content: "",
      searchMode: mode,
      isStreaming: true,
      status: mode === "standard" ? "reasoning" : "retrieving",
    });

    set((state) => ({
      messages: [...state.messages, userMessage, assistantMessage],
      streaming: true,
      connectionError: null,
      promptAttachments: [],
    }));

    const payload: ChatQueryPayload = {
      type: "query",
      group_id: groupId,
      document_ids: documentIds,
      attachment_ids: promptAttachments.map((attachment) => attachment.id),
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
