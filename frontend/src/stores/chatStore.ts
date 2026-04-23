"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { api } from "@/lib/api";
import { chatSocket } from "@/lib/ws";
import type {
  ChatMessage,
  ChatQueryPayload,
  PromptAttachment,
  SearchMode,
} from "@/lib/types";
import { useAuthStore } from "@/stores/authStore";
import { useCompanyStore } from "@/stores/companyStore";
import { useConversationStore } from "@/stores/conversationStore";
import { useDocumentStore } from "@/stores/documentStore";
import { useGroupStore } from "@/stores/groupStore";
import { useMindmapStore } from "@/stores/mindmapStore";
import { usePDFViewerStore } from "@/stores/pdfViewerStore";
import { useProjectStore } from "@/stores/projectStore";

const PDF_WARMUP_DOC_LIMIT = 3;
const PDF_WARMUP_PAGES = [1, 2, 3];

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
    visualizations: partial.visualizations ?? [],
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
  messageCacheByConversation: Record<string, ChatMessage[]>;
  draft: string;
  promptAttachments: PromptAttachment[];
  draftMode: "compose" | "user_edit" | "assistant_edit";
  mode: SearchMode;
  streaming: boolean;
  welcomeStreaming: boolean;
  connectionError: string | null;
  initialized: boolean;
  isHydrated: boolean;
  autoScrollNonce: number;
  setHydrated: () => void;
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
  hydrateMessages: (messages: ChatMessage[], conversationId?: string | null) => void;
  getCachedMessagesForConversation: (conversationId: string) => ChatMessage[] | null;
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

function withConversationCache(
  state: Pick<ChatState, "messages" | "messageCacheByConversation">,
  messages: ChatMessage[],
  conversationId: string | null | undefined,
) {
  if (!conversationId) {
    return {
      ...state,
      messages,
    };
  }

  return {
    ...state,
    messages,
    messageCacheByConversation: {
      ...state.messageCacheByConversation,
      [conversationId]: messages,
    },
  };
}

export const useChatStore = create<ChatState>()(
  persist((set, get) => ({
  messages: [],
  messageCacheByConversation: {},
  draft: "",
  promptAttachments: [],
  draftMode: "compose",
  mode: "library",
  streaming: false,
  welcomeStreaming: false,
  connectionError: null,
  initialized: false,
  isHydrated: false,
  autoScrollNonce: 0,
  setHydrated() {
    set({ isHydrated: true });
  },
  initialize() {
    if (get().initialized) {
      return;
    }

    let tokenBuffer = "";
    let flushTimer: number | null = null;

    const flushTokenBuffer = () => {
      if (!tokenBuffer) {
        return;
      }

      const pending = tokenBuffer;
      tokenBuffer = "";
      if (flushTimer) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }

      set((state) => {
        const index = lastAssistantIndex(state.messages);
        if (index === -1) {
          return state;
        }
        const next = [...state.messages];
        next[index] = {
          ...next[index],
          content: `${next[index].content}${pending}`,
          isStreaming: true,
        };
        return withConversationCache(
          state,
          next,
          useConversationStore.getState().activeConversationId,
        );
      });
    };

    chatSocket.subscribe((event) => {
      const updateAssistant = (updater: (message: ChatMessage) => ChatMessage) => {
        set((state) => {
          const index = lastAssistantIndex(state.messages);
          if (index === -1) {
            return state;
          }
          const next = [...state.messages];
          next[index] = updater(next[index]);
          return withConversationCache(
            state,
            next,
            useConversationStore.getState().activeConversationId,
          );
        });
      };

      switch (event.type) {
        case "status":
          flushTokenBuffer();
          updateAssistant((message) => ({ ...message, status: event.status, isStreaming: true }));
          set({ streaming: true });
          break;
        case "token":
          tokenBuffer += event.content;
          if (!flushTimer) {
            flushTimer = window.setTimeout(() => {
              flushTokenBuffer();
            }, 48);
          }
          break;
        case "citations":
          flushTokenBuffer();
          updateAssistant((message) => ({ ...message, citations: event.data }));
          {
            const pdfCitations = event.data.filter(
              (citation) => citation.source_type === "pdf" && citation.document_id,
            );
            const { documentsByGroup } = useDocumentStore.getState();
            const grouped = new Map<string, number[]>();
            for (const citation of pdfCitations) {
              if (!citation.document_id) {
                continue;
              }
              const pages = grouped.get(citation.document_id) ?? [];
              pages.push(citation.page - 1, citation.page, citation.page + 1);
              grouped.set(citation.document_id, pages);
            }
            const allDocuments = Object.values(documentsByGroup).flat();
            for (const [documentId, pageNumbers] of grouped) {
              const document = allDocuments.find((item) => item.id === documentId);
              if (document) {
                void usePDFViewerStore.getState().prefetchPages(document, pageNumbers);
              }
            }
          }
          break;
        case "visualizations":
          flushTokenBuffer();
          updateAssistant((message) => ({ ...message, visualizations: event.data }));
          break;
        case "mindmap":
          flushTokenBuffer();
          updateAssistant((message) => ({ ...message, mindmap: event.data }));
          useMindmapStore.getState().setMindmapData(event.data);
          break;
        case "warnings":
          flushTokenBuffer();
          updateAssistant((message) => ({ ...message, warnings: event.data }));
          break;
        case "done":
          flushTokenBuffer();
          updateAssistant((message) => ({
            ...message,
            isStreaming: false,
            status: "done",
            needsClarification: message.citations.length === 0 && /\?$/.test(message.content.trim()),
          }));
          useConversationStore.getState().setActiveConversationId(event.conversation_id);
          void useConversationStore.getState().fetchConversations();
          set((state) => withConversationCache(state, state.messages, event.conversation_id));
          set({ streaming: false });
          break;
        case "error":
          flushTokenBuffer();
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
      flushTokenBuffer();
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
      hydrateMessages(messages, conversationId) {
    set((state) => withConversationCache(state, messages, conversationId));
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    useMindmapStore.getState().setMindmapData(lastAssistant?.mindmap ?? null);
  },
  getCachedMessagesForConversation(conversationId) {
    return get().messageCacheByConversation[conversationId] ?? null;
  },
  async sendMessage(content) {
    const { mode, promptAttachments } = get();
    const token = useAuthStore.getState().token;
    const companyState = useCompanyStore.getState();
    const groupState = useGroupStore.getState();
    const projectState = useProjectStore.getState();
    const conversationState = useConversationStore.getState();
    const documentState = useDocumentStore.getState();
    const companyId =
      mode === "google_analytics" || mode === "google_ads"
        ? companyState.selectedCompanyByMode[mode]
        : null;
    const groupId =
      mode === "standard"
        ? groupState.activeGroupId ?? groupState.groups[0]?.id ?? null
        : mode === "library" || mode === "deep_search"
          ? groupState.activeGroupId
          : null;
    const documentIds = documentState.selectedDocumentIds;
    const activeConversationProjectId =
      conversationState.activeConversation?.project_id ??
      conversationState.conversations.find(
        (conversation) => conversation.id === conversationState.activeConversationId,
      )?.project_id ??
      null;
    const conversationId =
      conversationState.activeConversationId && activeConversationProjectId === projectState.activeProjectId
        ? conversationState.activeConversationId
        : null;

    if (
      !token ||
      ((mode === "library" || mode === "deep_search") && !groupId) ||
      ((mode === "google_analytics" || mode === "google_ads") && !companyId) ||
      (!content.trim() && promptAttachments.length === 0)
    ) {
      return;
    }

    get().initialize();

    if (mode !== "standard" && groupId) {
      const documentsInGroup = documentState.documentsByGroup[groupId] ?? [];
      const warmupDocuments =
        documentIds.length > 0
          ? documentsInGroup.filter((document) => documentIds.includes(document.id))
          : documentsInGroup.filter((document) => document.status === "ready").slice(0, PDF_WARMUP_DOC_LIMIT);

      for (const document of warmupDocuments.slice(0, PDF_WARMUP_DOC_LIMIT)) {
        void usePDFViewerStore.getState().prefetchPages(document, PDF_WARMUP_PAGES);
      }
    }

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
      ...withConversationCache(
        state,
        [...state.messages, userMessage, assistantMessage],
        conversationId,
      ),
      streaming: true,
      connectionError: null,
      promptAttachments: [],
      autoScrollNonce: state.autoScrollNonce + 1,
    }));

    const payload: ChatQueryPayload = {
      type: "query",
      project_id: projectState.activeProjectId,
      group_id: groupId,
      company_id: companyId,
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
}),
  {
    name: "maia-axon-chat",
    partialize: (state) => ({
      messages: state.messages,
      messageCacheByConversation: state.messageCacheByConversation,
      mode: state.mode,
    }),
    onRehydrateStorage: () => (state) => {
      state?.setHydrated();
    },
  },
));
