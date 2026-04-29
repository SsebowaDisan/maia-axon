"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import { AppShell } from "@/components/layout/AppShell";
import type { ChatMessage, MessageResponse } from "@/lib/types";
import { useAuthStore } from "@/stores/authStore";
import { useChatStore } from "@/stores/chatStore";
import { useCompanyStore } from "@/stores/companyStore";
import { useConversationStore } from "@/stores/conversationStore";
import { useDocumentStore } from "@/stores/documentStore";
import { useGroupStore } from "@/stores/groupStore";
import { useProjectStore } from "@/stores/projectStore";

function mapMessage(message: MessageResponse): ChatMessage {
  return {
    id: message.id,
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content,
    createdAt: message.created_at,
    citations: message.citations?.citations ?? [],
    visualizations: message.visualizations ?? [],
    mindmap: message.mindmap,
    warnings: [],
    searchMode: message.search_mode ?? "library",
    isStreaming: false,
    status: "done" as const,
    needsClarification:
      message.role === "assistant" &&
      (message.citations?.citations?.length ?? 0) === 0 &&
      /\?$/.test(message.content.trim()),
  };
}

export default function HomePage() {
  const router = useRouter();
  const restoredConversationIdRef = useRef<string | null>(null);
  const user = useAuthStore((state) => state.user);
  const isHydrated = useAuthStore((state) => state.isHydrated);
  const isLoading = useAuthStore((state) => state.isLoading);
  const bootstrap = useAuthStore((state) => state.bootstrap);
  const logout = useAuthStore((state) => state.logout);
  const fetchGroups = useGroupStore((state) => state.fetchGroups);
  const setActiveGroup = useGroupStore((state) => state.setActiveGroup);
  const fetchCompanies = useCompanyStore((state) => state.fetchCompanies);
  const fetchProjects = useProjectStore((state) => state.fetchProjects);
  const setActiveProject = useProjectStore((state) => state.setActiveProject);
  const fetchConversations = useConversationStore((state) => state.fetchConversations);
  const conversationHydrated = useConversationStore((state) => state.isHydrated);
  const conversations = useConversationStore((state) => state.conversations);
  const activeConversationId = useConversationStore((state) => state.activeConversationId);
  const activeConversation = useConversationStore((state) => state.activeConversation);
  const activeConversationByUser = useConversationStore((state) => state.activeConversationByUser);
  const loadConversation = useConversationStore((state) => state.loadConversation);
  const setActiveConversationId = useConversationStore((state) => state.setActiveConversationId);
  const fetchDocuments = useDocumentStore((state) => state.fetchDocuments);
  const initializeChat = useChatStore((state) => state.initialize);
  const chatHydrated = useChatStore((state) => state.isHydrated);
  const hydrateMessages = useChatStore((state) => state.hydrateMessages);
  const getCachedMessagesForConversation = useChatStore((state) => state.getCachedMessagesForConversation);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    initializeChat();
  }, [initializeChat]);

  useEffect(() => {
    if (!user || !conversationHydrated || activeConversationId) {
      return;
    }

    const rememberedConversationId = activeConversationByUser[user.id];
    if (rememberedConversationId) {
      setActiveConversationId(rememberedConversationId);
    }
  }, [
    activeConversationByUser,
    activeConversationId,
    conversationHydrated,
    setActiveConversationId,
    user,
  ]);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }
    if (!chatHydrated || !conversationHydrated) {
      return;
    }
    if (isLoading) {
      return;
    }
    if (!user) {
      router.replace("/login");
      return;
    }
    void (async () => {
      const results = await Promise.allSettled([
        fetchGroups(),
        fetchCompanies(),
        fetchProjects(),
        fetchConversations(),
      ]);
      const authFailed = results.some(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof Error &&
          /not authenticated|invalid token|unauthorized/i.test(result.reason.message),
      );
      if (authFailed) {
        logout();
        router.replace("/login");
      }
    })();
  }, [
    chatHydrated,
    conversationHydrated,
    fetchCompanies,
    fetchConversations,
    fetchGroups,
    fetchProjects,
    isHydrated,
    isLoading,
    logout,
    router,
    user,
  ]);

  useEffect(() => {
    if (!user || !activeConversationId) {
      restoredConversationIdRef.current = null;
      return;
    }

    if (activeConversation?.id === activeConversationId) {
      return;
    }

    if (restoredConversationIdRef.current === activeConversationId) {
      return;
    }

    const summary = conversations.find((conversation) => conversation.id === activeConversationId);
    if (!summary && conversations.length > 0) {
      setActiveConversationId(null);
      return;
    }

    restoredConversationIdRef.current = activeConversationId;

    void (async () => {
      const cachedMessages = getCachedMessagesForConversation(activeConversationId);
      if (cachedMessages?.length) {
        hydrateMessages(cachedMessages, activeConversationId);
      }

      if (summary?.project_id) {
        setActiveProject(summary.project_id);
      }

      if (summary?.group_id) {
        setActiveGroup(summary.group_id);
        await fetchDocuments(summary.group_id);
      }

      try {
        const detail = await loadConversation(activeConversationId);
        if (detail.project_id) {
          setActiveProject(detail.project_id);
        }
        if (detail.group_id && detail.group_id !== summary?.group_id) {
          setActiveGroup(detail.group_id);
          await fetchDocuments(detail.group_id);
        }
        const serverMessages = detail.messages.map(mapMessage);
        const latestCachedMessages = getCachedMessagesForConversation(detail.id);
        if (latestCachedMessages && latestCachedMessages.length > serverMessages.length) {
          hydrateMessages(latestCachedMessages, detail.id);
          return;
        }

        hydrateMessages(serverMessages, detail.id);
      } catch {
        restoredConversationIdRef.current = null;
        setActiveConversationId(null);
      }
    })();
  }, [
    activeConversation,
    activeConversationId,
    conversations,
    fetchDocuments,
    getCachedMessagesForConversation,
    hydrateMessages,
    loadConversation,
    setActiveGroup,
    setActiveConversationId,
    setActiveProject,
    user,
  ]);

  if (!isHydrated || (isLoading && !user)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg px-6 py-10 text-sm text-muted">
        Loading Maia...
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg px-6 py-10 text-sm text-muted">
        Redirecting to login...
      </div>
    );
  }

  const rememberedConversationId = activeConversationByUser[user.id];
  if (conversationHydrated && rememberedConversationId && !activeConversationId) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg px-6 py-10 text-sm text-muted">
        Restoring your previous conversation...
      </div>
    );
  }

  return <AppShell />;
}
