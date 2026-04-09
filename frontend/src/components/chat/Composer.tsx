"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Hash, Layers3, Paperclip, Plus, Send, X } from "lucide-react";

import { ComposerMenu } from "@/components/chat/ComposerMenu";
import { DocumentSelector } from "@/components/chat/DocumentSelector";
import { GroupSelector } from "@/components/chat/GroupSelector";
import { DocumentPreviewDialog } from "@/components/pdf/DocumentPreviewDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Document, Group } from "@/lib/types";
import { useChatStore } from "@/stores/chatStore";
import { useConversationStore } from "@/stores/conversationStore";
import { useDocumentStore } from "@/stores/documentStore";
import { useGroupStore } from "@/stores/groupStore";

const groupRegex = /(^|\s)#([^\s#@]*)$/;
const documentRegex = /(^|\s)@([^\s#@]*)$/;

function replaceTrigger(value: string, regex: RegExp) {
  return value.replace(regex, "$1");
}

function formatModeLabel(mode: "library" | "deep_search" | "standard") {
  if (mode === "deep_search") {
    return "Deep Search";
  }
  if (mode === "standard") {
    return "Standard";
  }
  return "Library";
}

export function Composer() {
  const composerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const modeMenuRef = useRef<HTMLDivElement | null>(null);
  const groupSelectorRef = useRef<HTMLDivElement | null>(null);
  const documentSelectorRef = useRef<HTMLDivElement | null>(null);
  const activeGroupId = useGroupStore((state) => state.activeGroupId);
  const groups = useGroupStore((state) => state.groups);
  const setActiveGroup = useGroupStore((state) => state.setActiveGroup);
  const selectedDocumentIds = useDocumentStore((state) => state.selectedDocumentIds);
  const setSelectedDocuments = useDocumentStore((state) => state.setSelectedDocuments);
  const toggleDocument = useDocumentStore((state) => state.toggleDocument);
  const clearSelection = useDocumentStore((state) => state.clearSelection);
  const fetchDocuments = useDocumentStore((state) => state.fetchDocuments);
  const documentsByGroup = useDocumentStore((state) => state.documentsByGroup);
  const value = useChatStore((state) => state.draft);
  const setDraft = useChatStore((state) => state.setDraft);
  const promptAttachments = useChatStore((state) => state.promptAttachments);
  const addPromptAttachments = useChatStore((state) => state.addPromptAttachments);
  const removePromptAttachment = useChatStore((state) => state.removePromptAttachment);
  const draftMode = useChatStore((state) => state.draftMode);
  const setDraftMode = useChatStore((state) => state.setDraftMode);
  const mode = useChatStore((state) => state.mode);
  const setMode = useChatStore((state) => state.setMode);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const streaming = useChatStore((state) => state.streaming);
  const clearChat = useChatStore((state) => state.clearChat);
  const startNewConversation = useConversationStore((state) => state.startNewConversation);
  const fetchConversations = useConversationStore((state) => state.fetchConversations);

  const [showModeMenu, setShowModeMenu] = useState(false);
  const [groupQuery, setGroupQuery] = useState("");
  const [documentQuery, setDocumentQuery] = useState("");
  const [forceGroupOpen, setForceGroupOpen] = useState(false);
  const [forceDocumentOpen, setForceDocumentOpen] = useState(false);
  const [previewDocument, setPreviewDocument] = useState<Document | null>(null);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const documents = useMemo(
    () => (activeGroupId ? documentsByGroup[activeGroupId] ?? [] : []),
    [activeGroupId, documentsByGroup],
  );
  const fallbackGroup = useMemo(
    () => groups.find((group) => group.id === activeGroupId) ?? groups[0] ?? null,
    [activeGroupId, groups],
  );
  const needsProjectSelection = mode !== "standard";
  const canSend = (!!value.trim() || promptAttachments.length > 0) && !streaming && !!fallbackGroup;

  const activeGroup = groups.find((group) => group.id === activeGroupId) ?? null;

  const filteredGroups = useMemo(() => {
    const needle = (groupQuery || value.match(groupRegex)?.[2] || "").toLowerCase();
    return groups.filter((group) => group.name.toLowerCase().includes(needle));
  }, [groupQuery, groups, value]);

  const filteredDocuments = useMemo(() => {
    const needle = (documentQuery || value.match(documentRegex)?.[2] || "").toLowerCase();
    return documents.filter((document) => document.filename.toLowerCase().includes(needle));
  }, [documentQuery, documents, value]);

  const showGroupSelector = forceGroupOpen || groupRegex.test(value);
  const showDocumentSelector =
    !!activeGroupId && (forceDocumentOpen || documentRegex.test(value));

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) {
      return;
    }
    element.style.height = "0px";
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);

  useEffect(() => {
    function handleFocusComposer() {
      textareaRef.current?.focus();
    }

    window.addEventListener("maia-focus-composer", handleFocusComposer);
    return () => window.removeEventListener("maia-focus-composer", handleFocusComposer);
  }, []);

  useEffect(() => {
    if (activeGroupId && groups.some((group) => group.id === activeGroupId)) {
      void fetchDocuments(activeGroupId);
    }
  }, [activeGroupId, fetchDocuments, groups]);

  useEffect(() => {
    let frame = 0;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      const closeModeMenu =
        (showModeMenu && !modeMenuRef.current?.contains(target)) ||
        !composerRef.current?.contains(target);
      const closeGroupSelector =
        showGroupSelector && !groupSelectorRef.current?.contains(target);
      const closeDocumentSelector =
        showDocumentSelector && !documentSelectorRef.current?.contains(target);

      if (!closeModeMenu && !closeGroupSelector && !closeDocumentSelector) {
        return;
      }

      frame = window.requestAnimationFrame(() => {
        if (closeModeMenu) {
          setShowModeMenu(false);
        }
        if (closeGroupSelector) {
          setForceGroupOpen(false);
        }
        if (closeDocumentSelector) {
          setForceDocumentOpen(false);
        }
      });
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [showDocumentSelector, showGroupSelector, showModeMenu]);

  const selectedDocuments = documents.filter((document) => selectedDocumentIds.includes(document.id));
  const isExpandedComposer = value.includes("\n") || value.length > 180;
  const isEditingUserMessage = draftMode === "user_edit";

  function handleSelectGroup(group: Group) {
    setActiveGroup(group.id);
    clearSelection();
    clearChat();
    startNewConversation();
    setDraft(replaceTrigger(value, groupRegex).trimStart());
    setForceGroupOpen(false);
    setGroupQuery("");
    void fetchDocuments(group.id);
    void fetchConversations();
  }

  function handleSelectAllDocuments() {
    setSelectedDocuments([]);
    setDraft(replaceTrigger(value, documentRegex).trimStart());
    setForceDocumentOpen(false);
    setDocumentQuery("");
  }

  function handleToggleDocument(documentId: string) {
    toggleDocument(documentId);
  }

  function handleSelectDocument(documentId: string) {
    toggleDocument(documentId);
    setDraft(replaceTrigger(value, documentRegex).trimStart());
    setForceDocumentOpen(false);
    setDocumentQuery("");
  }

  async function handleSend() {
    if (!canSend) {
      return;
    }
    const message = value.trim();
    setDraft("");
    setDraftMode("compose");
    setForceGroupOpen(false);
    setForceDocumentOpen(false);
    await sendMessage(message);
  }

  async function handleAttachFiles(files: FileList | null) {
    if (!files?.length) {
      return;
    }
    setUploadingAttachment(true);
    try {
      await addPromptAttachments(files);
    } finally {
      setUploadingAttachment(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  const placeholder = needsProjectSelection
    ? activeGroupId
      ? "Ask a question..."
      : "Select a group with # to start"
    : fallbackGroup
      ? "Ask anything..."
      : "No project available yet";

  return (
    <div
      ref={composerRef}
      className="relative rounded-[30px] border border-black/[0.07] bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(248,248,248,0.92))] p-3 shadow-[0_18px_44px_rgba(15,23,42,0.05),inset_0_1px_0_rgba(255,255,255,0.92)] backdrop-blur-xl"
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 px-1">
        <Badge className="h-9 gap-1 rounded-full border border-black/[0.05] bg-[rgba(245,245,246,0.98)] px-3 text-black shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
          <Layers3 className="h-3 w-3" />
          {formatModeLabel(mode)}
        </Badge>

        {needsProjectSelection && activeGroup ? (
          <Badge className="h-9 gap-2 rounded-full border border-black/[0.05] bg-[rgba(245,245,246,0.98)] px-3 text-black shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
            <Hash className="h-3 w-3" />
            {activeGroup.name}
            <button
              type="button"
              className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted transition hover:bg-black/[0.05] hover:text-black"
              onClick={() => setForceGroupOpen(true)}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ) : null}

      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.docx,.txt,.md,image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(event) => void handleAttachFiles(event.target.files)}
      />

      {needsProjectSelection && showGroupSelector ? (
        <GroupSelector
          ref={groupSelectorRef}
          groups={filteredGroups}
          query={groupQuery}
          onQueryChange={setGroupQuery}
          onSelect={handleSelectGroup}
        />
      ) : null}

      {needsProjectSelection && showDocumentSelector ? (
        <DocumentSelector
          ref={documentSelectorRef}
          documents={filteredDocuments}
          query={documentQuery}
          selectedIds={selectedDocumentIds}
          onQueryChange={setDocumentQuery}
          onToggleDocument={handleSelectDocument}
          onSelectAll={handleSelectAllDocuments}
          onPreviewDocument={setPreviewDocument}
        />
      ) : null}

      {isEditingUserMessage ? (
        <div className="mb-3 flex items-center justify-between px-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
            Editing message
          </span>
          <button
            type="button"
            className="text-[11px] font-medium text-muted transition hover:text-black"
            onClick={() => {
              setDraftMode("compose");
              textareaRef.current?.focus();
            }}
          >
            Keep editing
          </button>
        </div>
      ) : null}

      <div className="flex items-end gap-3">
        <div className="relative">
          <Button
            type="button"
            variant="secondary"
            size="icon"
            onClick={() => setShowModeMenu((current) => !current)}
            className="h-14 w-14 shrink-0 rounded-full bg-black text-white shadow-[0_16px_36px_rgba(15,23,42,0.14)] transition hover:scale-[1.01] hover:bg-black/92"
          >
            <Plus className="h-4 w-4" />
          </Button>
          {showModeMenu ? (
            <ComposerMenu
              ref={modeMenuRef}
              value={mode}
              onSelect={(nextMode) => {
                setMode(nextMode);
                setShowModeMenu(false);
              }}
            />
          ) : null}
        </div>

        <div
          className={`flex min-h-[60px] flex-1 flex-wrap gap-2 border border-black/[0.08] bg-white px-4 py-2.5 shadow-[0_12px_30px_rgba(15,23,42,0.04),inset_0_1px_0_rgba(255,255,255,0.92)] transition focus-within:border-black/[0.14] focus-within:ring-4 focus-within:ring-black/[0.035] ${
            isExpandedComposer ? "max-h-[260px] items-start overflow-y-auto rounded-[28px] scrollbar-thin" : "items-center rounded-[999px]"
          }`}
        >
          <button
            type="button"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-black/[0.06] bg-[rgb(246,246,247)] text-muted transition hover:border-black hover:bg-black hover:text-white"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadingAttachment || streaming}
            aria-label="Attach file"
            title="Attach PDF, Word, or image"
          >
            <Paperclip className="h-3.5 w-3.5" />
          </button>

          {promptAttachments.map((attachment) => (
            <span
              key={attachment.id}
              className="inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-full border border-black/[0.05] bg-[rgb(246,246,247)] px-2.5 text-[11px] font-medium text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.85)]"
            >
              <span className="truncate text-[11px] tracking-[-0.02em] text-black/88">
                {attachment.filename}
              </span>
              <button
                type="button"
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-black/[0.06] hover:text-ink"
                onClick={() => removePromptAttachment(attachment.id)}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}

          {needsProjectSelection && selectedDocuments.map((document) => (
            <span
              key={document.id}
              className="inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-full border border-black/[0.05] bg-[rgb(246,246,247)] px-2.5 text-[11px] font-medium text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.85)]"
              onDoubleClick={() => setPreviewDocument(document)}
            >
              <span className="truncate text-[11px] tracking-[-0.02em] text-black/88">@{document.filename}</span>
              <button
                type="button"
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-black/[0.06] hover:text-ink"
                onClick={() => handleToggleDocument(document.id)}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}

          <Textarea
            ref={textareaRef}
            rows={1}
            placeholder={placeholder}
            disabled={streaming || (!fallbackGroup && needsProjectSelection)}
            value={value}
            onChange={(event) => {
              setDraft(event.target.value);
              if (draftMode === "compose") {
                setDraftMode("compose");
              }
              if (!groupRegex.test(event.target.value)) {
                setGroupQuery("");
                setForceGroupOpen(false);
              }
              if (!documentRegex.test(event.target.value)) {
                setDocumentQuery("");
                setForceDocumentOpen(false);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void handleSend();
              }
              if (event.key === "Escape") {
                setForceGroupOpen(false);
                setForceDocumentOpen(false);
                setShowModeMenu(false);
              }
            }}
            className={`min-h-[36px] flex-1 border-0 bg-transparent px-1 py-[7px] pr-2 text-[16px] leading-6 tracking-[-0.02em] shadow-none placeholder:text-muted/85 focus:border-0 focus:ring-0 ${
              isExpandedComposer ? "max-h-[190px] overflow-y-auto scrollbar-thin" : ""
            }`}
          />
        </div>
        <Button
          type="button"
          size="icon"
          className="h-14 w-14 shrink-0 rounded-full bg-black text-white shadow-[0_16px_36px_rgba(15,23,42,0.14)] transition hover:scale-[1.01] hover:bg-black/92 disabled:bg-black disabled:text-white disabled:opacity-100 disabled:hover:scale-100"
          onClick={() => void handleSend()}
          disabled={!canSend}
        >
          <Send className="h-4.5 w-4.5" />
        </Button>
      </div>

      <DocumentPreviewDialog
        document={previewDocument}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewDocument(null);
          }
        }}
      />
    </div>
  );
}
