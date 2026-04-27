"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Bot, Brain, Check, Copy, FileText, ImageIcon, MoreHorizontal, Paperclip, Pencil, Share2, TableProperties, ThumbsDown, ThumbsUp, User2 } from "lucide-react";

import { ExportDialog } from "@/components/chat/ExportDialog";
import { MessageFeedbackDialog } from "@/components/chat/MessageFeedbackDialog";
import { StreamingIndicator } from "@/components/chat/StreamingIndicator";
import { MessageVisualizationDashboard } from "@/components/chat/MessageVisualization";
import { Badge } from "@/components/ui/badge";
import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer";
import { Textarea } from "@/components/ui/textarea";
import type { ChatMessage, Citation, Document, MessageFeedbackRating, SearchMode } from "@/lib/types";
import { formatRelativeTime, toEditableDraft } from "@/lib/utils";
import { useDocumentStore } from "@/stores/documentStore";
import { useChatStore } from "@/stores/chatStore";
import { useGroupStore } from "@/stores/groupStore";

function formatModeLabel(mode: SearchMode) {
  if (mode === "deep_search") {
    return "Deep Search";
  }
  if (mode === "standard") {
    return "Standard";
  }
  if (mode === "google_analytics") {
    return "Google Analytics";
  }
  if (mode === "google_ads") {
    return "Google Ads";
  }
  return "Library";
}
import { usePDFViewerStore } from "@/stores/pdfViewerStore";

function useCitationOpener() {
  const activeGroupId = useGroupStore((state) => state.activeGroupId);
  const documentsByGroup = useDocumentStore((state) => state.documentsByGroup);
  const documents = useMemo(
    () => (activeGroupId ? documentsByGroup[activeGroupId] ?? [] : []),
    [activeGroupId, documentsByGroup],
  );
  const openCitation = usePDFViewerStore((state) => state.openCitation);

  return async (citation: Citation) => {
    const document = documents.find((item) => item.id === citation.document_id) ?? null;
    await openCitation(citation, document as Document | null);
  };
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  const openCitation = useCitationOpener();
  const sendEditedUserMessage = useChatStore((state) => state.sendEditedUserMessage);
  const updateMessageContent = useChatStore((state) => state.updateMessageContent);
  const streaming = useChatStore((state) => state.streaming);
  const userBubbleRef = useRef<HTMLDivElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const [isInlineEditing, setIsInlineEditing] = useState(false);
  const [editableContent, setEditableContent] = useState("");
  const [isSavingInlineEdit, setIsSavingInlineEdit] = useState(false);
  const [lockedUserBubbleWidth, setLockedUserBubbleWidth] = useState<number | null>(null);
  const [inlineEditError, setInlineEditError] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<"edit" | "copy" | "share" | null>(null);
  const [docsDialogOpen, setDocsDialogOpen] = useState(false);
  const [sheetsDialogOpen, setSheetsDialogOpen] = useState(false);
  const [feedbackDialogRating, setFeedbackDialogRating] = useState<MessageFeedbackRating | null>(null);
  const [savedFeedbackRating, setSavedFeedbackRating] = useState<MessageFeedbackRating | null>(null);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const feedbackTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isInlineEditing) {
      setEditableContent(toEditableDraft(message.content));
    }
  }, [isInlineEditing, message.content]);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) {
        window.clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!showMoreMenu) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (!moreMenuRef.current?.contains(event.target as Node)) {
        setShowMoreMenu(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [showMoreMenu]);

  const flashAction = (action: "edit" | "copy" | "share") => {
    if (feedbackTimerRef.current) {
      window.clearTimeout(feedbackTimerRef.current);
    }
    setActionFeedback(action);
    feedbackTimerRef.current = window.setTimeout(() => {
      setActionFeedback(null);
      feedbackTimerRef.current = null;
    }, 1200);
  };

  const startInlineEdit = () => {
    flashAction("edit");
    setEditableContent(toEditableDraft(message.content));
    setInlineEditError(null);
    if (message.role === "user") {
      setLockedUserBubbleWidth(userBubbleRef.current?.getBoundingClientRect().width ?? null);
    }
    setIsInlineEditing(true);
  };

  const saveInlineEdit = async () => {
    const nextContent = editableContent.trim();
    if (!nextContent) {
      return;
    }

    if (message.role === "user") {
      setIsSavingInlineEdit(true);
      setInlineEditError(null);
      try {
        await sendEditedUserMessage(message.id, nextContent);
        setIsInlineEditing(false);
        setLockedUserBubbleWidth(null);
      } catch (error) {
        setInlineEditError(error instanceof Error ? error.message : "Could not resend edited message.");
      } finally {
        setIsSavingInlineEdit(false);
      }
      return;
    }

    if (nextContent) {
      updateMessageContent(message.id, nextContent);
    }
    setIsInlineEditing(false);
  };

  const cancelInlineEdit = () => {
    setEditableContent(toEditableDraft(message.content));
    setIsInlineEditing(false);
    setLockedUserBubbleWidth(null);
    setInlineEditError(null);
  };

  const copyMessage = async () => {
    await navigator.clipboard.writeText(message.content);
    flashAction("copy");
  };

  const shareMessage = async () => {
    const sharePayload = {
      title: "Maia Axon response",
      text: message.content,
    };

    if (navigator.share) {
      try {
        await navigator.share(sharePayload);
        flashAction("share");
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
      }
    }

    await navigator.clipboard.writeText(message.content);
    flashAction("share");
  };

  if (message.role === "user") {
    return (
      <div
        className="flex justify-end scroll-mt-6"
        data-message-id={message.id}
        data-message-role={message.role}
      >
        <div
          ref={userBubbleRef}
          className="group/user min-w-[min(270px,78vw)] max-w-[78%] rounded-[30px] rounded-br-xl border border-black bg-black px-5 py-4 text-[15px] text-white"
          style={lockedUserBubbleWidth ? { width: lockedUserBubbleWidth } : undefined}
        >
          <div className={`${isInlineEditing ? "mb-2" : "mb-3"} flex min-w-0 items-center justify-between gap-2`}>
            <div className="flex min-w-0 items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-white/55">
              <User2 className="h-3.5 w-3.5" />
              You
            </div>
            {isInlineEditing ? (
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  className="inline-flex h-7 items-center rounded-full px-2 text-[11px] font-medium text-white/55 transition hover:bg-white/8 hover:text-white"
                  onClick={cancelInlineEdit}
                  disabled={isSavingInlineEdit}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="inline-flex h-7 items-center rounded-full bg-white px-2.5 text-[11px] font-semibold text-black transition hover:bg-white/90 disabled:opacity-60"
                  onClick={() => void saveInlineEdit()}
                  disabled={isSavingInlineEdit || streaming || !editableContent.trim()}
                >
                  {isSavingInlineEdit ? "Saving" : "Save"}
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover/user:opacity-100 group-focus-within/user:opacity-100">
                <button
                  type="button"
                  className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition ${
                    actionFeedback === "edit"
                      ? "bg-white text-black"
                      : "bg-white/8 text-white/70 hover:bg-white/14 hover:text-white"
                  }`}
                  aria-label="Edit message"
                  title="Edit"
                  onClick={startInlineEdit}
                  disabled={streaming}
                >
                  {actionFeedback === "edit" ? <Check className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition ${
                    actionFeedback === "copy"
                      ? "bg-white text-black"
                      : "bg-white/8 text-white/70 hover:bg-white/14 hover:text-white"
                  }`}
                  aria-label="Copy message"
                  title="Copy"
                  onClick={() => void copyMessage()}
                >
                  {actionFeedback === "copy" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
            )}
          </div>
          {message.attachments?.length ? (
            <div className="mb-4 flex flex-wrap gap-2">
              {message.attachments.map((attachment) => {
                const isImage = attachment.media_type.startsWith("image/");
                return (
                  <span
                    key={attachment.id}
                    className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/8 px-3 py-1.5 text-[11px] font-medium text-white/92 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                  >
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/10">
                      {isImage ? <ImageIcon className="h-3 w-3" /> : attachment.media_type.includes("pdf") ? <FileText className="h-3 w-3" /> : <Paperclip className="h-3 w-3" />}
                    </span>
                    <span className="max-w-[240px] truncate">{attachment.filename}</span>
                  </span>
                );
              })}
            </div>
          ) : null}
          {isInlineEditing ? (
            <>
              <Textarea
                value={editableContent}
                onChange={(event) => {
                  setEditableContent(event.target.value);
                  setInlineEditError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    cancelInlineEdit();
                  }
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    void saveInlineEdit();
                  }
                }}
                className="min-h-[72px] max-h-[280px] resize-none overflow-y-auto rounded-none border-0 border-b border-white/18 bg-transparent px-0 py-0 text-[1.02rem] leading-8 text-white shadow-none outline-none placeholder:text-white/40 focus:border-white/32 focus:ring-0"
                autoFocus
              />
              {inlineEditError ? (
                <p className="mt-3 text-[12px] leading-5 text-white/70">{inlineEditError}</p>
              ) : null}
            </>
          ) : (
            <p className="whitespace-pre-wrap text-[1.02rem] leading-8">{message.content}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="w-full scroll-mt-6"
      data-message-id={message.id}
      data-message-role={message.role}
    >
      <article className="group/assistant answer-workspace">
        <div className="answer-workspace-rail">
          <span className="answer-workspace-botmark">
            <span className="rounded-full border border-black/8 bg-black/[0.03] p-2 text-black shadow-[0_4px_14px_rgba(15,23,42,0.05)]">
              <Bot className="h-4 w-4" />
            </span>
          </span>
        </div>
        <div className="answer-workspace-surface">
          <div className="answer-workspace-header mb-7 flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 text-sm font-semibold text-ink">
              Maia Axon
            </span>
            <Badge className="rounded-full border-black/8 bg-black/[0.03] px-3 py-1 text-black">
              {formatModeLabel(message.searchMode)}
            </Badge>
            <span className="text-xs text-muted">{formatRelativeTime(message.createdAt)}</span>
            <StreamingIndicator status={message.status} searchMode={message.searchMode} />
            <div className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover/assistant:opacity-100 group-focus-within/assistant:opacity-100">
              {isInlineEditing ? (
                <>
                  <button
                    type="button"
                    className="inline-flex h-9 items-center gap-2 rounded-full border border-black/8 bg-white px-3 text-[12px] font-medium text-black/72 transition hover:border-black/12 hover:bg-black hover:text-white"
                    aria-label="Cancel edit"
                    title="Cancel"
                    onClick={cancelInlineEdit}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-9 items-center gap-2 rounded-full border border-black/8 bg-black px-3 text-[12px] font-medium text-white transition hover:bg-black/88"
                    aria-label="Save edit"
                    title="Save"
                    onClick={() => void saveInlineEdit()}
                  >
                    Save
                  </button>
                </>
              ) : (
                null
              )}
              <button
                type="button"
                className={`inline-flex h-9 items-center gap-2 rounded-full border px-3 text-[12px] font-medium transition ${
                  savedFeedbackRating === "up"
                    ? "border-black bg-black text-white"
                    : "border-black/8 bg-white text-black/72 hover:border-black/12 hover:bg-black hover:text-white"
                }`}
                aria-label="Mark response as helpful"
                title="Helpful"
                onClick={() => setFeedbackDialogRating("up")}
              >
                <ThumbsUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className={`inline-flex h-9 items-center gap-2 rounded-full border px-3 text-[12px] font-medium transition ${
                  savedFeedbackRating === "down"
                    ? "border-black bg-black text-white"
                    : "border-black/8 bg-white text-black/72 hover:border-black/12 hover:bg-black hover:text-white"
                }`}
                aria-label="Mark response as poor"
                title="Poor"
                onClick={() => setFeedbackDialogRating("down")}
              >
                <ThumbsDown className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className={`inline-flex h-9 items-center gap-2 rounded-full border px-3 text-[12px] font-medium transition ${
                  actionFeedback === "copy"
                    ? "border-black bg-black text-white"
                    : "border-black/8 bg-white text-black/72 hover:border-black/12 hover:bg-black hover:text-white"
                }`}
                aria-label="Copy response"
                title="Copy"
                onClick={() => void copyMessage()}
              >
                {actionFeedback === "copy" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {actionFeedback === "copy" ? "Copied" : "Copy"}
              </button>
              <div ref={moreMenuRef} className="relative">
                <button
                  type="button"
                  className="inline-flex h-9 items-center gap-2 rounded-full border border-black/8 bg-white px-3 text-[12px] font-medium text-black/72 transition hover:border-black/12 hover:bg-black hover:text-white"
                  aria-label="More response actions"
                  title="More"
                  onClick={() => setShowMoreMenu((current) => !current)}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                  More
                </button>
                {showMoreMenu ? (
                  <div className="absolute right-0 top-11 z-20 w-[210px] rounded-[18px] border border-black/[0.08] bg-white p-2 shadow-[0_18px_50px_rgba(15,23,42,0.14)]">
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-[12px] px-3 py-2.5 text-left text-sm font-medium text-ink transition hover:bg-black/[0.04]"
                      onClick={() => {
                        setShowMoreMenu(false);
                        startInlineEdit();
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edit response
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-[12px] px-3 py-2.5 text-left text-sm font-medium text-ink transition hover:bg-black/[0.04]"
                      onClick={() => {
                        setShowMoreMenu(false);
                        void shareMessage();
                      }}
                    >
                      <Share2 className="h-3.5 w-3.5" />
                      Share
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-[12px] px-3 py-2.5 text-left text-sm font-medium text-ink transition hover:bg-black/[0.04]"
                      onClick={() => {
                        setShowMoreMenu(false);
                        setDocsDialogOpen(true);
                      }}
                    >
                      <FileText className="h-3.5 w-3.5" />
                      Write to Docs
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-[12px] px-3 py-2.5 text-left text-sm font-medium text-ink transition hover:bg-black/[0.04]"
                      onClick={() => {
                        setShowMoreMenu(false);
                        setSheetsDialogOpen(true);
                      }}
                    >
                      <TableProperties className="h-3.5 w-3.5" />
                      Write to Sheets
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {message.warnings.length ? (
            <div className="mb-6 rounded-[24px] border border-black/10 bg-black/[0.03] p-4 text-sm text-ink">
              <div className="flex items-center gap-2 font-medium text-warn">
                <AlertTriangle className="h-4 w-4" />
                OCR / retrieval warning
              </div>
              <ul className="mt-2 space-y-1 text-sm text-ink/85">
                {message.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {message.needsClarification ? (
            <div className="rounded-[28px] border border-black/8 bg-black/[0.02] p-5">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-black">
                <Brain className="h-4 w-4" />
                Clarification needed
              </div>
              <p className="whitespace-pre-wrap text-[15px] leading-8 text-ink">{message.content}</p>
            </div>
          ) : (
            <>
              <div className="answer-workspace-body mt-4">
                {isInlineEditing ? (
                  <Textarea
                    value={editableContent}
                    onChange={(event) => setEditableContent(event.target.value)}
                    className="min-h-[280px] max-h-[65vh] overflow-y-auto rounded-[26px] border border-black/10 bg-white px-6 py-5 text-[16px] leading-8 tracking-[-0.02em] scrollbar-thin"
                  />
                ) : (
                  <>
                    <MarkdownRenderer
                      content={message.content || (message.isStreaming ? " " : "")}
                      citations={message.citations}
                      onCitationClick={openCitation}
                    />
                    {message.visualizations.length ? (
                      <MessageVisualizationDashboard visualizations={message.visualizations} />
                    ) : null}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </article>
      <ExportDialog
        open={docsDialogOpen}
        onOpenChange={setDocsDialogOpen}
        type="google_doc"
        message={message}
      />
      <ExportDialog
        open={sheetsDialogOpen}
        onOpenChange={setSheetsDialogOpen}
        type="google_sheet"
        message={message}
      />
      {feedbackDialogRating ? (
        <MessageFeedbackDialog
          open={feedbackDialogRating !== null}
          onOpenChange={(open) => {
            if (!open) {
              setFeedbackDialogRating(null);
            }
          }}
          message={message}
          rating={feedbackDialogRating}
          onSaved={setSavedFeedbackRating}
        />
      ) : null}
    </div>
  );
}
