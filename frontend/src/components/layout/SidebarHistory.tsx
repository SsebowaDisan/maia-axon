"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Brain,
  ChartColumn,
  Cog,
  FileText,
  Folder,
  FolderCog,
  FolderOpen,
  Globe,
  History,
  LogOut,
  MessageSquareMore,
  Plus,
  Search,
  Settings2,
  Shield,
  Sigma,
  Trash2,
  Wrench,
  X,
} from "lucide-react";

import { DocumentUploader } from "@/components/admin/DocumentUploader";
import { GroupManager } from "@/components/admin/GroupManager";
import { DeleteConfirmDialog } from "@/components/shared/DeleteConfirmDialog";
import { UserAssignment } from "@/components/admin/UserAssignment";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ChatMessage, ConversationSummary, Group, MessageResponse, Project } from "@/lib/types";
import { formatRelativeTime, titleFromMessage } from "@/lib/utils";
import { useAuthStore } from "@/stores/authStore";
import { useChatStore } from "@/stores/chatStore";
import { useConversationStore } from "@/stores/conversationStore";
import { useDocumentStore } from "@/stores/documentStore";
import { useGroupStore } from "@/stores/groupStore";
import { useProjectStore } from "@/stores/projectStore";

type WorkspaceMode = "admin" | null;

const conversationIconMap = {
  brain: Brain,
  sigma: Sigma,
  file: FileText,
  search: Search,
  globe: Globe,
  chart: ChartColumn,
  wrench: Wrench,
  message: MessageSquareMore,
} as const;

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
    needsClarification:
      message.role === "assistant" &&
      (message.citations?.citations?.length ?? 0) === 0 &&
      /\?$/.test(message.content.trim()),
  };
}

function AdminWorkspaceView() {
  const groups = useGroupStore((state) => state.groups);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(groups[0]?.id ?? null);

  useEffect(() => {
    if (!selectedGroupId && groups[0]?.id) {
      setSelectedGroupId(groups[0].id);
    }
  }, [groups, selectedGroupId]);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-4 rounded-[24px] border border-line bg-white/55 p-2">
        <button type="button" className="w-full rounded-2xl bg-accentSoft px-3 py-2 text-left text-sm text-accent">
          People
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {selectedGroupId ? (
          <UserAssignment groupId={selectedGroupId} />
        ) : (
          <div className="rounded-[26px] border border-dashed border-line p-6 text-center text-sm text-muted">
            Create a group in Library first, then assign people to it.
          </div>
        )}
      </div>
    </div>
  );
}

function LibraryDialog({
  open,
  onOpenChange,
  groups,
  activeGroupId,
  isAdmin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: Group[];
  activeGroupId: string | null;
  isAdmin: boolean;
}) {
  const setActiveGroup = useGroupStore((state) => state.setActiveGroup);
  const fetchDocuments = useDocumentStore((state) => state.fetchDocuments);
  const clearSelection = useDocumentStore((state) => state.clearSelection);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(activeGroupId ?? groups[0]?.id ?? null);

  const documentCount = useMemo(
    () => groups.reduce((total, group) => total + group.document_count, 0),
    [groups],
  );
  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) ?? null,
    [groups, selectedGroupId],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const nextSelectedGroupId =
      activeGroupId && groups.some((group) => group.id === activeGroupId)
        ? activeGroupId
        : groups[0]?.id ?? null;
    setSelectedGroupId(nextSelectedGroupId);
  }, [activeGroupId, groups, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    if (!selectedGroupId || !groups.some((group) => group.id === selectedGroupId)) {
      if (selectedGroupId !== null) {
        setSelectedGroupId(groups[0]?.id ?? null);
      }
      return;
    }
    setActiveGroup(selectedGroupId);
    clearSelection();
    void fetchDocuments(selectedGroupId);
  }, [clearSelection, fetchDocuments, groups, open, selectedGroupId, setActiveGroup]);

  function handleSelectProject(groupId: string | null) {
    setSelectedGroupId(groupId);
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/18 backdrop-blur-[18px]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[60] flex h-[min(860px,calc(100vh-2rem))] w-[min(1120px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[34px] border border-black/[0.06] bg-white p-6 shadow-[0_30px_80px_rgba(17,17,17,0.14)] outline-none"
          onPointerDownOutside={() => onOpenChange(false)}
        >
          <div className="flex items-start justify-between gap-4 border-b border-black/[0.06] pb-5">
            <div className="flex items-center gap-4">
              <span className="rounded-full bg-black p-3 text-white">
                <FolderCog className="h-5 w-5" />
              </span>
              <div>
                <Dialog.Title className="font-display text-[1.875rem] font-semibold tracking-[-0.04em] text-ink">
                  Library
                </Dialog.Title>
                <p className="mt-1 text-sm text-muted">
                  Upload PDFs, create groups, and prepare documents for RAG.
                </p>
              </div>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
                aria-label="Close library"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          <div className="mt-5 grid min-h-0 flex-1 gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
            <div className="flex min-h-0 flex-col overflow-hidden">
              <div className="mb-4 grid grid-cols-2 gap-3">
                <div className="rounded-[24px] bg-black px-4 py-4 text-white">
                  <p className="text-2xl font-semibold tracking-[-0.04em]">{groups.length}</p>
                  <p className="mt-1 text-xs uppercase tracking-[0.16em] text-white/65">Groups</p>
                </div>
                <div className="rounded-[24px] bg-black/[0.04] px-4 py-4">
                  <p className="text-2xl font-semibold tracking-[-0.04em] text-ink">{documentCount}</p>
                  <p className="mt-1 text-xs uppercase tracking-[0.16em] text-muted">PDFs</p>
                </div>
              </div>

              <div className="min-h-0 flex-1">
                <GroupManager selectedGroupId={selectedGroupId} onSelectGroup={handleSelectProject} />
              </div>
            </div>

            <div className="flex min-h-0 flex-col overflow-hidden">
              <div className="rounded-[28px] bg-black/[0.03] p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">
                      RAG Intake
                    </p>
                    <p className="mt-2 text-[1.625rem] font-semibold tracking-[-0.04em] text-ink">
                      {selectedGroup?.name ?? "Choose a group"}
                    </p>
                    <p className="mt-2 max-w-xl text-sm leading-6 text-muted">
                      {selectedGroup
                        ? "Add PDFs to this group and the system will index them so they are ready for retrieval and grounded answers."
                        : "Select a group first. PDF upload stays disabled until a group is selected."}
                    </p>
                  </div>
                  {selectedGroup ? (
                    <Badge className="bg-black text-white">{selectedGroup.document_count} PDFs</Badge>
                  ) : null}
                </div>
              </div>

              <div className="mt-4 min-h-0 flex-1">
                {isAdmin ? (
                  <DocumentUploader groupId={selectedGroup?.id ?? null} />
                ) : (
                  <div className="rounded-[26px] border border-dashed border-line p-8 text-center text-sm text-muted">
                    Only admins can upload PDFs to the library.
                  </div>
                )}
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SettingsDialog({
  open,
  onOpenChange,
  userName,
  userRole,
  isAdmin,
  groups,
  activeGroupId,
  onOpenLibrary,
  onOpenAdmin,
  onLogout,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userName: string;
  userRole: string;
  isAdmin: boolean;
  groups: Group[];
  activeGroupId: string | null;
  onOpenLibrary: () => void;
  onOpenAdmin: () => void;
  onLogout: () => void;
}) {
  const documentCount = useMemo(
    () => groups.reduce((total, group) => total + group.document_count, 0),
    [groups],
  );
  const activeGroup = useMemo(
    () => groups.find((group) => group.id === activeGroupId) ?? groups[0] ?? null,
    [activeGroupId, groups],
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/18 backdrop-blur-[18px]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 w-[min(460px,calc(100vw-2rem))] max-h-[min(720px,calc(100vh-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[30px] border border-black/[0.06] bg-white p-6 shadow-[0_24px_60px_rgba(17,17,17,0.12)] outline-none"
          onPointerDownOutside={() => onOpenChange(false)}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-4">
              <span className="rounded-full bg-black p-3 text-white">
                <Settings2 className="h-5 w-5" />
              </span>
              <div>
                <Dialog.Title className="font-display text-[1.625rem] font-semibold tracking-[-0.04em] text-ink">
                  Settings
                </Dialog.Title>
                <p className="mt-1 text-sm text-muted">{userName} / {userRole}</p>
              </div>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
                aria-label="Close settings"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          <div className="mt-6">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">
              Choose workspace
            </p>
            <p className="mt-2 text-sm leading-6 text-muted">
              Open the library to manage groups and PDFs, or open admin to manage users and access.
            </p>
          </div>

          <div className="mt-5 grid gap-3">
            <button
              type="button"
              className="rounded-[28px] bg-black px-5 py-5 text-left text-white transition hover:bg-black/92"
              onClick={onOpenLibrary}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <span className="rounded-full bg-white/12 p-2.5">
                      <FolderCog className="h-4 w-4" />
                    </span>
                    <div>
                      <p className="text-base font-semibold">Library</p>
                      <p className="mt-1 text-sm text-white/70">
                        Groups, PDFs, and document organization.
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Badge className="bg-white/10 text-white">{groups.length} groups</Badge>
                    <Badge className="bg-white/10 text-white">{documentCount} PDFs</Badge>
                    <Badge className="bg-white/10 text-white">
                      {activeGroup?.name ?? "No active group"}
                    </Badge>
                  </div>
                </div>
                <ArrowLeft className="h-4 w-4 rotate-180 text-white/80" />
              </div>
            </button>

            {isAdmin ? (
              <button
                type="button"
                className="rounded-[28px] bg-black/[0.04] px-5 py-5 text-left text-ink transition hover:bg-black/[0.06]"
                onClick={onOpenAdmin}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-3">
                      <span className="rounded-full bg-black p-2.5 text-white">
                        <Shield className="h-4 w-4" />
                      </span>
                      <div>
                        <p className="text-base font-semibold">Admin</p>
                        <p className="mt-1 text-sm text-muted">
                          Create users and assign group access.
                        </p>
                      </div>
                    </div>
                    <div className="mt-4">
                      <Badge>People and permissions</Badge>
                    </div>
                  </div>
                  <ArrowLeft className="h-4 w-4 rotate-180 text-muted" />
                </div>
              </button>
            ) : null}
          </div>

          <div className="mt-4">
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-[24px] bg-black/[0.04] px-5 py-4 text-left text-ink transition hover:bg-black/[0.06]"
              onClick={onLogout}
            >
              <span className="flex items-center gap-3">
                <LogOut className="h-4 w-4" />
                <span className="text-sm font-medium">Sign out</span>
              </span>
              <ArrowLeft className="h-4 w-4 rotate-180" />
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
  const deletedConversationIds = useConversationStore((state) => state.deletedConversationIds);
  const startNewConversation = useConversationStore((state) => state.startNewConversation);
  const fetchConversations = useConversationStore((state) => state.fetchConversations);
  const projects = useProjectStore((state) => state.projects);
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const deletedProjectIds = useProjectStore((state) => state.deletedProjectIds);
  const createProject = useProjectStore((state) => state.createProject);
  const deleteProject = useProjectStore((state) => state.deleteProject);
  const setActiveProject = useProjectStore((state) => state.setActiveProject);
  const groups = useGroupStore((state) => state.groups);
  const activeGroupId = useGroupStore((state) => state.activeGroupId);
  const setActiveGroup = useGroupStore((state) => state.setActiveGroup);
  const fetchDocuments = useDocumentStore((state) => state.fetchDocuments);
  const clearSelection = useDocumentStore((state) => state.clearSelection);
  const hydrateMessages = useChatStore((state) => state.hydrateMessages);
  const clearChat = useChatStore((state) => state.clearChat);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<Project | null>(null);
  const [deleteProjectText, setDeleteProjectText] = useState("");
  const [deleteConversationTarget, setDeleteConversationTarget] = useState<ConversationSummary | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setCreateProjectOpen(true);
      }
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  useEffect(() => {
    setExpandedProjects((current) => {
      const next = { ...current };
      let changed = false;

      for (const project of projects) {
        if (!(project.id in next)) {
          next[project.id] =
            project.id === activeProjectId || (!activeProjectId && projects[0]?.id === project.id);
          changed = true;
        }
      }

      for (const key of Object.keys(next)) {
        if (!projects.some((project) => project.id === key)) {
          delete next[key];
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [activeProjectId, projects]);

  const filteredConversations = useMemo(() => {
    const needle = searchTerm.toLowerCase();
    return conversations.filter((conversation) =>
      (conversation.title ?? "").toLowerCase().includes(needle),
    );
  }, [conversations, searchTerm]);

  const grouped = useMemo(() => {
    const groupedById = filteredConversations.reduce<Record<string, typeof filteredConversations>>(
      (acc, conversation) => {
        const key = conversation.project_id ?? "unassigned";
        acc[key] ??= [];
        acc[key].push(conversation);
        return acc;
      },
      {},
    );

    const sections = projects.map((project) => ({
      id: project.id,
      label: deletedProjectIds[project.id] ? "Deleted" : project.name,
      isDeleted: !!deletedProjectIds[project.id],
      items: groupedById[project.id] ?? [],
    }));

    const otherItems = groupedById.unassigned ?? [];

    if (otherItems.length) {
      sections.push({
        id: "unassigned",
        label: "Unassigned",
        isDeleted: false,
        items: otherItems,
      });
    }

    return sections;
  }, [deletedProjectIds, filteredConversations, projects]);

  function closeDeleteProjectDialog() {
    setDeleteProjectTarget(null);
    setDeleteProjectText("");
  }

  function closeCreateProjectDialog() {
    setCreateProjectOpen(false);
    setProjectNameDraft("");
  }

  async function handleSelectConversation(
    conversationId: string,
    projectId: string | null,
    groupId: string | null,
  ) {
    setActiveProject(projectId);
    if (groupId) {
      setActiveGroup(groupId);
      clearSelection();
      await fetchDocuments(groupId);
    }
    const detail = await loadConversation(conversationId);
    hydrateMessages(detail.messages.map(mapMessage));
  }

  function toggleProjectSection(projectId: string) {
    setExpandedProjects((current) => ({
      ...current,
      [projectId]: !current[projectId],
    }));
  }

  async function handleCreateProject() {
    const name = projectNameDraft.trim();
    if (!name) {
      return;
    }

    setCreatingProject(true);
    try {
      const project = await createProject({ name });
      setActiveProject(project.id);
      clearChat();
      startNewConversation();
      setProjectNameDraft("");
      setCreateProjectOpen(false);
      await fetchConversations();
    } finally {
      setCreatingProject(false);
    }
  }

  async function handleStartChat(projectId: string) {
    setExpandedProjects((current) => ({
      ...current,
      [projectId]: true,
    }));
    setActiveProject(projectId);
    clearChat();
    startNewConversation();
    await fetchConversations();
  }

  async function handleDeleteProject() {
    if (!deleteProjectTarget || deleteProjectText.trim().toLowerCase() !== "delete") {
      return;
    }

    setDeletingProject(true);
    try {
      await deleteProject(deleteProjectTarget.id);
      if (activeProjectId === deleteProjectTarget.id) {
        clearChat();
        startNewConversation();
      }
      setDeleteProjectTarget(null);
      setDeleteProjectText("");
      await fetchConversations();
    } finally {
      setDeletingProject(false);
    }
  }

  return (
    <div className="flex h-full flex-col px-4 py-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-black/[0.05] p-2 text-ink">
            {workspaceMode === "admin" ? <Shield className="h-4 w-4" /> : <History className="h-4 w-4" />}
          </span>
          <div>
            <p className="font-display text-[1.75rem] font-semibold tracking-[-0.04em] text-ink">
              {workspaceMode === "admin" ? "Admin" : "History"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!workspaceMode ? (
            <>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                onClick={() => setSearchOpen((current) => !current)}
                title="Search"
                aria-label="Search"
              >
                <Search className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                onClick={() => setCreateProjectOpen(true)}
                title="Create project"
                aria-label="Create project"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <Button type="button" variant="ghost" size="icon" onClick={() => setWorkspaceMode(null)}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {!workspaceMode ? (
        <>
          {searchOpen || searchTerm ? (
            <div className="relative mb-4">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <Input
                id="history-search"
                ref={searchInputRef}
                placeholder="Search"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                className="pl-11 pr-11"
              />
              {(searchTerm || searchOpen) && (
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted transition hover:bg-black/[0.05] hover:text-ink"
                  onClick={() => {
                    setSearchTerm("");
                    setSearchOpen(false);
                  }}
                  aria-label="Close search"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin pr-1">
            {grouped.map((section) => (
              <div key={section.id} className="group mb-5">
                <div className="mb-2 flex items-center justify-between gap-2 px-2">
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-2 text-left"
                    onClick={() => toggleProjectSection(section.id)}
                  >
                    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted">
                      {expandedProjects[section.id] ? (
                        <FolderOpen className="h-4 w-4 stroke-[1.8]" />
                      ) : (
                        <Folder className="h-4 w-4 stroke-[1.8]" />
                      )}
                    </span>
                    <p className="truncate text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                      {section.label}
                    </p>
                  </button>
                  {section.id !== "unassigned" ? (
                    <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="New chat"
                        aria-label={`New chat in ${section.label}`}
                        disabled={section.isDeleted}
                        onClick={() => void handleStartChat(section.id)}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="Delete project"
                        aria-label={`Delete ${section.label}`}
                        disabled={section.isDeleted}
                        onClick={() => {
                          const target = projects.find((project) => project.id === section.id) ?? null;
                          setDeleteProjectTarget(target);
                          setDeleteProjectText("");
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ) : null}
                </div>
                {expandedProjects[section.id] ? <div className="space-y-2">
                  {section.items.map((conversation) => (
                    (() => {
                      const isDeletedConversation = !!deletedConversationIds[conversation.id];
                      const ConversationIcon =
                        conversationIconMap[
                          (conversation.title_icon as keyof typeof conversationIconMap) || "message"
                        ] ?? MessageSquareMore;

                      return (
                    <div
                      key={conversation.id}
                      className={`group/conversation block w-full rounded-[24px] border px-4 py-3 text-left transition ${
                        isDeletedConversation
                          ? "border-danger/20 bg-danger/5 opacity-70"
                          : activeConversationId === conversation.id
                          ? "border-black/[0.08] bg-black/[0.03]"
                          : "border-transparent bg-black/[0.02] hover:bg-black/[0.04]"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-muted">
                          <ConversationIcon className="h-4 w-4" />
                        </span>
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          disabled={isDeletedConversation}
                          onClick={() =>
                            void handleSelectConversation(
                              conversation.id,
                              conversation.project_id,
                              conversation.group_id,
                            )
                          }
                        >
                          <p className="truncate text-sm font-semibold text-ink">
                            {isDeletedConversation
                              ? "Deleted"
                              : conversation.title || titleFromMessage("Untitled conversation")}
                          </p>
                          <div className="mt-2">
                            <span className="text-xs text-muted">
                              {isDeletedConversation ? "Deleting..." : formatRelativeTime(conversation.updated_at)}
                            </span>
                          </div>
                        </button>
                        {isDeletedConversation ? null : (
                          <button
                            type="button"
                            className="rounded-full p-2 text-muted opacity-0 transition hover:bg-danger/10 hover:text-danger group-hover/conversation:opacity-100 group-focus-within/conversation:opacity-100"
                            onClick={(event) => {
                              event.stopPropagation();
                              setDeleteConversationTarget(conversation);
                            }}
                            title="Delete"
                            aria-label="Delete conversation"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>
                      );
                    })()
                  ))}
                  {!section.items.length ? (
                    <div className="rounded-[22px] bg-black/[0.02] px-5 py-5 text-sm text-muted">
                      {section.isDeleted ? "Deleted" : "No chats in this project yet"}
                    </div>
                  ) : null}
                </div> : null}
              </div>
            ))}
            {!projects.length ? (
              <div className="rounded-[22px] bg-black/[0.02] px-6 py-7 text-center text-sm text-muted">
                <MessageSquareMore className="mx-auto mb-3 h-5 w-5 text-muted/80" />
                No projects yet
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <AdminWorkspaceView />
      )}

      <button
        type="button"
        className="mt-4 flex items-center justify-between rounded-[22px] bg-black/[0.03] px-4 py-4 text-left transition hover:bg-black/[0.05]"
        onClick={() => setSettingsOpen(true)}
        aria-label="Open settings"
      >
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-black p-2.5 text-white">
            <Settings2 className="h-3.5 w-3.5" />
          </span>
          <div>
            <p className="font-medium text-ink">Settings</p>
            <p className="text-xs uppercase tracking-[0.18em] text-muted">Account</p>
          </div>
        </div>
        <span className="rounded-full bg-white p-2 text-muted shadow-[0_4px_12px_rgba(17,17,17,0.06)]">
          <Cog className="h-4 w-4" />
        </span>
      </button>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        userName={user?.name ?? "Unknown user"}
        userRole={user?.role ?? "guest"}
        isAdmin={user?.role === "admin"}
        groups={groups}
        activeGroupId={activeGroupId}
        onOpenLibrary={() => {
          setSettingsOpen(false);
          setLibraryOpen(true);
        }}
        onOpenAdmin={() => {
          setSettingsOpen(false);
          setWorkspaceMode("admin");
        }}
        onLogout={() => {
          setSettingsOpen(false);
          logout();
        }}
      />

      <LibraryDialog
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        groups={groups}
        activeGroupId={activeGroupId}
        isAdmin={user?.role === "admin"}
      />

      <Dialog.Root
        open={deleteProjectTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeDeleteProjectDialog();
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/18 backdrop-blur-[18px]" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-[80] w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[30px] border border-black/[0.06] bg-white p-6 shadow-[0_24px_60px_rgba(17,17,17,0.12)] outline-none"
            onPointerDownOutside={closeDeleteProjectDialog}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="font-display text-[1.5rem] font-semibold tracking-[-0.04em] text-ink">
                  Delete project
                </Dialog.Title>
                <p className="mt-2 text-sm leading-6 text-muted">
                  Type <span className="font-semibold text-ink">delete</span> to remove{" "}
                  <span className="font-semibold text-ink">{deleteProjectTarget?.name ?? "this project"}</span>.
                </p>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
                  aria-label="Close delete project dialog"
                >
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>

            <div className="mt-5 space-y-3">
              <Input
                placeholder='Type "delete"'
                value={deleteProjectText}
                onChange={(event) => setDeleteProjectText(event.target.value)}
              />
              <div className="flex gap-3">
                <Dialog.Close asChild>
                  <Button type="button" variant="secondary" className="flex-1">
                    Cancel
                  </Button>
                </Dialog.Close>
                <Button
                  type="button"
                  variant="danger"
                  className="flex-1"
                  disabled={deleteProjectText.trim().toLowerCase() !== "delete" || deletingProject}
                  onClick={() => void handleDeleteProject()}
                >
                  {deletingProject ? "Deleting..." : "Delete project"}
                </Button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <DeleteConfirmDialog
        open={deleteConversationTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteConversationTarget(null);
          }
        }}
        title="Delete conversation"
        description={
          <>
            Type <span className="font-semibold text-ink">delete</span> to remove{" "}
            <span className="font-semibold text-ink">
              {deleteConversationTarget?.title || titleFromMessage("this conversation")}
            </span>.
          </>
        }
        confirmLabel="Delete conversation"
        onConfirm={async () => {
          if (!deleteConversationTarget) {
            return;
          }
          await deleteConversation(deleteConversationTarget.id);
          await fetchConversations();
          setDeleteConversationTarget(null);
        }}
      />

      <Dialog.Root
        open={createProjectOpen}
        onOpenChange={(open) => {
          if (!open) {
            closeCreateProjectDialog();
            return;
          }
          setCreateProjectOpen(true);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/18 backdrop-blur-[18px]" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-[80] w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[30px] border border-black/[0.06] bg-white p-6 shadow-[0_24px_60px_rgba(17,17,17,0.12)] outline-none"
            onPointerDownOutside={closeCreateProjectDialog}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="font-display text-[1.5rem] font-semibold tracking-[-0.04em] text-ink">
                  Create project
                </Dialog.Title>
                <p className="mt-2 text-sm leading-6 text-muted">
                  Chats will be organized inside this project.
                </p>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
                  aria-label="Close create project dialog"
                >
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>

            <div className="mt-5 space-y-3">
              <Input
                placeholder="Project name"
                value={projectNameDraft}
                onChange={(event) => setProjectNameDraft(event.target.value)}
              />
              <Button
                type="button"
                className="w-full"
                disabled={!projectNameDraft.trim() || creatingProject}
                onClick={() => void handleCreateProject()}
              >
                <Plus className="h-4 w-4" />
                {creatingProject ? "Creating..." : "Create project"}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
