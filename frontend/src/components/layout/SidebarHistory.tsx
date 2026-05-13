"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Brain,
  Building2,
  ChartColumn,
  ChevronUp,
  Cog,
  FileText,
  Folder,
  FolderCog,
  FolderOpen,
  Globe,
  GraduationCap,
  History,
  Library,
  Lightbulb,
  PanelLeftClose,
  LogOut,
  MessageSquareMore,
  Plus,
  Search,
  Settings2,
  Shield,
  Sigma,
  Trash2,
  TableProperties,
  Users,
  Wrench,
  X,
} from "lucide-react";

import { DocumentUploader } from "@/components/admin/DocumentUploader";
import { IndexingStatus } from "@/components/admin/IndexingStatus";
import { GroupManager } from "@/components/admin/GroupManager";
import { usePDFViewerStore } from "@/stores/pdfViewerStore";
import { CompanyManager } from "@/components/admin/CompanyManager";
import { FeedbackManager } from "@/components/admin/FeedbackManager";
import { LearnReviewer } from "@/components/admin/LearnReviewer";
import { UserAssignment } from "@/components/admin/UserAssignment";
import { FeatureIdeaDialog } from "@/components/chat/FeatureIdeaDialog";
import { DestinationManagerDialog } from "@/components/settings/DestinationManagerDialog";
import { DeleteConfirmDialog } from "@/components/shared/DeleteConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDialogDismiss } from "@/hooks/useDialogDismiss";
import type { ChatMessage, ConversationSummary, Document, Group, MessageResponse, Project } from "@/lib/types";
import { formatRelativeTime, titleFromMessage } from "@/lib/utils";
import { useAuthStore } from "@/stores/authStore";
import { useChatStore } from "@/stores/chatStore";
import { useConversationStore } from "@/stores/conversationStore";
import { useDocumentStore } from "@/stores/documentStore";
import { useGroupStore } from "@/stores/groupStore";
import { useProjectStore } from "@/stores/projectStore";
import { useCompanyStore } from "@/stores/companyStore";

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

// Derive two-letter initials from a full name. "Disan Ssebowa B" → "DS";
// single-word names get the first two letters. Falls back to a single
// person glyph if the name is missing entirely.
function deriveInitials(name: string | null): string {
  if (!name) return "?";
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return ((parts[0]?.[0] ?? "") + (parts[parts.length - 1]?.[0] ?? "")).toUpperCase();
}

function AccountBar({
  userName,
  userEmail,
  onSuggestIdea,
  onOpenSettings,
  onLogout,
}: {
  userName: string | null;
  userEmail: string | null;
  onSuggestIdea: () => void;
  onOpenSettings: () => void;
  onLogout: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const initials = deriveInitials(userName);

  // Click-outside dismissal. Listens at window level rather than the
  // button so a click on the menu items doesn't immediately close
  // before the item's own onClick fires.
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (buttonRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  return (
    <div className="relative mt-2 border-t border-black/[0.05] pt-2">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition hover:bg-black/[0.04]"
      >
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black text-[10px] font-semibold uppercase tracking-wider text-white">
          {initials}
        </span>
        <span className="min-w-0 flex-1 truncate text-[14.5px] font-medium text-ink">
          {userName || userEmail || "Account"}
        </span>
        <ChevronUp
          className={`h-3.5 w-3.5 text-muted transition-transform ${
            menuOpen ? "" : "rotate-180"
          }`}
        />
      </button>
      {menuOpen ? (
        <div
          ref={menuRef}
          role="menu"
          className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-xl border border-black/[0.08] bg-panel py-1 shadow-[0_18px_44px_rgba(15,23,42,0.16)]"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              onSuggestIdea();
            }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-ink transition hover:bg-black/[0.04]"
          >
            <Lightbulb className="h-4 w-4 text-muted" />
            Suggest an idea
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              onOpenSettings();
            }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-ink transition hover:bg-black/[0.04]"
          >
            <Settings2 className="h-4 w-4 text-muted" />
            Settings
          </button>
          <div className="my-1 h-px bg-black/[0.06]" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              onLogout();
            }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-danger transition hover:bg-danger/[0.08]"
          >
            <LogOut className="h-4 w-4" />
            Log out
          </button>
        </div>
      ) : null}
    </div>
  );
}

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
    status: "done",
    needsClarification:
      message.role === "assistant" &&
      (message.citations?.citations?.length ?? 0) === 0 &&
      /\?$/.test(message.content.trim()),
  };
}

function AdminWorkspaceView() {
  const groups = useGroupStore((state) => state.groups);
  const activeGroupId = useGroupStore((state) => state.activeGroupId);
  const companies = useCompanyStore((state) => state.companies);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(groups[0]?.id ?? null);
  const [adminTab, setAdminTab] = useState<"people" | "companies" | "feedback" | "learn">("people");

  useEffect(() => {
    if (!selectedGroupId && groups[0]?.id) {
      setSelectedGroupId(groups[0].id);
    }
  }, [groups, selectedGroupId]);

  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? groups[0] ?? null;
  const ga4ConnectedCount = companies.filter((company) => !!company.ga4_property_id).length;
  const adsConnectedCount = companies.filter((company) => !!company.google_ads_customer_id).length;
  const configuredCompanyCount = companies.filter(
    (company) => !!company.ga4_property_id || !!company.google_ads_customer_id,
  ).length;
  const isPeopleTab = adminTab === "people";
  const isFeedbackTab = adminTab === "feedback";
  const isLearnTab = adminTab === "learn";
  const panelIcon = isLearnTab ? (
    <GraduationCap className="h-[18px] w-[18px]" />
  ) : isPeopleTab ? (
    <Users className="h-[18px] w-[18px]" />
  ) : isFeedbackTab ? (
    <MessageSquareMore className="h-[18px] w-[18px]" />
  ) : (
    <Building2 className="h-[18px] w-[18px]" />
  );

  return (
    <div className="grid h-full min-h-0 gap-5 lg:grid-cols-[292px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col overflow-y-auto rounded-[32px] border border-black/[0.05] bg-[linear-gradient(180deg,rgba(255,255,255,0.97),rgba(244,244,242,0.94))] p-6 shadow-[0_22px_50px_rgba(17,17,17,0.05),inset_0_1px_0_rgba(255,255,255,0.82)] scrollbar-thin">
        <div className="rounded-[28px] border border-black/[0.05] bg-[linear-gradient(180deg,rgba(255,255,255,0.94),rgba(248,248,247,0.9))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.88)]">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-[18px] border border-black/[0.05] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(241,241,239,0.92))] text-ink shadow-[0_10px_24px_rgba(17,17,17,0.04)]">
              {panelIcon}
            </span>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted">
                {isLearnTab
                  ? "Learn-mode QA"
                  : isPeopleTab
                    ? "People access"
                    : isFeedbackTab
                      ? "Feedback loop"
                      : "Company access"}
              </p>
              <p className="mt-1 text-sm font-medium text-muted">
                {isLearnTab
                  ? "Review sections, concepts, and questions"
                  : isPeopleTab
                    ? "Roles, users, and workspace visibility"
                    : isFeedbackTab
                      ? "Ratings, ideas, and product signals"
                      : "Google source ownership and availability"}
              </p>
            </div>
          </div>
          <p className="mt-5 font-display text-[1.7rem] font-semibold tracking-[-0.05em] text-ink">
            {isLearnTab
              ? "Learn-mode review"
              : isPeopleTab
                ? "User control"
                : isFeedbackTab
                  ? "User signals"
                  : "Source catalog"}
          </p>
          <p className="mt-2 text-sm leading-6 text-muted">
            {isLearnTab
              ? "Spot-check LLM-generated section trees, concept graphs, and check-in questions. Edit, regenerate, or delete the wrong ones."
              : isPeopleTab
                ? "Create Maia users, assign them to groups, and manage workspace access."
                : isFeedbackTab
                  ? "Review response ratings and collect feature ideas from Maia users."
                  : "Register company source records here. Google setup stays separate from projects and chat structure."}
          </p>
        </div>

        <div className="mt-4 rounded-[26px] border border-black/[0.05] bg-[linear-gradient(180deg,rgba(255,255,255,0.94),rgba(247,247,246,0.9))] p-4 shadow-[0_10px_24px_rgba(17,17,17,0.03)]">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-[20px] bg-white/88 px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                {isPeopleTab ? "Groups" : isFeedbackTab ? "Ratings" : "Companies"}
              </p>
              <p className="mt-2 text-[1.75rem] font-semibold tracking-[-0.05em] text-ink">
                {isPeopleTab ? groups.length : isFeedbackTab ? "Live" : companies.length}
              </p>
            </div>
            <div className="rounded-[20px] bg-white/88 px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                {isPeopleTab ? "Active" : isFeedbackTab ? "Ideas" : "Configured"}
              </p>
              <p className="mt-2 text-[1.75rem] font-semibold tracking-[-0.05em] text-ink">
                {isPeopleTab ? (activeGroup ? "1" : "0") : isFeedbackTab ? "Open" : configuredCompanyCount}
              </p>
            </div>
          </div>
        </div>

        {!isPeopleTab && !isFeedbackTab ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="rounded-full border border-black/[0.05] bg-white/92 px-3 py-1.5 text-xs font-medium text-ink">
              {ga4ConnectedCount} GA4 linked
            </span>
            <span className="rounded-full border border-black/[0.05] bg-white/92 px-3 py-1.5 text-xs font-medium text-ink">
              {adsConnectedCount} Ads linked
            </span>
          </div>
        ) : null}

        <div className="mt-4 rounded-[26px] border border-black/[0.05] bg-white/78 p-2.5 shadow-[0_10px_24px_rgba(17,17,17,0.03)]">
          <button
            type="button"
            className={`flex w-full items-center gap-3 rounded-[20px] px-3.5 py-3.5 text-left transition ${
              adminTab === "people"
                ? "bg-white text-ink shadow-[0_12px_28px_rgba(17,17,17,0.06)]"
                : "text-ink/90 hover:bg-white/75"
            }`}
            onClick={() => setAdminTab("people")}
          >
            <span
              className={`inline-flex h-11 w-11 items-center justify-center rounded-[16px] border ${
                adminTab === "people"
                  ? "border-black/[0.06] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(242,242,240,0.92))] text-ink shadow-[0_10px_22px_rgba(17,17,17,0.05)]"
                  : "border-transparent bg-black/[0.04] text-muted"
              }`}
            >
              <Users className="h-[18px] w-[18px]" />
            </span>
            <span className="min-w-0">
              <span className="block text-[15px] font-semibold tracking-[-0.02em]">People</span>
              <span className="mt-0.5 block text-xs leading-5 text-muted">
                Create Maia users and assign them to groups.
              </span>
            </span>
          </button>

          <button
            type="button"
            className={`mt-2 flex w-full items-center gap-3 rounded-[20px] px-3.5 py-3.5 text-left transition ${
              adminTab === "feedback"
                ? "bg-white text-ink shadow-[0_12px_28px_rgba(17,17,17,0.06)]"
                : "text-ink/90 hover:bg-white/75"
            }`}
            onClick={() => setAdminTab("feedback")}
          >
            <span
              className={`inline-flex h-11 w-11 items-center justify-center rounded-[16px] border ${
                adminTab === "feedback"
                  ? "border-black/[0.06] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(242,242,240,0.92))] text-ink shadow-[0_10px_22px_rgba(17,17,17,0.05)]"
                  : "border-transparent bg-black/[0.04] text-muted"
              }`}
            >
              <MessageSquareMore className="h-[18px] w-[18px]" />
            </span>
            <span className="min-w-0">
              <span className="block text-[15px] font-semibold tracking-[-0.02em]">Feedback</span>
              <span className="mt-0.5 block text-xs leading-5 text-muted">
                Review ratings and feature ideas.
              </span>
            </span>
          </button>

          <button
            type="button"
            className={`mt-2 flex w-full items-center gap-3 rounded-[20px] px-3.5 py-3.5 text-left transition ${
              adminTab === "companies"
                ? "bg-white text-ink shadow-[0_12px_28px_rgba(17,17,17,0.06)]"
                : "text-ink/90 hover:bg-white/75"
            }`}
            onClick={() => setAdminTab("companies")}
          >
            <span
              className={`inline-flex h-11 w-11 items-center justify-center rounded-[16px] border ${
                adminTab === "companies"
                  ? "border-black/[0.06] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(242,242,240,0.92))] text-ink shadow-[0_10px_22px_rgba(17,17,17,0.05)]"
                  : "border-transparent bg-black/[0.04] text-muted"
              }`}
            >
              <Building2 className="h-[18px] w-[18px]" />
            </span>
            <span className="min-w-0">
              <span className="block text-[15px] font-semibold tracking-[-0.02em]">Companies</span>
              <span className="mt-0.5 block text-xs leading-5 text-muted">
                Register source owners and Google IDs.
              </span>
            </span>
          </button>

          <button
            type="button"
            className={`mt-2 flex w-full items-center gap-3 rounded-[20px] px-3.5 py-3.5 text-left transition ${
              adminTab === "learn"
                ? "bg-white text-ink shadow-[0_12px_28px_rgba(17,17,17,0.06)]"
                : "text-ink/90 hover:bg-white/75"
            }`}
            onClick={() => setAdminTab("learn")}
          >
            <span
              className={`inline-flex h-11 w-11 items-center justify-center rounded-[16px] border ${
                adminTab === "learn"
                  ? "border-black/[0.06] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(242,242,240,0.92))] text-ink shadow-[0_10px_22px_rgba(17,17,17,0.05)]"
                  : "border-transparent bg-black/[0.04] text-muted"
              }`}
            >
              <GraduationCap className="h-[18px] w-[18px]" />
            </span>
            <span className="min-w-0">
              <span className="block text-[15px] font-semibold tracking-[-0.02em]">Learn QA</span>
              <span className="mt-0.5 block text-xs leading-5 text-muted">
                Review and correct LLM-generated learn-mode content.
              </span>
            </span>
          </button>
        </div>

        {isPeopleTab ? (
          <div className="mt-auto rounded-[26px] border border-black/[0.05] bg-[linear-gradient(180deg,rgba(255,255,255,0.94),rgba(247,247,246,0.9))] p-5 shadow-[0_10px_24px_rgba(17,17,17,0.03)]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Current group</p>
            <p className="mt-3 text-[1.05rem] font-semibold tracking-[-0.03em] text-ink">
              {activeGroup?.name ?? "No active group"}
            </p>
            <p className="mt-2 text-sm leading-6 text-muted">
              User assignment applies to the selected library group.
            </p>
          </div>
        ) : isFeedbackTab ? (
          <div className="mt-auto rounded-[26px] border border-black/[0.05] bg-[linear-gradient(180deg,rgba(255,255,255,0.94),rgba(247,247,246,0.9))] p-5 shadow-[0_10px_24px_rgba(17,17,17,0.03)]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Product loop</p>
            <p className="mt-3 text-[1.05rem] font-semibold tracking-[-0.03em] text-ink">
              User-rated Maia responses
            </p>
            <p className="mt-2 text-sm leading-6 text-muted">
              Use this to find exceptional answers, poor responses, and ideas worth building.
            </p>
          </div>
        ) : (
          <div className="mt-auto rounded-[26px] border border-black/[0.05] bg-[linear-gradient(180deg,rgba(255,255,255,0.94),rgba(247,247,246,0.9))] p-5 shadow-[0_10px_24px_rgba(17,17,17,0.03)]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Company setup</p>
            <p className="mt-3 text-[1.05rem] font-semibold tracking-[-0.03em] text-ink">
              {ga4ConnectedCount} GA4 · {adsConnectedCount} Ads
            </p>
            <p className="mt-2 text-sm leading-6 text-muted">
              Company records here are independent from projects, chats, and library groups.
            </p>
          </div>
        )}
      </aside>

      <section className="min-h-0 overflow-hidden rounded-[30px] border border-black/[0.06] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(247,247,246,0.95))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)]">
        <div className="mb-5 flex items-start justify-between gap-4 border-b border-black/[0.06] pb-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
              {adminTab === "companies"
                ? "Company management"
                : adminTab === "feedback"
                  ? "Feedback review"
                  : adminTab === "learn"
                    ? "Learn-mode review"
                    : "People management"}
            </p>
            <p className="mt-2 font-display text-[1.55rem] font-semibold tracking-[-0.04em] text-ink">
              {adminTab === "companies"
                ? "Company sources"
                : adminTab === "feedback"
                  ? "Ratings and ideas"
                  : adminTab === "learn"
                    ? "Section, concept, and question QA"
                    : "Users and assignment"}
            </p>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
              {adminTab === "companies"
                ? "Create company source records, attach GA4 and Google Ads IDs, and control which users can select them in chat."
                : adminTab === "feedback"
                  ? "Review thumbs up/down signals, comments, and feature ideas submitted by Maia users."
                  : adminTab === "learn"
                    ? "Drill into each book to see the LLM-generated section tree, concept graph, and check-in questions. Flagged items appear first; edit or regenerate the ones that look wrong."
                    : "Create Maia users and assign them to the library groups they should access."}
            </p>
          </div>
        </div>

        <div className="min-h-0 h-[calc(100%-5.25rem)] overflow-y-auto scrollbar-thin">
          {adminTab === "companies" ? (
            <CompanyManager />
          ) : adminTab === "feedback" ? (
            <FeedbackManager />
          ) : adminTab === "learn" ? (
            <LearnReviewer />
          ) : selectedGroupId ? (
            <UserAssignment groupId={selectedGroupId} />
          ) : (
            <div className="rounded-[26px] border border-dashed border-line p-6 text-center text-sm text-muted">
              Create a group in Library first, then assign people to it.
            </div>
          )}
        </div>
      </section>
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
  const documentsByGroup = useDocumentStore((state) => state.documentsByGroup);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(activeGroupId ?? groups[0]?.id ?? null);
  // Preview dialog is mounted once at AppShell level so the loaded
  // PDFDocumentProxy survives close/re-open cycles. Library cards
  // dispatch to the store; the dialog reads ``previewDocument``.
  const openPreview = usePDFViewerStore((s) => s.openPreview);

  const documentCount = useMemo(
    () => groups.reduce((total, group) => total + group.document_count, 0),
    [groups],
  );
  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) ?? null,
    [groups, selectedGroupId],
  );
  const {
    handleOpenChange,
    handlePointerDownOutside,
    handleEscapeKeyDown,
    handleFocusOutside,
    handleInteractOutside,
    requestClose,
  } = useDialogDismiss(() => onOpenChange(false));

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
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/18 backdrop-blur-[18px]" onDoubleClick={requestClose} />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[60] flex h-[min(860px,calc(100vh-2rem))] w-[min(1120px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[34px] border border-black/[0.06] bg-panel p-6 shadow-[0_30px_80px_rgba(17,17,17,0.14)] outline-none"
          onPointerDownOutside={handlePointerDownOutside}
          onEscapeKeyDown={handleEscapeKeyDown}
          onFocusOutside={handleFocusOutside}
          onInteractOutside={handleInteractOutside}
        >
          {/* Tightened header — single line, no oversized icon or
              subtitle that the screen wasn't reading. */}
          <div className="flex items-center justify-between gap-4 pb-4">
            <Dialog.Title className="text-[1.5rem] font-semibold tracking-[-0.03em] text-ink">
              Library
            </Dialog.Title>
            <button
              type="button"
              className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
              aria-label="Close library"
              onClick={requestClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid min-h-0 flex-1 gap-6 border-t border-black/[0.06] pt-4 lg:grid-cols-[280px_minmax(0,1fr)]">
            {/* LEFT: just the group list. No stat cards, no
                duplicated counts — the list itself communicates the
                same info. */}
            <div className="flex min-h-0 flex-col overflow-hidden">
              <GroupManager selectedGroupId={selectedGroupId} onSelectGroup={handleSelectProject} />
            </div>

            {/* RIGHT: documents in the selected group. The huge "RAG
                INTAKE / Add PDFs..." explanatory card is gone — the
                group name + PDF count sit inline as a small header,
                everything else is the document list / uploader. */}
            <div className="flex min-h-0 flex-col overflow-hidden">
              <div className="mb-4 flex items-baseline justify-between gap-3">
                <p className="text-[1.125rem] font-semibold text-ink">
                  {selectedGroup?.name ?? "Choose a group"}
                </p>
                {selectedGroup ? (
                  <p className="text-[12px] text-muted">
                    {selectedGroup.document_count}{" "}
                    {selectedGroup.document_count === 1 ? "PDF" : "PDFs"}
                  </p>
                ) : null}
              </div>

              <div className="min-h-0 flex-1">
                {isAdmin ? (
                  <DocumentUploader groupId={selectedGroup?.id ?? null} />
                ) : (
                  <ReadOnlyDocumentList
                    documents={selectedGroup ? documentsByGroup[selectedGroup.id] ?? [] : []}
                    groupId={selectedGroup?.id ?? ""}
                    onOpen={(doc) => openPreview(doc)}
                  />
                )}
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ReadOnlyDocumentList({
  documents,
  groupId,
  onOpen,
}: {
  documents: Document[];
  groupId: string;
  onOpen: (doc: Document) => void;
}) {
  if (!groupId) {
    return (
      <div className="rounded-[26px] border border-dashed border-line p-8 text-center text-sm text-muted">
        Select a group to browse its PDFs.
      </div>
    );
  }

  if (!documents.length) {
    return (
      <div className="flex h-full min-h-[220px] items-center justify-center rounded-[26px] border border-dashed border-line bg-white/55 px-6 text-center text-sm text-muted">
        No PDFs in this group yet.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto pr-1 scrollbar-thin">
      <p className="px-1 pb-3 text-[11px] font-medium uppercase tracking-[0.16em] text-muted">
        Click a PDF to read it. Only admins can upload or delete.
      </p>
      <div className="space-y-3">
        {documents.map((doc) => (
          <IndexingStatus
            key={doc.id}
            document={doc}
            groupId={groupId}
            onOpen={onOpen}
            readOnly
          />
        ))}
      </div>
    </div>
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
  onOpenDestinations,
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
  onOpenDestinations: () => void;
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
  const {
    handleOpenChange,
    handlePointerDownOutside,
    handleEscapeKeyDown,
    handleFocusOutside,
    handleInteractOutside,
    requestClose,
  } = useDialogDismiss(() => onOpenChange(false));

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/18 backdrop-blur-[18px]" onDoubleClick={requestClose} />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 flex w-[min(460px,calc(100vw-2rem))] max-h-[min(720px,calc(100vh-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[30px] border border-black/[0.06] bg-panel p-6 shadow-[0_24px_60px_rgba(17,17,17,0.12)] outline-none"
          onPointerDownOutside={handlePointerDownOutside}
          onEscapeKeyDown={handleEscapeKeyDown}
          onFocusOutside={handleFocusOutside}
          onInteractOutside={handleInteractOutside}
        >
          {/* Header stays fixed at the top; everything below scrolls
              when the dialog is taller than the viewport (e.g. on
              shorter screens, or once we add more workspace tiles). */}
          <div className="flex shrink-0 items-start justify-between gap-4">
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
            <button
              type="button"
              className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
              aria-label="Close settings"
              onClick={requestClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="-mr-2 mt-6 min-h-0 flex-1 overflow-y-auto pr-2 scrollbar-thin">

          <div className="">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">
              Choose workspace
            </p>
            <p className="mt-2 text-sm leading-6 text-muted">
              Manage your destinations, account, and{isAdmin ? " admin access" : " preferences"}.
            </p>
          </div>

          <div className="mt-5 grid gap-3">
            {/* Library entry removed from Settings — now a top-level
                sidebar item above the project list. */}
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

            <button
              type="button"
              className="rounded-[28px] bg-black/[0.04] px-5 py-5 text-left text-ink transition hover:bg-black/[0.06]"
              onClick={onOpenDestinations}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <span className="rounded-full bg-black p-2.5 text-white">
                      <TableProperties className="h-4 w-4" />
                    </span>
                    <div>
                      <p className="text-base font-semibold">Destinations</p>
                      <p className="mt-1 text-sm text-muted">
                        Connect Google Docs and Sheets for report exports.
                      </p>
                    </div>
                  </div>
                  <div className="mt-4">
                    <Badge>Docs and Sheets</Badge>
                  </div>
                </div>
                <ArrowLeft className="h-4 w-4 rotate-180 text-muted" />
              </div>
            </button>
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
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function SidebarHistory({
  onModalStateChange,
  onCollapseSidebar,
  searchOpenNonce = 0,
}: {
  onModalStateChange?: (open: boolean) => void;
  // When provided, the header renders a collapse button next to
  // Search / +. Clicking it tells the parent (AppShell) to fold the
  // sidebar back to its 56px icon rail. Same UX as Claude / ChatGPT.
  onCollapseSidebar?: () => void;
  // Bumped by AppShell when the user clicks the Search icon from
  // the collapsed rail. We pop the search input open and focus it.
  // Using a nonce (not a boolean) means repeated clicks keep
  // re-focusing even after the user has dismissed it.
  searchOpenNonce?: number;
}) {
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
  const getCachedMessagesForConversation = useChatStore((state) => state.getCachedMessagesForConversation);
  const clearChat = useChatStore((state) => state.clearChat);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [ideaOpen, setIdeaOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [destinationsOpen, setDestinationsOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<Project | null>(null);
  const [deleteConversationTarget, setDeleteConversationTarget] = useState<ConversationSummary | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // React to the parent's "open search" nonce — clicking the search
  // icon in the collapsed rail bumps this counter, and we respond by
  // opening the search row and focusing its input.
  useEffect(() => {
    if (searchOpenNonce > 0) {
      setSearchOpen(true);
      window.setTimeout(() => searchInputRef.current?.focus(), 60);
    }
  }, [searchOpenNonce]);

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
        if (!conversation.project_id) {
          return acc;
        }
        const key = conversation.project_id;
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

      return sections;
  }, [deletedProjectIds, filteredConversations, projects]);

  function closeDeleteProjectDialog() {
    setDeleteProjectTarget(null);
  }

  function closeCreateProjectDialog() {
    setCreateProjectOpen(false);
    setProjectNameDraft("");
  }

  const {
    handleOpenChange: handleAdminOpenChange,
    handlePointerDownOutside: handleAdminPointerDownOutside,
    handleEscapeKeyDown: handleAdminEscapeKeyDown,
    handleFocusOutside: handleAdminFocusOutside,
    handleInteractOutside: handleAdminInteractOutside,
    requestClose: requestAdminClose,
  } = useDialogDismiss(() => setAdminOpen(false));

  useEffect(() => {
    function handleOpenDestinations() {
      setSettingsOpen(false);
      setDestinationsOpen(true);
    }

    window.addEventListener("maia:open-destinations", handleOpenDestinations);
    return () => {
      window.removeEventListener("maia:open-destinations", handleOpenDestinations);
    };
  }, []);
  const {
    handleOpenChange: handleCreateProjectOpenChange,
    handlePointerDownOutside: handleCreateProjectPointerDownOutside,
    handleEscapeKeyDown: handleCreateProjectEscapeKeyDown,
    handleFocusOutside: handleCreateProjectFocusOutside,
    handleInteractOutside: handleCreateProjectInteractOutside,
    requestClose: requestCreateProjectClose,
  } = useDialogDismiss(closeCreateProjectDialog);

  const hasOpenModal =
    settingsOpen ||
    destinationsOpen ||
    ideaOpen ||
    libraryOpen ||
    adminOpen ||
    createProjectOpen ||
    deleteProjectTarget !== null ||
    deleteConversationTarget !== null;

  useEffect(() => {
    onModalStateChange?.(hasOpenModal);
    return () => {
      onModalStateChange?.(false);
    };
  }, [hasOpenModal, onModalStateChange]);

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
    const serverMessages = detail.messages.map(mapMessage);
    const latestCachedMessages = getCachedMessagesForConversation(detail.id);
    if (latestCachedMessages && latestCachedMessages.length > serverMessages.length) {
      hydrateMessages(latestCachedMessages, detail.id);
      return;
    }

    hydrateMessages(serverMessages, detail.id);
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
    if (!deleteProjectTarget) {
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
      await fetchConversations();
    } finally {
      setDeletingProject(false);
    }
  }

  return (
    <div className="flex h-full flex-col px-4 py-4">
      <div className="mb-4 flex items-center justify-start gap-2">
        <div className="flex items-center gap-2">
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
          {onCollapseSidebar ? (
            <Button
              type="button"
              variant="secondary"
              size="icon"
              onClick={onCollapseSidebar}
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
            >
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>

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

        {/*
          Top-level Library entry — pulled out of the Settings dialog
          so it sits as a first-class sidebar item, the same way
          ChatGPT puts "Codex" / "GPTs" above the project list.
          Opens the existing LibraryDialog directly.
        */}
        <button
          type="button"
          onClick={() => setLibraryOpen(true)}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[14.5px] font-medium text-ink transition hover:bg-black/[0.04]"
        >
          <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted">
            <Library className="h-4 w-4 stroke-[1.8]" />
          </span>
          Library
        </button>

        {/* Spacer + hairline separator between the Library entry and
            the chats/projects list — visually marks them as two
            distinct sections. */}
        <div className="my-3 h-px bg-black/[0.05]" />

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin pr-1">
          {grouped.map((section) => (
            <div key={section.id} className="mb-1.5">
              <div className="group/project-header flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-black/[0.03]">
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
                  <p className="truncate text-[14.5px] font-medium text-ink">
                    {section.label}
                  </p>
                </button>
                <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover/project-header:opacity-100 group-focus-within/project-header:opacity-100">
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
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
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
                      className={`group/conversation block w-full rounded-[14px] border px-3 py-2 text-left transition ${
                        isDeletedConversation
                          ? "border-danger/20 bg-danger/5 opacity-70"
                          : activeConversationId === conversation.id
                          ? "border-black/[0.08] bg-black/[0.04]"
                          : "border-transparent hover:bg-black/[0.04]"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-black/[0.04] text-muted">
                          <ConversationIcon className="h-3.5 w-3.5" />
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
                          <p className="truncate text-[14.5px] font-medium text-ink">
                            {isDeletedConversation
                              ? "Deleted"
                              : conversation.title || titleFromMessage("Untitled conversation")}
                          </p>
                        </button>
                        {isDeletedConversation ? null : (
                          <button
                            type="button"
                            className="rounded-full p-1.5 text-muted opacity-0 transition hover:bg-danger/10 hover:text-danger group-hover/conversation:opacity-100 group-focus-within/conversation:opacity-100"
                            onClick={(event) => {
                              event.stopPropagation();
                              setDeleteConversationTarget(conversation);
                            }}
                            title="Delete"
                            aria-label="Delete conversation"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
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

      {/*
        Account bar — single ChatGPT-style row: user-initials avatar +
        truncated name + chevron. Clicking it opens a small popover
        menu with Suggest idea, Settings, and Log out. One icon, one
        name when expanded; the icon-rail in AppShell uses the same
        avatar when the sidebar is collapsed.
      */}
      <AccountBar
        userName={user?.name ?? null}
        userEmail={user?.email ?? null}
        onSuggestIdea={() => setIdeaOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onLogout={logout}
      />

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
          setAdminOpen(true);
        }}
        onOpenDestinations={() => {
          setSettingsOpen(false);
          setDestinationsOpen(true);
        }}
        onLogout={() => {
          setSettingsOpen(false);
          logout();
        }}
      />

      <FeatureIdeaDialog open={ideaOpen} onOpenChange={setIdeaOpen} />

      <DestinationManagerDialog
        open={destinationsOpen}
        onOpenChange={setDestinationsOpen}
      />

      <LibraryDialog
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        groups={groups}
        activeGroupId={activeGroupId}
        isAdmin={user?.role === "admin"}
      />

      <Dialog.Root open={adminOpen} onOpenChange={handleAdminOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/18 backdrop-blur-[18px]" onDoubleClick={requestAdminClose} />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-[60] flex h-[min(860px,calc(100vh-2rem))] w-[min(1120px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[34px] border border-black/[0.06] bg-panel p-6 shadow-[0_30px_80px_rgba(17,17,17,0.14)] outline-none"
            onPointerDownOutside={handleAdminPointerDownOutside}
            onEscapeKeyDown={handleAdminEscapeKeyDown}
            onFocusOutside={handleAdminFocusOutside}
            onInteractOutside={handleAdminInteractOutside}
          >
            <div className="flex items-start justify-between gap-4 border-b border-black/[0.06] pb-5">
              <div className="flex items-center gap-4">
                <span className="rounded-full bg-black p-3 text-white">
                  <Shield className="h-5 w-5" />
                </span>
                <div>
                  <Dialog.Title className="font-display text-[1.875rem] font-semibold tracking-[-0.04em] text-ink">
                    Admin
                  </Dialog.Title>
                  <p className="mt-1 text-sm text-muted">
                    Manage users, companies, and access in one popup workspace.
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
                aria-label="Close admin"
                onClick={requestAdminClose}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-5 min-h-0 flex-1 overflow-hidden">
              <AdminWorkspaceView />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <DeleteConfirmDialog
        open={deleteProjectTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeDeleteProjectDialog();
          }
        }}
        title="Delete project?"
        description={
          <>
            <span className="font-semibold text-ink">This permanently deletes the project and removes its chat organization.</span>{" "}
            Conversations will no longer stay grouped under{" "}
            <span className="font-semibold text-ink">{deleteProjectTarget?.name ?? "this project"}</span>.
          </>
        }
        confirmLabel="Delete"
        isDeleting={deletingProject}
        requireDeleteText={false}
        onConfirm={async () => {
          await handleDeleteProject();
        }}
      />

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
            <span className="font-semibold text-ink">This permanently deletes the conversation.</span>{" "}
            You will lose the current chat history for{" "}
            <span className="font-semibold text-ink">
              {deleteConversationTarget?.title || titleFromMessage("this conversation")}
            </span>.
          </>
        }
        confirmLabel="Delete"
        requireDeleteText={false}
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
        onOpenChange={handleCreateProjectOpenChange}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/18 backdrop-blur-[18px]" onDoubleClick={requestCreateProjectClose} />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-[80] w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[30px] border border-black/[0.06] bg-panel p-6 shadow-[0_24px_60px_rgba(17,17,17,0.12)] outline-none"
            onPointerDownOutside={handleCreateProjectPointerDownOutside}
            onEscapeKeyDown={handleCreateProjectEscapeKeyDown}
            onFocusOutside={handleCreateProjectFocusOutside}
            onInteractOutside={handleCreateProjectInteractOutside}
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
              <button
                type="button"
                className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
                aria-label="Close create project dialog"
                onClick={requestCreateProjectClose}
              >
                <X className="h-4 w-4" />
              </button>
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

