"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, FileText, GraduationCap, Layers, Loader2, Paperclip, Quote, Send, X } from "lucide-react";

import { api } from "@/lib/api";
import type { MindmapSectionNode, SearchMode } from "@/lib/types";
import { useChatStore } from "@/stores/chatStore";
import { useDocumentStore } from "@/stores/documentStore";
import { useGroupStore } from "@/stores/groupStore";
import { usePDFViewerStore } from "@/stores/pdfViewerStore";

// "%foo" trigger. Recognised when the cursor is at the end of a token
// that starts with % and contains no whitespace or further %. Mirrors
// the #/@ patterns the main composer uses.
const TOPIC_TRIGGER = /(^|\s)%([^\s%]*)$/;

interface FlatTopic {
  id: string;
  kind: "topic" | "subtopic" | "headline";
  title: string;
  page_start: number;
  page_end: number;
  depth: number;
}

function flattenTopics(tree: MindmapSectionNode[]): FlatTopic[] {
  const out: FlatTopic[] = [];
  function walk(node: MindmapSectionNode, depth: number) {
    out.push({
      id: node.id,
      kind: node.kind,
      title: node.title,
      page_start: node.page_start,
      page_end: node.page_end,
      depth,
    });
    for (const child of node.children) walk(child, depth + 1);
  }
  for (const root of tree) walk(root, 0);
  return out;
}

/**
 * Slim composer dedicated to the PDF preview's chat pane.
 *
 * Unlike the main-app {@link Composer}, this surface deliberately
 * strips everything that doesn't make sense for a document-scoped
 * conversation:
 *
 * * No Standard / Deep Search / Google Analytics / Google Ads
 *   modes — only Library (talk to the PDF) and Learn (tutor mode).
 * * No # group selector or @ document selector — the open PDF is
 *   the implicit subject of the conversation.
 * * No voice input, no output-destination menu, no expand-to-full-
 *   editor flow.
 * * No tall mode-chip row above the input.
 *
 * What it keeps: textarea (auto-grows), passage-quote chip when the
 * user attached one from the PDF, prompt-attachment chips for files
 * dropped via the paperclip, and the send button. The container fits
 * the 420px-wide chat pane without wrapping.
 */
export function DocumentChatComposer() {
  const draft = useChatStore((state) => state.draft);
  const setDraft = useChatStore((state) => state.setDraft);
  const mode = useChatStore((state) => state.mode);
  const setMode = useChatStore((state) => state.setMode);
  const streaming = useChatStore((state) => state.streaming);
  const promptAttachments = useChatStore((state) => state.promptAttachments);
  const addPromptAttachments = useChatStore((state) => state.addPromptAttachments);
  const removePromptAttachment = useChatStore((state) => state.removePromptAttachment);
  const passageContext = useChatStore((state) => state.passageContext);
  const clearPassageContext = useChatStore((state) => state.clearPassageContext);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const composerFocusNonce = useChatStore((state) => state.composerFocusNonce);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Topic-typeahead state. We fetch sections once per document then
  // filter client-side as the user types after "%".
  const currentDocument = usePDFViewerStore((s) => s.currentDocument);
  const [topicTree, setTopicTree] = useState<MindmapSectionNode[] | null>(null);
  const [topicQuery, setTopicQuery] = useState<string | null>(null);
  const [topicHighlight, setTopicHighlight] = useState(0);
  const flatTopics = useMemo(() => (topicTree ? flattenTopics(topicTree) : []), [topicTree]);
  const filteredTopics = useMemo(() => {
    if (topicQuery == null) return [];
    const q = topicQuery.trim().toLowerCase();
    const pool = flatTopics.filter((t) => t.title.trim().length > 0);
    if (!q) return pool.slice(0, 30);
    return pool
      .filter((t) => t.title.toLowerCase().includes(q))
      .slice(0, 30);
  }, [flatTopics, topicQuery]);

  // Fetch sections lazily the first time the user opens the % menu,
  // then cache. Refetch only when the document changes.
  useEffect(() => {
    if (!currentDocument || topicQuery === null) return;
    if (topicTree !== null) return;
    let cancelled = false;
    api
      .getDocumentSections(currentDocument.id)
      .then((data) => {
        if (cancelled) return;
        setTopicTree(data);
      })
      .catch(() => {
        if (cancelled) return;
        setTopicTree([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentDocument, topicQuery, topicTree]);

  // If the document changes (different PDF in the preview), invalidate
  // the cached topic tree so the next % opens fetch fresh data.
  useEffect(() => {
    setTopicTree(null);
    setTopicQuery(null);
  }, [currentDocument?.id]);

  // The composer always defaults to library mode when the preview
  // opens (this is the doc-scoped chat). The user can flip to learn
  // mode via the toggle below.
  useEffect(() => {
    if (mode !== "library" && mode !== "learn") {
      setMode("library");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-grow the textarea up to 6 lines, then scroll inside.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const maxHeight = 160;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [draft]);

  useEffect(() => {
    if (composerFocusNonce === 0) return;
    textareaRef.current?.focus();
  }, [composerFocusNonce]);

  const canSend =
    !streaming &&
    (draft.trim().length > 0 || promptAttachments.length > 0 || !!passageContext);

  async function handleSend() {
    if (!canSend) return;
    if (topicQuery !== null) return; // suppress send while typeahead open
    const message = draft.trim();
    setDraft("");
    setTopicQuery(null);
    // Defensive: ensure the doc-scoped chat always sends with the
    // active document selected AND the doc's group active. The dialog
    // effect normally handles this on open, but persist hydration
    // races or a stale store can leave them empty — the backend then
    // rejects with "Group is required for grounded chat".
    if (currentDocument) {
      useDocumentStore.getState().setSelectedDocuments([currentDocument.id]);
      if (
        currentDocument.group_id &&
        useGroupStore.getState().activeGroupId !== currentDocument.group_id
      ) {
        useGroupStore.getState().setActiveGroup(currentDocument.group_id);
      }
    }
    await sendMessage(message);
  }

  // Drive the topic typeahead based on the current draft. We re-run
  // the regex on every change; if there's a trailing "%..." token,
  // surface the dropdown; otherwise hide it.
  const updateTopicQueryFrom = useCallback((value: string) => {
    const match = TOPIC_TRIGGER.exec(value);
    if (match) {
      setTopicQuery(match[2] ?? "");
      setTopicHighlight(0);
    } else {
      setTopicQuery(null);
    }
  }, []);

  const handleDraftChange = useCallback(
    (value: string) => {
      setDraft(value);
      updateTopicQueryFrom(value);
    },
    [setDraft, updateTopicQueryFrom],
  );

  const handleSelectTopic = useCallback(
    (topic: FlatTopic) => {
      // Replace the trailing "%query" token with the topic title in
      // plain text. Keeps the conversation transcript readable and
      // gives the LLM a clean reference it can ground retrieval on.
      const replaced = draft.replace(TOPIC_TRIGGER, (_match, lead) =>
        `${lead}${topic.title} `,
      );
      setDraft(replaced);
      setTopicQuery(null);
      // Re-focus + caret to end so the user can keep typing.
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    },
    [draft, setDraft],
  );

  // Click-outside dismiss.
  useEffect(() => {
    if (topicQuery === null) return;
    function onDown(event: PointerEvent) {
      const node = event.target as Node;
      if (!containerRef.current?.contains(node)) {
        setTopicQuery(null);
      }
    }
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [topicQuery]);

  async function handleAttachFiles(files: FileList | File[] | null) {
    if (!files || (files as FileList).length === 0) return;
    await addPromptAttachments(files);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <div
      ref={containerRef}
      className="relative rounded-2xl border border-black/[0.07] bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)]"
    >
      {topicQuery !== null ? (
        <TopicPicker
          topics={filteredTopics}
          loading={topicTree === null}
          highlight={topicHighlight}
          onHover={setTopicHighlight}
          onSelect={handleSelectTopic}
        />
      ) : null}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.docx,.txt,.md,image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(event) => void handleAttachFiles(event.target.files)}
      />

      {/* Attached passage (from PDF "Ask Maia about this") */}
      {passageContext ? (
        <div className="px-3 pt-2.5">
          <div
            className="flex max-w-full items-center gap-1.5 rounded-lg border border-black/[0.06] bg-[#f7f7f6] px-2 py-1 text-[11px]"
            title={passageContext.text}
          >
            <Quote className="h-3 w-3 shrink-0 text-muted/70" />
            <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.14em] text-muted">
              p{passageContext.pageNumber}
            </span>
            <span className="min-w-0 flex-1 truncate italic text-ink/75">
              {passageContext.text}
            </span>
            <button
              type="button"
              onClick={clearPassageContext}
              aria-label="Remove attached passage"
              className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-black/[0.08] hover:text-ink"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
      ) : null}

      {/* File attachment chips */}
      {promptAttachments.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
          {promptAttachments.map((attachment) => (
            <div
              key={attachment.id}
              className="flex max-w-full items-center gap-1.5 rounded-lg border border-black/[0.06] bg-[#f7f7f6] px-2 py-1 text-[11px]"
              title={attachment.filename}
            >
              <Paperclip className="h-3 w-3 shrink-0 text-muted/70" />
              <span className="min-w-0 max-w-[180px] truncate">{attachment.filename}</span>
              <button
                type="button"
                onClick={() => removePromptAttachment(attachment.id)}
                aria-label={`Remove ${attachment.filename}`}
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-black/[0.08] hover:text-ink"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {/* Textarea */}
      <div className="px-3 pt-2.5">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => handleDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (topicQuery !== null && filteredTopics.length > 0) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setTopicHighlight((h) => (h + 1) % filteredTopics.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setTopicHighlight((h) =>
                  (h - 1 + filteredTopics.length) % filteredTopics.length,
                );
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                handleSelectTopic(filteredTopics[topicHighlight]);
                return;
              }
              if (event.key === "Tab") {
                event.preventDefault();
                handleSelectTopic(filteredTopics[topicHighlight]);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setTopicQuery(null);
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
          placeholder={
            mode === "learn"
              ? "Ask the tutor about this section…  (% lists topics)"
              : "Ask about this document…  (% lists topics)"
          }
          rows={1}
          disabled={streaming}
          className="block w-full resize-none border-0 bg-transparent text-[13.5px] leading-relaxed text-ink outline-none placeholder:text-muted/55 disabled:opacity-60"
        />
      </div>

      {/* Bottom toolbar: attach, mode toggle, send */}
      <div className="flex items-center gap-2 px-2 pb-2 pt-1.5">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={streaming}
          title="Attach a file"
          aria-label="Attach a file"
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted transition hover:bg-black/[0.05] hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Paperclip className="h-3.5 w-3.5" />
        </button>

        <ModeToggle current={mode} onChange={setMode} disabled={streaming} />

        <div className="flex-1" />

        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          title="Send"
          aria-label="Send message"
          className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[#2a2522] text-white shadow-[0_2px_6px_rgba(15,23,42,0.12)] transition hover:bg-[#3a3530] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {streaming ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}

function TopicPicker({
  topics,
  loading,
  highlight,
  onHover,
  onSelect,
}: {
  topics: FlatTopic[];
  loading: boolean;
  highlight: number;
  onHover: (index: number) => void;
  onSelect: (topic: FlatTopic) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label="Topics in this document"
      className="absolute bottom-full left-0 right-0 mb-2 max-h-[280px] overflow-hidden rounded-xl border border-black/[0.08] bg-white shadow-[0_18px_50px_rgba(15,23,42,0.14)]"
    >
      <div className="border-b border-black/[0.05] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
        Topics in this document
      </div>
      {loading ? (
        <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading topics…
        </div>
      ) : topics.length === 0 ? (
        <div className="px-3 py-3 text-[12px] text-muted">
          No matching topics in this document.
        </div>
      ) : (
        <div className="max-h-[240px] overflow-y-auto scrollbar-thin">
          {topics.map((topic, idx) => {
            const Icon =
              topic.kind === "topic" ? Layers : topic.kind === "subtopic" ? FileText : BookOpen;
            const isHighlighted = idx === highlight;
            return (
              <button
                key={topic.id}
                type="button"
                role="option"
                aria-selected={isHighlighted}
                onMouseEnter={() => onHover(idx)}
                onClick={() => onSelect(topic)}
                style={{ paddingLeft: 12 + topic.depth * 10 }}
                className={`flex w-full items-center gap-2 py-1.5 pr-3 text-left text-[12.5px] transition ${
                  isHighlighted ? "bg-accentSoft text-accent" : "text-ink hover:bg-black/[0.04]"
                }`}
              >
                <Icon
                  className={`h-3 w-3 shrink-0 ${
                    isHighlighted ? "text-accent" : "text-muted/70"
                  }`}
                />
                <span className="min-w-0 flex-1 truncate">{topic.title}</span>
                <span className="shrink-0 text-[10.5px] text-muted/70">
                  p. {topic.page_start}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ModeToggle({
  current,
  onChange,
  disabled,
}: {
  current: SearchMode;
  onChange: (mode: SearchMode) => void;
  disabled: boolean;
}) {
  // Only two modes make sense for a doc-scoped chat. We render them
  // as a segmented control so the active mode is always visible and
  // switching is one tap, not a dropdown roundtrip.
  const isLearn = current === "learn";
  return (
    <div
      role="tablist"
      aria-label="Chat mode"
      className="inline-flex shrink-0 items-center rounded-full border border-black/[0.06] bg-[#f7f7f6] p-[2px]"
    >
      <button
        type="button"
        role="tab"
        aria-selected={!isLearn}
        disabled={disabled}
        onClick={() => onChange("library")}
        className={`inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[11px] font-medium transition ${
          !isLearn
            ? "bg-white text-ink shadow-[0_1px_2px_rgba(15,23,42,0.06)]"
            : "text-muted hover:text-ink"
        }`}
      >
        <BookOpen className="h-3 w-3" />
        Library
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={isLearn}
        disabled={disabled}
        onClick={() => onChange("learn")}
        className={`inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[11px] font-medium transition ${
          isLearn
            ? "bg-white text-ink shadow-[0_1px_2px_rgba(15,23,42,0.06)]"
            : "text-muted hover:text-ink"
        }`}
      >
        <GraduationCap className="h-3 w-3" />
        Learn
      </button>
    </div>
  );
}
