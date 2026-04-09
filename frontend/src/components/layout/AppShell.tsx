"use client";

import { useEffect, useState } from "react";
import {
  History,
  MessageSquareText,
  Network,
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

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

  const panels = {
    history: <SidebarHistory />,
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
      <div className="h-screen bg-bg px-3 py-3 app-grid">
        <div className="h-[calc(100vh-1.5rem)] rounded-[28px] bg-panel/70 p-1 shadow-[0_20px_45px_rgba(15,23,42,0.05)]">
          <PanelGroup direction="horizontal" className="h-full min-h-0">
            <Panel defaultSize={20} minSize={17} maxSize={28}>
              <div className="h-full min-h-0 overflow-hidden rounded-[24px] bg-panel">
                <SidebarHistory />
              </div>
            </Panel>
            <ResizeHandle />
            <Panel defaultSize={56} minSize={40}>
              <div className="h-full min-h-0 overflow-hidden rounded-[24px] bg-panel">
                <ChatPanel />
              </div>
            </Panel>
            {showSourcesPanel ? (
              <>
                <ResizeHandle />
                <Panel defaultSize={24} minSize={20} maxSize={32}>
                  <div className="h-full min-h-0 overflow-hidden rounded-[24px] bg-panel">
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
