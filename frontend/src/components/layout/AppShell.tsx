"use client";

import { useEffect, useRef, useState } from "react";
import {
  History,
  Lightbulb,
  MessageSquareText,
  Network,
  Settings2,
} from "lucide-react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";

import { SidebarHistory } from "@/components/layout/SidebarHistory";
import { ChatPanel } from "@/components/layout/ChatPanel";
import { DocumentPanel } from "@/components/layout/DocumentPanel";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import { usePDFViewerStore } from "@/stores/pdfViewerStore";

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
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const closeDrawerTimeoutRef = useRef<number | null>(null);
  const searchMode = useChatStore((state) => state.mode);
  const currentDocument = usePDFViewerStore((state) => state.currentDocument);
  const currentWebCitation = usePDFViewerStore((state) => state.currentWebCitation);
  const closeViewer = usePDFViewerStore((state) => state.close);
  const showSourcesPanel = searchMode !== "standard" && (!!currentDocument || !!currentWebCitation);

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
      <div className="relative h-screen bg-bg py-3 pl-[76px] pr-3 app-grid">
        <div className="relative h-[calc(100vh-1.5rem)] rounded-[28px] bg-panel/70 p-1 shadow-[0_20px_45px_rgba(15,23,42,0.05)]">
          <PanelGroup direction="horizontal" className="h-full min-h-0">
            <Panel defaultSize={56} minSize={40}>
              <div className="h-full min-h-0 overflow-hidden rounded-[24px] bg-panel">
                <ChatPanel />
              </div>
            </Panel>
            {showSourcesPanel ? (
              <>
                <ResizeHandle />
                <Panel defaultSize={28} minSize={20} maxSize={42}>
                  <div className="h-full min-h-0 overflow-hidden rounded-[24px] bg-panel">
                    <DocumentPanel />
                  </div>
                </Panel>
              </>
            ) : null}
          </PanelGroup>
        </div>
        <div
          className={cn(
            "absolute inset-y-3 left-3 z-30 flex max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[24px] border border-black/8 bg-panel shadow-[0_24px_50px_rgba(15,23,42,0.12)] transition-[width] duration-200 ease-out",
            historyDrawerOpen ? "w-[352px]" : "w-[56px]",
          )}
          onMouseEnter={openHistoryDrawer}
          onMouseLeave={scheduleCloseDrawer}
          onFocus={openHistoryDrawer}
        >
          <div
            className={cn(
              "flex h-full w-[56px] shrink-0 flex-col items-center px-2 py-4 transition-opacity",
              historyDrawerOpen ? "pointer-events-none absolute opacity-0" : "opacity-100",
            )}
          >
            <button
              type="button"
              className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-black text-white shadow-[0_12px_26px_rgba(15,23,42,0.16)] transition hover:scale-[1.03] focus:outline-none focus:ring-2 focus:ring-black/20"
              onClick={openHistoryDrawer}
              aria-label="Open history"
              aria-expanded={historyDrawerOpen}
              title="History"
            >
              <History className="h-5 w-5" />
            </button>
            <div className="mt-auto flex flex-col items-center gap-2">
              <button
                type="button"
                className="inline-flex h-10 w-10 items-center justify-center rounded-full text-muted transition hover:bg-black/[0.05] hover:text-ink focus:outline-none focus:ring-2 focus:ring-black/10"
                onClick={openHistoryDrawer}
                aria-label="Suggest an idea"
                title="Suggest idea"
              >
                <Lightbulb className="h-5 w-5" />
              </button>
              <button
                type="button"
                className="inline-flex h-10 w-10 items-center justify-center rounded-full text-muted transition hover:bg-black/[0.05] hover:text-ink focus:outline-none focus:ring-2 focus:ring-black/10"
                onClick={openHistoryDrawer}
                aria-label="Open settings"
                title="Settings"
              >
                <Settings2 className="h-5 w-5" />
              </button>
            </div>
          </div>

          <div
            className={cn(
              "h-full min-h-0 w-[352px] overflow-hidden transition-opacity duration-150",
              historyDrawerOpen ? "opacity-100" : "pointer-events-none opacity-0",
            )}
            onMouseEnter={cancelCloseDrawer}
          >
            <SidebarHistory onModalStateChange={setHistoryModalOpen} />
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
}
