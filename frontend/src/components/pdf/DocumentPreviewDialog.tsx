"use client";

import * as Dialog from "@radix-ui/react-dialog";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { GripHorizontal, MessageSquare, Maximize2, Minimize2, PanelRightClose, PanelRightOpen, X } from "lucide-react";

import { DocumentChatPane } from "@/components/pdf/DocumentChatPane";
import { useDialogDismiss } from "@/hooks/useDialogDismiss";
import type { ChatMessage, Document, SearchMode } from "@/lib/types";
import { useChatStore } from "@/stores/chatStore";
import { useConversationStore } from "@/stores/conversationStore";
import { useDocumentStore } from "@/stores/documentStore";
import { useGroupStore } from "@/stores/groupStore";
import { usePDFViewerStore } from "@/stores/pdfViewerStore";

// Per-document conversation id. When the user opens a PDF preview
// we look up whether they've chatted about this PDF before and
// resume that conversation; otherwise they get a fresh thread that
// becomes the document's conversation as soon as they send their
// first message. Stored in localStorage so it survives reloads.
const DOC_CONVERSATIONS_KEY = "pdfDocumentConversations";

function readDocConversations(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(DOC_CONVERSATIONS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeDocConversation(documentId: string, conversationId: string | null) {
  if (typeof window === "undefined") return;
  try {
    const map = readDocConversations();
    if (conversationId) {
      map[documentId] = conversationId;
    } else {
      delete map[documentId];
    }
    window.localStorage.setItem(DOC_CONVERSATIONS_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota errors */
  }
}

// Re-use the chat's full PDFViewer (search, highlights, annotations,
// outline, ask-Maia, etc.) inside the library preview dialog. SSR
// disabled because pdfjs-dist touches browser globals (DOMMatrix) at
// import time. The shared store means the chat-side viewer and the
// dialog viewer drive the same `currentDocument` — fine because the
// dialog is modal and stacks above the chat panel.
const PDFViewer = dynamic(
  () => import("@/components/pdf/PDFViewer").then((mod) => mod.PDFViewer),
  { ssr: false },
);

// Bounds. MIN_* keep the dialog usable; VIEWPORT_INSET stops it from
// kissing the browser edges when maximized.
const MIN_WIDTH = 640;
const MIN_HEIGHT = 480;
const VIEWPORT_INSET = 16;
// Keep at least this many pixels of the dialog visible after a drag,
// so the title bar never goes fully off-screen and the user can grab
// it again.
const DRAG_KEEP_VISIBLE = 80;
const STORAGE_KEY = "pdfDialogSize";
const CHAT_OPEN_STORAGE_KEY = "pdfDialogChatOpen";
const CHAT_PANE_WIDTH_STORAGE_KEY = "pdfDialogChatPaneWidth";
// Default + resize bounds for the chat pane. Min keeps the composer
// + message body readable; max is enforced dynamically against the
// dialog width below so the PDF never collapses to nothing.
const DEFAULT_CHAT_PANE_WIDTH = 420;
const MIN_CHAT_PANE_WIDTH = 320;
const MIN_PDF_PANE_WIDTH = 560;
// Below this dialog width we hide the chat pane regardless of the
// toggle state — there isn't enough horizontal room to read the PDF
// AND chat side-by-side. User can maximize the dialog to get it back.
const CHAT_MIN_DIALOG_WIDTH = 1100;

type Size = { width: number; height: number };
type Position = { x: number; y: number };

function readStoredSize(): Size | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.width === "number" &&
      typeof parsed.height === "number" &&
      parsed.width > 0 &&
      parsed.height > 0
    ) {
      return parsed as Size;
    }
  } catch {
    /* ignore corrupt storage */
  }
  return null;
}

function defaultSize(): Size {
  if (typeof window === "undefined") return { width: 1180, height: 860 };
  return {
    width: Math.min(1180, window.innerWidth - 48),
    height: Math.min(860, window.innerHeight - 48),
  };
}

function clampSize(size: Size): Size {
  if (typeof window === "undefined") return size;
  return {
    width: Math.max(MIN_WIDTH, Math.min(size.width, window.innerWidth - VIEWPORT_INSET)),
    height: Math.max(MIN_HEIGHT, Math.min(size.height, window.innerHeight - VIEWPORT_INSET)),
  };
}

function centeredPosition(size: Size): Position {
  if (typeof window === "undefined") return { x: 0, y: 0 };
  return {
    x: Math.max(VIEWPORT_INSET / 2, Math.round((window.innerWidth - size.width) / 2)),
    y: Math.max(VIEWPORT_INSET / 2, Math.round((window.innerHeight - size.height) / 2)),
  };
}

function clampPosition(position: Position, size: Size): Position {
  if (typeof window === "undefined") return position;
  // Keep the title bar reachable: at least DRAG_KEEP_VISIBLE px of the
  // dialog must stay on each axis, and we never let the top edge fall
  // above the viewport.
  const minX = DRAG_KEEP_VISIBLE - size.width;
  const maxX = window.innerWidth - DRAG_KEEP_VISIBLE;
  const minY = 0;
  const maxY = window.innerHeight - DRAG_KEEP_VISIBLE;
  return {
    x: Math.min(maxX, Math.max(minX, position.x)),
    y: Math.min(maxY, Math.max(minY, position.y)),
  };
}

type ResizeDirection = "se" | "sw" | "ne" | "nw";

// Mounted ONCE at AppShell. The store drives ``previewDocument`` so all
// trigger points (sidebar library, admin uploader, composer attachment
// picker) feed the same dialog — which means a single ``<PDFViewer>``
// instance, and its loaded PDFDocumentProxy survives close/re-open
// cycles. That's the whole point of this single-mount setup.
export function DocumentPreviewDialog() {
  const document = usePDFViewerStore((s) => s.previewDocument);
  const closePreview = usePDFViewerStore((s) => s.closePreview);
  const onOpenChange = (open: boolean) => {
    if (!open) closePreview();
  };
  const loadPage = usePDFViewerStore((state) => state.loadPage);
  const closeStore = usePDFViewerStore((state) => state.close);
  // We auto-select this PDF in the document store on open so the
  // composer attaches it as a source for every message; the previous
  // selection is restored on close. The chat lives next to the PDF
  // in a split-pane layout; the user toggles it via the PDF toolbar.
  const setSelectedDocuments = useDocumentStore((s) => s.setSelectedDocuments);
  const previousSelection = useRef<string[] | null>(null);
  const setActiveGroup = useGroupStore((s) => s.setActiveGroup);
  const previousActiveGroup = useRef<string | null>(null);
  // We isolate the preview's chat from the main-app chat so the
  // user doesn't see (e.g.) their "Google Ads Report for Coateq"
  // conversation bleeding into a PDF preview. On open we stash the
  // main chat's state, swap to either this document's saved
  // conversation or a fresh thread; on close we restore.
  const previousChatState = useRef<{
    messages: ChatMessage[];
    conversationId: string | null;
    draft: string;
    mode: SearchMode;
  } | null>(null);
  // Chat-open is shared with PDFToolbar via the pdfViewerStore so the
  // toolbar button can toggle it. We seed it from localStorage and
  // mirror writes back so the preference sticks across opens.
  const chatPaneOpen = usePDFViewerStore((s) => s.chatPaneOpen);
  const setChatPaneAvailable = usePDFViewerStore((s) => s.setChatPaneAvailable);
  const setChatPaneOpen = usePDFViewerStore((s) => s.setChatPaneOpen);
  // User-resizable chat pane width. Persisted across sessions so the
  // user's preferred split stays the same on next open.
  const [chatPaneWidth, setChatPaneWidth] = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_CHAT_PANE_WIDTH;
    try {
      const raw = window.localStorage.getItem(CHAT_PANE_WIDTH_STORAGE_KEY);
      const parsed = raw ? Number.parseInt(raw, 10) : NaN;
      if (Number.isFinite(parsed) && parsed >= MIN_CHAT_PANE_WIDTH) {
        return parsed;
      }
    } catch {
      /* ignore corrupt storage */
    }
    return DEFAULT_CHAT_PANE_WIDTH;
  });
  const [resizingChatPane, setResizingChatPane] = useState(false);
  const {
    handleOpenChange,
    handlePointerDownOutside,
    handleEscapeKeyDown,
    handleFocusOutside,
    handleInteractOutside,
    requestClose,
  } = useDialogDismiss(() => onOpenChange(false));

  // Initialise size from localStorage (so the user's preferred size
  // sticks across opens) clamped to the current viewport. Position
  // always centres on first open — feels more predictable than
  // restoring a stale screen coordinate that might be on a monitor
  // that's no longer attached.
  const [size, setSize] = useState<Size>(() => {
    const stored = readStoredSize();
    return clampSize(stored ?? defaultSize());
  });
  const [position, setPosition] = useState<Position>(() => {
    const stored = readStoredSize();
    return centeredPosition(clampSize(stored ?? defaultSize()));
  });
  const [maximized, setMaximized] = useState(false);
  // Track whether the user is mid-drag/resize so we can suppress
  // text selection and lock pointer style at the body level.
  const [interacting, setInteracting] = useState<null | "drag" | ResizeDirection>(null);
  // Remember the pre-maximize geometry so Restore goes back where the
  // user had it.
  const preMaxRef = useRef<{ size: Size; position: Position } | null>(null);

  // Persist size on change (but not the transient maximized one).
  useEffect(() => {
    if (typeof window === "undefined" || maximized) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(size));
    } catch {
      /* ignore quota errors */
    }
  }, [size, maximized]);

  // Keep the dialog usable when the browser is resized — clamp both
  // size and position to the new viewport.
  useEffect(() => {
    const onResize = () => {
      setSize((current) => clampSize(current));
      setPosition((current) => clampPosition(current, size));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [size]);

  // Push the picked document into the shared viewer store when the
  // dialog opens; tear it down on close so the chat panel doesn't
  // keep showing the doc the user just dismissed. Also re-centre on
  // open so each library click feels predictable.
  //
  // We also temporarily scope the chat composer to this PDF: stash
  // whatever was selected before, swap in this document, and put
  // the user on the doc's library group so the composer's "Library"
  // mode targets it. Both are restored on close.
  useEffect(() => {
    if (!document) return;
    void loadPage(document, 1, []);
    setPosition((current) => {
      // If the dialog was already open and the user had moved it, leave
      // the position alone. Only re-centre when first opening (i.e.
      // we're transitioning from "no document" to "document").
      return current;
    });
    previousSelection.current =
      useDocumentStore.getState().selectedDocumentIds;
    previousActiveGroup.current =
      useGroupStore.getState().activeGroupId;
    setSelectedDocuments([document.id]);
    if (document.group_id) {
      setActiveGroup(document.group_id);
    }

    // Stash main-app chat state, then swap to a doc-scoped session.
    // If this document has a saved conversation, resume it from
    // cache (no network roundtrip); otherwise clear to a fresh
    // thread that the backend will assign a new conversation_id to
    // on the first message.
    const chatStore = useChatStore.getState();
    const convStore = useConversationStore.getState();
    previousChatState.current = {
      messages: chatStore.messages,
      conversationId: convStore.activeConversationId,
      draft: chatStore.draft,
      mode: chatStore.mode,
    };

    const savedConvId = readDocConversations()[document.id] ?? null;
    if (savedConvId) {
      const cached = chatStore.getCachedMessagesForConversation(savedConvId);
      if (cached && cached.length > 0) {
        chatStore.hydrateMessages(cached, savedConvId);
        convStore.setActiveConversationId(savedConvId);
      } else {
        // No cached transcript yet — fetch in the background. Until
        // it arrives the user sees an empty thread, which is fine.
        chatStore.clearChat();
        convStore.setActiveConversationId(savedConvId);
        void convStore.loadConversation(savedConvId).catch(() => {
          // Stale id (the conversation was deleted). Drop it and
          // let the user start fresh next time.
          writeDocConversation(document.id, null);
        });
      }
    } else {
      chatStore.clearChat();
      convStore.setActiveConversationId(null);
    }
    chatStore.setMode("library");
    return () => {
      closeStore();
      if (previousSelection.current !== null) {
        setSelectedDocuments(previousSelection.current);
        previousSelection.current = null;
      }
      if (previousActiveGroup.current !== null) {
        setActiveGroup(previousActiveGroup.current);
        previousActiveGroup.current = null;
      }

      // Save whatever conversation the user ended up on as this
      // document's persistent thread, then restore the main app's
      // chat to what it was before the preview opened.
      const docId = document.id;
      const endingConvId = useConversationStore.getState().activeConversationId;
      if (endingConvId) {
        writeDocConversation(docId, endingConvId);
      }
      // If a stream is still in flight (user closed the preview
      // mid-response) stop it first so subsequent WS events don't
      // land on the restored main-app messages array and corrupt it.
      if (useChatStore.getState().streaming) {
        useChatStore.getState().stopStreaming();
      }
      const stashed = previousChatState.current;
      if (stashed) {
        useChatStore.setState({
          messages: stashed.messages,
          draft: stashed.draft,
          mode: stashed.mode,
          streaming: false,
          editingMessageId: null,
        });
        useConversationStore
          .getState()
          .setActiveConversationId(stashed.conversationId);
      }
      previousChatState.current = null;
    };
  }, [document, loadPage, closeStore, setSelectedDocuments, setActiveGroup]);

  // Seed the chat-open preference from localStorage on first mount of
  // an open dialog, then mirror writes back. We do not respect the
  // preference when the dialog is narrower than CHAT_MIN_DIALOG_WIDTH
  // — see chatVisible below.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(CHAT_OPEN_STORAGE_KEY);
      if (raw !== null) {
        setChatPaneOpen(raw === "true");
      }
    } catch {
      /* ignore storage errors */
    }
  }, [setChatPaneOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        CHAT_OPEN_STORAGE_KEY,
        chatPaneOpen ? "true" : "false",
      );
    } catch {
      /* ignore storage errors */
    }
  }, [chatPaneOpen]);

  useEffect(() => {
    if (typeof window === "undefined" || resizingChatPane) return;
    try {
      window.localStorage.setItem(
        CHAT_PANE_WIDTH_STORAGE_KEY,
        String(Math.round(chatPaneWidth)),
      );
    } catch {
      /* ignore storage errors */
    }
  }, [chatPaneWidth, resizingChatPane]);

  // Tell the PDF toolbar (via the shared pdfViewerStore) that a chat
  // pane is available to toggle. Clear the flag on unmount so the
  // main-app PDF viewer doesn't show an orphan Chat button.
  useEffect(() => {
    if (!document) return;
    setChatPaneAvailable(true);
    return () => setChatPaneAvailable(false);
  }, [document, setChatPaneAvailable]);

  // Re-centre whenever the dialog opens fresh.
  useEffect(() => {
    if (!document) return;
    setPosition(centeredPosition(size));
    setMaximized(false);
    // Intentionally only re-run on document identity (open events),
    // not on every size change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document]);

  const startDrag = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (maximized) return;
      // Don't intercept clicks on buttons inside the title bar.
      const target = event.target as HTMLElement;
      if (target.closest("button")) return;
      event.preventDefault();
      const startMouseX = event.clientX;
      const startMouseY = event.clientY;
      const startPos = position;

      setInteracting("drag");
      const previousCursor = window.document.body.style.cursor;
      const previousSelect = window.document.body.style.userSelect;
      window.document.body.style.cursor = "grabbing";
      window.document.body.style.userSelect = "none";

      const onMove = (moveEvent: MouseEvent) => {
        setPosition(
          clampPosition(
            {
              x: startPos.x + (moveEvent.clientX - startMouseX),
              y: startPos.y + (moveEvent.clientY - startMouseY),
            },
            size,
          ),
        );
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.document.body.style.cursor = previousCursor;
        window.document.body.style.userSelect = previousSelect;
        setInteracting(null);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [maximized, position, size],
  );

  // Drag resize from a corner. Position-aware: the corner the user
  // grabs follows their mouse, the *opposite* corner stays pinned.
  // This is what every native window does, and it requires updating
  // both position and size for the n/w directions.
  const startResize = useCallback(
    (direction: ResizeDirection) =>
      (event: React.MouseEvent<HTMLDivElement>) => {
        if (maximized) return;
        event.preventDefault();
        event.stopPropagation();
        const startMouseX = event.clientX;
        const startMouseY = event.clientY;
        const startSize = size;
        const startPos = position;

        setInteracting(direction);
        const cursorStyle =
          direction === "se" || direction === "nw" ? "nwse-resize" : "nesw-resize";
        const previousCursor = window.document.body.style.cursor;
        const previousSelect = window.document.body.style.userSelect;
        window.document.body.style.cursor = cursorStyle;
        window.document.body.style.userSelect = "none";

        const onMove = (moveEvent: MouseEvent) => {
          const dx = moveEvent.clientX - startMouseX;
          const dy = moveEvent.clientY - startMouseY;
          let nextW = startSize.width;
          let nextH = startSize.height;
          let nextX = startPos.x;
          let nextY = startPos.y;
          if (direction.includes("e")) nextW = startSize.width + dx;
          if (direction.includes("s")) nextH = startSize.height + dy;
          if (direction.includes("w")) {
            nextW = startSize.width - dx;
            nextX = startPos.x + dx;
          }
          if (direction.includes("n")) {
            nextH = startSize.height - dy;
            nextY = startPos.y + dy;
          }
          // Clamp width/height. When shrinking via a top/left edge we
          // also clamp the matching position so the opposite corner
          // stays pinned.
          const maxW = window.innerWidth - VIEWPORT_INSET;
          const maxH = window.innerHeight - VIEWPORT_INSET;
          if (nextW < MIN_WIDTH) {
            if (direction.includes("w")) nextX -= MIN_WIDTH - nextW;
            nextW = MIN_WIDTH;
          }
          if (nextW > maxW) {
            if (direction.includes("w")) nextX += nextW - maxW;
            nextW = maxW;
          }
          if (nextH < MIN_HEIGHT) {
            if (direction.includes("n")) nextY -= MIN_HEIGHT - nextH;
            nextH = MIN_HEIGHT;
          }
          if (nextH > maxH) {
            if (direction.includes("n")) nextY += nextH - maxH;
            nextH = maxH;
          }
          setSize({ width: nextW, height: nextH });
          setPosition({ x: nextX, y: nextY });
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          window.document.body.style.cursor = previousCursor;
          window.document.body.style.userSelect = previousSelect;
          setInteracting(null);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      },
    [maximized, position, size],
  );

  const toggleMaximize = useCallback(() => {
    if (maximized) {
      const restored = preMaxRef.current;
      preMaxRef.current = null;
      setMaximized(false);
      if (restored) {
        setSize(restored.size);
        setPosition(restored.position);
      }
    } else {
      preMaxRef.current = { size, position };
      setMaximized(true);
    }
  }, [maximized, size, position]);

  // Double-click the drag bar to toggle maximize, just like every
  // desktop window manager.
  const onDragBarDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest("button")) return;
      toggleMaximize();
    },
    [toggleMaximize],
  );

  // Effective rendered geometry (maximized fills viewport with inset).
  const renderedSize: Size = maximized
    ? typeof window !== "undefined"
      ? { width: window.innerWidth - VIEWPORT_INSET, height: window.innerHeight - VIEWPORT_INSET }
      : size
    : size;
  const renderedPos: Position = maximized
    ? { x: VIEWPORT_INSET / 2, y: VIEWPORT_INSET / 2 }
    : position;

  // Chat-pane visibility: the user toggles it via the PDF toolbar's
  // Chat button. We override to hide when the dialog is too narrow
  // for both panes to be usable (PDF needs MIN_PDF_PANE_WIDTH, chat
  // needs MIN_CHAT_PANE_WIDTH). At that size the toolbar button is
  // still shown (so the user knows the affordance exists) but
  // clicking widens the dialog instead of changing layout.
  const chatRoomAvailable = renderedSize.width >= CHAT_MIN_DIALOG_WIDTH;
  const chatVisible = chatPaneOpen && chatRoomAvailable && document !== null;
  // Effective chat-pane width clamped against the current dialog
  // width so the PDF always keeps MIN_PDF_PANE_WIDTH on screen.
  const effectiveChatWidth = chatVisible
    ? Math.max(
        MIN_CHAT_PANE_WIDTH,
        Math.min(chatPaneWidth, renderedSize.width - MIN_PDF_PANE_WIDTH),
      )
    : 0;

  const startChatResize = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!chatVisible) return;
      event.preventDefault();
      event.stopPropagation();
      const startMouseX = event.clientX;
      const startWidth = effectiveChatWidth;
      const dialogWidth = renderedSize.width;
      setResizingChatPane(true);
      const previousCursor = window.document.body.style.cursor;
      const previousSelect = window.document.body.style.userSelect;
      window.document.body.style.cursor = "col-resize";
      window.document.body.style.userSelect = "none";

      const onMove = (moveEvent: MouseEvent) => {
        // Drag right shrinks the chat (mouse moves right → divider
        // shifts right → less room on the right for chat). Reverse:
        // drag left grows the chat. So we subtract the delta.
        const delta = moveEvent.clientX - startMouseX;
        const proposed = startWidth - delta;
        const maxAllowed = dialogWidth - MIN_PDF_PANE_WIDTH;
        const next = Math.max(
          MIN_CHAT_PANE_WIDTH,
          Math.min(proposed, maxAllowed),
        );
        setChatPaneWidth(next);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.document.body.style.cursor = previousCursor;
        window.document.body.style.userSelect = previousSelect;
        setResizingChatPane(false);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [chatVisible, effectiveChatWidth, renderedSize.width],
  );

  // When the user toggles chat on but the dialog is too narrow, widen
  // the dialog enough to show both panes (preserving the current
  // PDF width). The PDF toolbar's Chat button calls toggleChatPane
  // via the store; we observe the state here and react.
  useEffect(() => {
    if (typeof window === "undefined" || !document) return;
    if (chatPaneOpen && !chatRoomAvailable && !maximized) {
      const target = clampSize({
        width: Math.max(renderedSize.width, CHAT_MIN_DIALOG_WIDTH),
        height: renderedSize.height,
      });
      if (target.width !== renderedSize.width || target.height !== renderedSize.height) {
        setSize(target);
        setPosition(centeredPosition(target));
      }
    }
  }, [chatPaneOpen, chatRoomAvailable, maximized, document, renderedSize.width, renderedSize.height]);

  const resizeHandleClass = (cursor: string, edge: string) =>
    `absolute z-40 ${edge} ${cursor} ${maximized ? "pointer-events-none opacity-0" : ""}`;

  return (
    <Dialog.Root open={document !== null} onOpenChange={handleOpenChange}>
      {/* ``forceMount`` on both Portal and Content keeps the entire
          dialog subtree (including the heavy <PDFViewer>) in the React
          tree even when the dialog is closed. That preserves the
          PDFDocumentProxy react-pdf parsed on open, so re-opening the
          same document is instant instead of triggering a full
          re-download + re-parse. Visibility is driven by the
          ``data-state="open"|"closed"`` attribute Radix sets on the
          elements — the Tailwind classes below collapse the content
          and overlay to invisible/non-interactive when closed. */}
      <Dialog.Portal forceMount>
        {/* ``data-[state=closed]:hidden`` (display:none) on both
            elements is intentional. ``opacity-0`` alone would leave
            the Overlay's ``backdrop-blur-[18px]`` applied to the page
            behind it, so even though the dialog was invisible, the
            entire app would be blurred. display:none removes the
            element from rendering altogether — no filter, no paint,
            no layout. Radix still tracks state via data attributes
            independently of display. */}
        <Dialog.Overlay
          forceMount
          className="fixed inset-0 z-[70] bg-black/18 backdrop-blur-[18px] data-[state=closed]:hidden"
          onDoubleClick={requestClose}
        />
        <Dialog.Content
          forceMount
          aria-describedby={undefined}
          style={{
            left: renderedPos.x,
            top: renderedPos.y,
            width: renderedSize.width,
            height: renderedSize.height,
          }}
          className={`fixed z-[80] flex flex-col overflow-hidden rounded-[30px] border border-black/[0.06] bg-panel shadow-[0_24px_60px_rgba(17,17,17,0.12)] outline-none data-[state=closed]:hidden ${
            interacting ? "select-none" : ""
          }`}
          onPointerDownOutside={handlePointerDownOutside}
          onEscapeKeyDown={handleEscapeKeyDown}
          onFocusOutside={handleFocusOutside}
          onInteractOutside={handleInteractOutside}
        >
          <Dialog.Title className="sr-only">
            {document?.filename ?? "PDF Preview"}
          </Dialog.Title>
          {/* Window-style title bar. Left: grip + drag-anywhere area.
              Right: maximize + close. Double-click anywhere on the
              bar (except buttons) to toggle maximize. */}
          <div
            onMouseDown={startDrag}
            onDoubleClick={onDragBarDoubleClick}
            className={`relative flex h-9 shrink-0 items-center justify-end border-b border-black/[0.06] bg-[#f7f7f6] px-2 ${
              maximized ? "cursor-default" : "cursor-grab active:cursor-grabbing"
            }`}
          >
            {/* Centered "drag to move" label sits in an absolute layer
                so it lines up with the dialog midpoint regardless of
                what's on either side. pointer-events-none lets the
                drag handler on the parent still receive the mouse. */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted/70">
              <GripHorizontal className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              <span className="select-none text-[10px] font-medium uppercase tracking-[0.18em]">
                Drag to move
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label={maximized ? "Restore size" : "Maximize"}
                title={maximized ? "Restore size" : "Maximize"}
                onClick={toggleMaximize}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-muted transition hover:border-black/[0.10] hover:bg-white hover:text-ink"
              >
                {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                aria-label="Close preview"
                onClick={requestClose}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-muted transition hover:border-black/[0.10] hover:bg-white hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex flex-1 overflow-hidden">
            <div className="min-h-0 min-w-0 flex-1">
              {/* PDFViewer is mounted unconditionally so the loaded
                  PDFDocumentProxy survives the dialog being closed.
                  It reads ``currentDocument`` from the shared store —
                  if no document has ever been opened, it renders an
                  empty state internally. */}
              <PDFViewer />
            </div>
            {chatVisible ? (
              <>
                {/* Draggable divider between the PDF and the chat
                    pane. 6px visible line, 12px hit-target so it's
                    easy to grab. Cursor flips to col-resize while
                    hovering and stays that way during drag. */}
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize chat pane"
                  onMouseDown={startChatResize}
                  className={`group relative h-full w-[6px] shrink-0 cursor-col-resize select-none bg-black/[0.05] transition hover:bg-accent/40 ${
                    resizingChatPane ? "bg-accent/50" : ""
                  }`}
                >
                  {/* Wider invisible hit area for easier grabbing. */}
                  <div className="absolute inset-y-0 left-[-3px] right-[-3px]" />
                </div>
                <div
                  className="flex h-full shrink-0 flex-col border-l border-black/[0.06] bg-panel"
                  style={{ width: effectiveChatWidth }}
                >
                  <DocumentChatPane />
                </div>
              </>
            ) : null}
          </div>
          {/* Corner resize handles. Invisible — the cursor change on
              hover is the affordance, same pattern Notion / Figma /
              Slack use. Generous 22px target so they're easy to grab
              even against the 30px corner radius. */}
          <div
            aria-hidden="true"
            onMouseDown={startResize("se")}
            className={resizeHandleClass(
              "cursor-nwse-resize",
              "bottom-0 right-0 h-[22px] w-[22px]",
            )}
          />
          <div
            aria-hidden="true"
            onMouseDown={startResize("sw")}
            className={resizeHandleClass(
              "cursor-nesw-resize",
              "bottom-0 left-0 h-[22px] w-[22px]",
            )}
          />
          <div
            aria-hidden="true"
            onMouseDown={startResize("ne")}
            className={resizeHandleClass(
              "cursor-nesw-resize",
              "top-0 right-0 h-[22px] w-[22px]",
            )}
          />
          <div
            aria-hidden="true"
            onMouseDown={startResize("nw")}
            className={resizeHandleClass(
              "cursor-nwse-resize",
              "top-0 left-0 h-[22px] w-[22px]",
            )}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
