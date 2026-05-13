"use client";

import { useEffect, useRef, useState } from "react";
import {
  History,
  MessageSquareText,
  Network,
  PanelLeftOpen,
  Search,
  SquarePen,
} from "lucide-react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";

import { SidebarHistory } from "@/components/layout/SidebarHistory";
import { ChatPanel } from "@/components/layout/ChatPanel";
import { DocumentPanel } from "@/components/layout/DocumentPanel";
import { DocumentPreviewDialog } from "@/components/pdf/DocumentPreviewDialog";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/authStore";
import { useChatStore } from "@/stores/chatStore";
import { useConversationStore } from "@/stores/conversationStore";
import { usePDFViewerStore } from "@/stores/pdfViewerStore";

function deriveInitials(name: string | null | undefined): string {
  if (!name) return "?";
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return ((parts[0]?.[0] ?? "") + (parts[parts.length - 1]?.[0] ?? "")).toUpperCase();
}

function ResizeHandle() {
  return (
    <PanelResizeHandle className="group relative mx-1 w-px bg-transparent">
      <div className="absolute inset-y-6 left-1/2 w-px -translate-x-1/2 bg-black/[0.08] transition group-hover:bg-black/[0.16]" />
    </PanelResizeHandle>
  );
}

function useViewportMode() {
  const [width, setWidth] = useState(1600);

  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  if (width < 768) {
    return "mobile" as const;
  }
  if (width < 1200) {
    return "tablet" as const;
  }
  return "desktop" as const;
}

export function AppShell() {
  const mode = useViewportMode();
  const [mobileTab, setMobileTab] = useState<"history" | "chat" | "sources">("chat");
  // Sidebar open/closed state persists to localStorage so the choice
  // sticks across page loads — Claude / ChatGPT both work this way.
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      const raw = window.localStorage.getItem("historyDrawerOpen");
      return raw === "true";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("historyDrawerOpen", String(historyDrawerOpen));
    } catch {
      /* ignore quota errors */
    }
  }, [historyDrawerOpen]);
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const closeDrawerTimeoutRef = useRef<number | null>(null);
  const searchMode = useChatStore((state) => state.mode);
  const startNewConversation = useConversationStore((state) => state.startNewConversation);
  const authUser = useAuthStore((state) => state.user);
  const userInitials = deriveInitials(authUser?.name ?? authUser?.email ?? null);
  // Nonce incremented when the user clicks "Search" from the
  // collapsed rail. SidebarHistory watches it and opens its search
  // input + focus. Use a nonce (not a bool) so repeated clicks while
  // the drawer is already open re-fire the focus.
  const [searchOpenNonce, setSearchOpenNonce] = useState(0);
  const currentDocument = usePDFViewerStore((state) => state.currentDocument);
  const currentWebCitation = usePDFViewerStore((state) => state.currentWebCitation);
  const sourcesPanelHidden = usePDFViewerStore((state) => state.sourcesPanelHidden);
  const closeViewer = usePDFViewerStore((state) => state.close);
  const showSourcesPanel =
    searchMode !== "standard" &&
    !sourcesPanelHidden &&
    (!!currentDocument || !!currentWebCitation);

  useEffect(() => {
    if (searchMode === "standard") {
      closeViewer();
      if (mobileTab === "sources") {
        setMobileTab("chat");
      }
    }
  }, [closeViewer, mobileTab, searchMode]);

  useEffect(() => {
    return () => {
      if (closeDrawerTimeoutRef.current !== null) {
        window.clearTimeout(closeDrawerTimeoutRef.current);
      }
    };
  }, []);

  function cancelCloseDrawer() {
    if (closeDrawerTimeoutRef.current !== null) {
      window.clearTimeout(closeDrawerTimeoutRef.current);
      closeDrawerTimeoutRef.current = null;
    }
  }

  function openHistoryDrawer() {
    cancelCloseDrawer();
    setHistoryDrawerOpen(true);
  }

  function scheduleCloseDrawer() {
    if (historyModalOpen) {
      return;
    }
    cancelCloseDrawer();
    closeDrawerTimeoutRef.current = window.setTimeout(() => {
      setHistoryDrawerOpen(false);
      closeDrawerTimeoutRef.current = null;
    }, 140);
  }

  useEffect(() => {
    if (!historyModalOpen) {
      return;
    }

    cancelCloseDrawer();
    setHistoryDrawerOpen(true);
  }, [historyModalOpen]);

  const panels = {
    history: <SidebarHistory onModalStateChange={setHistoryModalOpen} />,
    chat: <ChatPanel />,
    sources: <DocumentPanel />,
  };

  if (mode !== "desktop") {
    return (
      <ErrorBoundary>
        {/* Single preview-dialog mount. forceMount keeps the heavy
            <PDFViewer> alive across open/close so re-opening the same
            PDF is instant — see DocumentPreviewDialog for details. */}
        <DocumentPreviewDialog />
        <div className="flex h-screen flex-col gap-4 bg-bg p-4">
          <div className="grid grid-cols-3 gap-2 rounded-[24px] bg-panel p-2 shadow-[0_12px_30px_rgba(15,23,42,0.05)]">
            {[
              { key: "history", label: "History", icon: History },
              { key: "chat", label: "Chat", icon: MessageSquareText },
              { key: "sources", label: "Sources", icon: Network },
            ]
              .filter((tab) => tab.key !== "sources" || showSourcesPanel)
              .map((tab) => {
              const Icon = tab.icon;
              const active = mobileTab === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  className={cn(
                    "inline-flex items-center justify-center gap-2 rounded-[20px] px-3 py-3 text-sm font-medium transition",
                    active ? "bg-accent text-white" : "text-muted hover:bg-black/5",
                  )}
                  onClick={() => setMobileTab(tab.key as typeof mobileTab)}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                </button>
              );
            })}
          </div>
          <div className="min-h-0 flex-1 rounded-[28px] bg-panel p-2 shadow-[0_18px_36px_rgba(15,23,42,0.05)]">
            {panels[mobileTab]}
          </div>
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      {/* Single preview-dialog mount — see comment in the mobile branch
          above. Keeping it outside the PanelGroup means the loaded PDF
          survives layout reflows too. */}
      <DocumentPreviewDialog />
      {/*
        Full-bleed flex layout, ChatGPT-style: no outer padding, no
        rounded card chrome, no shadows. Sidebar and main content sit
        directly against the viewport edges, separated only by a
        hairline divider where the sidebar meets the main column.
      */}
      <div className="relative flex h-screen bg-panel app-grid">
        <div
          className={cn(
            "flex h-full shrink-0 flex-col overflow-hidden border-r border-black/[0.08] bg-panel transition-[width] duration-200 ease-out",
            historyDrawerOpen ? "w-[260px]" : "w-[56px]",
          )}
        >
          <div
            className={cn(
              "flex h-full w-[56px] shrink-0 flex-col items-center gap-1 px-2 py-3 transition-opacity",
              historyDrawerOpen ? "pointer-events-none absolute opacity-0" : "opacity-100",
            )}
          >
            {/* ChatGPT/Claude-style collapsed rail. Each icon is a
                separate action: expand, new chat, search — not three
                buttons that all just open the drawer. */}
            <button
              type="button"
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted transition hover:bg-black/[0.05] hover:text-ink focus:outline-none focus:ring-2 focus:ring-black/10"
              onClick={openHistoryDrawer}
              aria-label="Expand sidebar"
              aria-expanded={historyDrawerOpen}
              title="Expand sidebar"
            >
              <PanelLeftOpen className="h-5 w-5" />
            </button>
            <button
              type="button"
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted transition hover:bg-black/[0.05] hover:text-ink focus:outline-none focus:ring-2 focus:ring-black/10"
              onClick={() => startNewConversation()}
              aria-label="New chat"
              title="New chat"
            >
              <SquarePen className="h-5 w-5" />
            </button>
            <button
              type="button"
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted transition hover:bg-black/[0.05] hover:text-ink focus:outline-none focus:ring-2 focus:ring-black/10"
              onClick={() => {
                openHistoryDrawer();
                setSearchOpenNonce((current) => current + 1);
              }}
              aria-label="Search chats"
              title="Search chats"
            >
              <Search className="h-5 w-5" />
            </button>
            <button
              type="button"
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted transition hover:bg-black/[0.05] hover:text-ink focus:outline-none focus:ring-2 focus:ring-black/10"
              onClick={openHistoryDrawer}
              aria-label="Open chat history"
              title="History"
            >
              <History className="h-5 w-5" />
            </button>
            <div className="mt-auto flex flex-col items-center">
              {/* Single account avatar — combines Suggest idea +
                  Settings + Logout into one entry point. Clicking it
                  expands the sidebar, where the full AccountBar
                  surfaces the menu. */}
              <button
                type="button"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-black text-[10px] font-semibold uppercase tracking-wider text-white transition hover:scale-[1.05] focus:outline-none focus:ring-2 focus:ring-black/20"
                onClick={openHistoryDrawer}
                aria-label="Open account menu"
                title={authUser?.name ?? authUser?.email ?? "Account"}
              >
                {userInitials}
              </button>
            </div>
          </div>

          <div
            className={cn(
              "h-full min-h-0 w-[260px] overflow-hidden transition-opacity duration-150",
              historyDrawerOpen ? "opacity-100" : "pointer-events-none opacity-0",
            )}
          >
            <SidebarHistory
              onModalStateChange={setHistoryModalOpen}
              onCollapseSidebar={() => setHistoryDrawerOpen(false)}
              searchOpenNonce={searchOpenNonce}
            />
          </div>
        </div>
        {/*
          Main content column. Full-bleed: no card wrapper, no
          rounded corners, no shadow. Chat fills the column directly.
          Sources panel (when present) is separated by the
          ResizeHandle's vertical line.
        */}
        <div className="relative h-full min-w-0 flex-1 bg-panel">
          <PanelGroup direction="horizontal" className="h-full min-h-0">
            <Panel defaultSize={56} minSize={40}>
              <div className="h-full min-h-0 overflow-hidden bg-panel">
                <ChatPanel />
              </div>
            </Panel>
            {showSourcesPanel ? (
              <>
                <ResizeHandle />
                <Panel defaultSize={28} minSize={20} maxSize={42}>
                  <div className="h-full min-h-0 overflow-hidden border-l border-black/[0.08] bg-panel">
                    <DocumentPanel />
                  </div>
                </Panel>
              </>
            ) : null}
          </PanelGroup>
        </div>
      </div>
    </ErrorBoundary>
  );
}
