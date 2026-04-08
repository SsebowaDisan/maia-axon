"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  FolderCog,
  LogOut,
  MessageSquareMore,
  Plus,
  Search,
  Trash2,
} from "lucide-react";

import { DocumentUploader } from "@/components/admin/DocumentUploader";
import { GroupManager } from "@/components/admin/GroupManager";
import { UserAssignment } from "@/components/admin/UserAssignment";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AdminTab, ChatMessage, MessageResponse } from "@/lib/types";
import { bucketConversations, formatRelativeTime, titleFromMessage } from "@/lib/utils";
import { useAuthStore } from "@/stores/authStore";
import { useChatStore } from "@/stores/chatStore";
import { useConversationStore } from "@/stores/conversationStore";
import { useDocumentStore } from "@/stores/documentStore";
import { useGroupStore } from "@/stores/groupStore";

function mapMessage(message: MessageResponse): ChatMessage {
  return {
    id: message.id,
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content,
    createdAt: message.created_at,
    citations: message.citations?.citations ?? [],
    mindmap: message.mindmap,
    warnings: [],
    searchMode: message.search_mode ?? "library",
    isStreaming: false,
    status: "done",
    needsClarification: message.role === "assistant" && (message.citations?.citations?.length ?? 0) === 0 && /\?$/.test(message.content.trim()),
  };
}

function AdminView() {
  const groups = useGroupStore((state) => state.groups);
  const [tab, setTab] = useState<AdminTab>("groups");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(groups[0]?.id ?? null);

  useEffect(() => {
    if (!selectedGroupId && groups[0]?.id) {
      setSelectedGroupId(groups[0].id);
    }
  }, [groups, selectedGroupId]);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-4 rounded-[24px] border border-line bg-white/55 p-2">
        {(["groups", "documents", "users"] as AdminTab[]).map((item) => (
          <button
            key={item}
            type="button"
            className={`w-full rounded-2xl px-3 py-2 text-left text-sm capitalize transition ${
              item === tab ? "bg-accentSoft text-accent" : "hover:bg-black/5"
            }`}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {tab === "groups" ? <GroupManager selectedGroupId={selectedGroupId} onSelectGroup={setSelectedGroupId} /> : null}
        {tab === "documents" && selectedGroupId ? <DocumentUploader groupId={selectedGroupId} /> : null}
        {tab === "users" && selectedGroupId ? <UserAssignment groupId={selectedGroupId} /> : null}
        {(tab === "documents" || tab === "users") && !selectedGroupId ? (
          <div className="rounded-[26px] border border-dashed border-line p-6 text-center text-sm text-muted">
            Choose a group first in the Groups tab.
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SidebarHistory() {
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const conversations = useConversationStore((state) => state.conversations);
  const activeConversationId = useConversationStore((state) => state.activeConversationId);
  const searchTerm = useConversationStore((state) => state.searchTerm);
  const setSearchTerm = useConversationStore((state) => state.setSearchTerm);
  const loadConversation = useConversationStore((state) => state.loadConversation);
  const deleteConversation = useConversationStore((state) => state.deleteConversation);
  const startNewConversation = useConversationStore((state) => state.startNewConversation);
  const fetchConversations = useConversationStore((state) => state.fetchConversations);
  const groups = useGroupStore((state) => state.groups);
  const setActiveGroup = useGroupStore((state) => state.setActiveGroup);
  const fetchDocuments = useDocumentStore((state) => state.fetchDocuments);
  const clearSelection = useDocumentStore((state) => state.clearSelection);
  const hydrateMessages = useChatStore((state) => state.hydrateMessages);
  const clearChat = useChatStore((state) => state.clearChat);
  const [manageMode, setManageMode] = useState(false);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.getElementById("history-search")?.focus();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        startNewConversation();
        clearChat();
      }
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [clearChat, startNewConversation]);

  const groupLookup = useMemo(
    () =>
      groups.reduce<Record<string, string>>((acc, group) => {
        acc[group.id] = group.name;
        return acc;
      }, {}),
    [groups],
  );

  const filteredConversations = useMemo(() => {
    const needle = searchTerm.toLowerCase();
    return conversations.filter((conversation) =>
      (conversation.title ?? "").toLowerCase().includes(needle),
    );
  }, [conversations, searchTerm]);

  const grouped = bucketConversations(filteredConversations);

  async function handleSelectConversation(conversationId: string, groupId: string) {
    setActiveGroup(groupId);
    clearSelection();
    await fetchDocuments(groupId);
    const detail = await loadConversation(conversationId);
    hydrateMessages(detail.messages.map(mapMessage));
  }

  return (
    <div className="flex h-full flex-col px-2 py-2">
      <div className="mb-4 flex items-center justify-between gap-3 px-2">
        <div>
          <p className="font-display text-[2rem] leading-none text-ink">
            {manageMode ? "Manage" : "History"}
          </p>
          <p className="mt-2 text-sm text-muted">
            {manageMode ? "Groups, documents, and access." : "Past conversations grouped by time."}
          </p>
        </div>
        {manageMode ? (
          <Button type="button" variant="ghost" size="icon" onClick={() => setManageMode(false)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      {!manageMode ? (
        <>
          <Input
            id="history-search"
            placeholder="Search conversations..."
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            className="mb-3"
          />
          <div className="mb-4 flex gap-2">
            <Button
              type="button"
              className="flex-1"
              onClick={() => {
                startNewConversation();
                clearChat();
              }}
            >
              <Plus className="h-4 w-4" />
              New Chat
            </Button>
            {user?.role === "admin" ? (
              <Button type="button" variant="secondary" size="icon" onClick={() => setManageMode(true)}>
                <FolderCog className="h-4 w-4" />
              </Button>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin pr-1">
            {Object.entries(grouped).map(([bucket, items]) => (
              <div key={bucket} className="mb-5">
                <div className="mb-2 flex items-center gap-2 px-2">
                  <Search className="h-3.5 w-3.5 text-muted" />
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">{bucket}</p>
                </div>
                <div className="space-y-2">
                  {items.map((conversation) => (
                    <div
                      key={conversation.id}
                      className={`block w-full rounded-[24px] border px-4 py-3 text-left transition ${
                        activeConversationId === conversation.id
                          ? "border-accent bg-accentSoft/45"
                          : "border-line bg-panel/80 hover:bg-white/75"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <button
                          type="button"
                          className="min-w-0 text-left"
                          onClick={() => void handleSelectConversation(conversation.id, conversation.group_id)}
                        >
                          <p className="truncate text-sm font-semibold text-ink">
                            {conversation.title || titleFromMessage("Untitled conversation")}
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <Badge>{groupLookup[conversation.group_id] ?? "Group"}</Badge>
                            <span className="text-xs text-muted">{formatRelativeTime(conversation.updated_at)}</span>
                          </div>
                        </button>
                        <button
                          type="button"
                          className="rounded-full p-2 text-muted transition hover:bg-danger/10 hover:text-danger"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (window.confirm("Delete this conversation?")) {
                              void deleteConversation(conversation.id);
                              void fetchConversations();
                            }
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {!filteredConversations.length ? (
              <div className="rounded-[26px] border border-dashed border-line p-6 text-center text-sm text-muted">
                No conversations found yet.
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <AdminView />
      )}

      <div className="mt-4 rounded-[26px] border border-line bg-white/60 p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium text-ink">{user?.name ?? "Unknown user"}</p>
            <p className="text-xs uppercase tracking-[0.18em] text-muted">{user?.role ?? "guest"}</p>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={logout}>
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
