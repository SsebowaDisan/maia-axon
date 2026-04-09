"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { AppShell } from "@/components/layout/AppShell";
import { useAuthStore } from "@/stores/authStore";
import { useChatStore } from "@/stores/chatStore";
import { useConversationStore } from "@/stores/conversationStore";
import { useGroupStore } from "@/stores/groupStore";

export default function HomePage() {
  const router = useRouter();
  const user = useAuthStore((state) => state.user);
  const isHydrated = useAuthStore((state) => state.isHydrated);
  const isLoading = useAuthStore((state) => state.isLoading);
  const bootstrap = useAuthStore((state) => state.bootstrap);
  const fetchGroups = useGroupStore((state) => state.fetchGroups);
  const fetchConversations = useConversationStore((state) => state.fetchConversations);
  const initializeChat = useChatStore((state) => state.initialize);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    initializeChat();
  }, [initializeChat]);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }
    if (!user) {
      router.replace("/login");
      return;
    }
    void fetchGroups();
    void fetchConversations();
  }, [fetchConversations, fetchGroups, isHydrated, router, user]);

  if (!isHydrated || isLoading || !user) {
    return null;
  }

  return <AppShell />;
}
