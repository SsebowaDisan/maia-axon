"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AtSign, Hash, Layers3, Plus, Send, X } from "lucide-react";

import { ComposerMenu } from "@/components/chat/ComposerMenu";
import { DocumentSelector } from "@/components/chat/DocumentSelector";
import { GroupSelector } from "@/components/chat/GroupSelector";
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

export function Composer() {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeGroupId = useGroupStore((state) => state.activeGroupId);
  const groups = useGroupStore((state) => state.groups);
  const setActiveGroup = useGroupStore((state) => state.setActiveGroup);
  const selectedDocumentIds = useDocumentStore((state) => state.selectedDocumentIds);
  const setSelectedDocuments = useDocumentStore((state) => state.setSelectedDocuments);
  const toggleDocument = useDocumentStore((state) => state.toggleDocument);
  const clearSelection = useDocumentStore((state) => state.clearSelection);
  const fetchDocuments = useDocumentStore((state) => state.fetchDocuments);
  const documents = useDocumentStore((state) =>
    activeGroupId ? state.documentsByGroup[activeGroupId] ?? [] : [],
  );
  const mode = useChatStore((state) => state.mode);
  const setMode = useChatStore((state) => state.setMode);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const streaming = useChatStore((state) => state.streaming);
  const clearChat = useChatStore((state) => state.clearChat);
  const startNewConversation = useConversationStore((state) => state.startNewConversation);
  const fetchConversations = useConversationStore((state) => state.fetchConversations);

  const [value, setValue] = useState("");
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [groupQuery, setGroupQuery] = useState("");
  const [documentQuery, setDocumentQuery] = useState("");
  const [forceGroupOpen, setForceGroupOpen] = useState(false);
  const [forceDocumentOpen, setForceDocumentOpen] = useState(false);

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
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [value]);

  useEffect(() => {
    if (activeGroupId) {
      void fetchDocuments(activeGroupId);
    }
  }, [activeGroupId, fetchDocuments]);

  const selectedDocuments = documents.filter((document) => selectedDocumentIds.includes(document.id));

  function handleSelectGroup(group: Group) {
    setActiveGroup(group.id);
    clearSelection();
    clearChat();
    startNewConversation();
    setValue((current) => replaceTrigger(current, groupRegex).trimStart());
    setForceGroupOpen(false);
    setGroupQuery("");
    void fetchDocuments(group.id);
    void fetchConversations(group.id);
  }

  function handleSelectAllDocuments() {
    setSelectedDocuments([]);
    setValue((current) => replaceTrigger(current, documentRegex).trimStart());
    setForceDocumentOpen(false);
    setDocumentQuery("");
  }

  function handleToggleDocument(documentId: string) {
    toggleDocument(documentId);
  }

  async function handleSend() {
    if (!value.trim() || !activeGroupId || streaming) {
      return;
    }
    const message = value.trim();
    setValue("");
    setForceGroupOpen(false);
    setForceDocumentOpen(false);
    await sendMessage(message);
  }

  const placeholder = activeGroupId ? "Ask a question..." : "Select a group with # to start";

  return (
    <div className="relative rounded-[30px] border border-line bg-panel/95 p-4 shadow-card">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Button
            type="button"
            variant="secondary"
            size="icon"
            onClick={() => setShowModeMenu((current) => !current)}
          >
            <Plus className="h-4 w-4" />
          </Button>
          {showModeMenu ? (
            <ComposerMenu
              value={mode}
              onSelect={(nextMode) => {
                setMode(nextMode);
                setShowModeMenu(false);
              }}
            />
          ) : null}
        </div>

        <Badge className="gap-1">
          <Layers3 className="h-3 w-3" />
          {mode === "deep_search" ? "Deep Search" : "Library"}
        </Badge>

        {activeGroup ? (
          <Badge className="gap-2">
            <Hash className="h-3 w-3" />
            {activeGroup.name}
            <button type="button" onClick={() => setForceGroupOpen(true)}>
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ) : null}

        {selectedDocuments.map((document) => (
          <Badge key={document.id} className="gap-2">
            <AtSign className="h-3 w-3" />
            {document.filename}
            <button type="button" onClick={() => handleToggleDocument(document.id)}>
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>

      {showGroupSelector ? (
        <GroupSelector
          groups={filteredGroups}
          query={groupQuery}
          onQueryChange={setGroupQuery}
          onSelect={handleSelectGroup}
        />
      ) : null}

      {showDocumentSelector ? (
        <DocumentSelector
          documents={filteredDocuments}
          query={documentQuery}
          selectedIds={selectedDocumentIds}
          onQueryChange={setDocumentQuery}
          onToggleDocument={handleToggleDocument}
          onSelectAll={handleSelectAllDocuments}
        />
      ) : null}

      <div className="flex items-end gap-3">
        <Textarea
          ref={textareaRef}
          rows={1}
          placeholder={placeholder}
          disabled={!activeGroupId || streaming}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
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
          className="max-h-40 min-h-[52px] pr-4"
        />
        <Button
          type="button"
          size="icon"
          onClick={() => void handleSend()}
          disabled={!activeGroupId || !value.trim() || streaming}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
