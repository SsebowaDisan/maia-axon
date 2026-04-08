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

function ResizeHandle() {
  return (
    <PanelResizeHandle className="group relative mx-1 w-1.5 rounded-full bg-transparent">
      <div className="absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 rounded-full bg-line transition group-hover:bg-accent" />
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

  const panels = {
    history: <SidebarHistory />,
    chat: <ChatPanel />,
    sources: <DocumentPanel />,
  };

  if (mode !== "desktop") {
    return (
      <ErrorBoundary>
        <div className="flex h-screen flex-col gap-4 p-4">
          <div className="grid grid-cols-3 gap-2 rounded-[28px] border border-line bg-panel/90 p-2 shadow-card">
            {[
              { key: "history", label: "History", icon: History },
              { key: "chat", label: "Chat", icon: MessageSquareText },
              { key: "sources", label: "Sources", icon: Network },
            ].map((tab) => {
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
          <div className="min-h-0 flex-1 rounded-[32px] border border-line bg-panel/70 p-2 shadow-panel">
            {panels[mobileTab]}
          </div>
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <div className="h-screen p-4 app-grid">
        <div className="mb-4 flex items-center justify-between rounded-[30px] border border-line bg-panel/88 px-6 py-4 shadow-card">
          <div>
            <p className="font-display text-[2.25rem] leading-none text-ink">Maia Axon</p>
            <p className="mt-2 text-sm text-muted">
              Multimodal engineering reasoning with citations, calculations, and source inspection.
            </p>
          </div>
          <div className="hidden items-center gap-2 md:flex">
            <span className="rounded-full border border-line px-3 py-2 text-xs text-muted"># groups</span>
            <span className="rounded-full border border-line px-3 py-2 text-xs text-muted">@ documents</span>
            <span className="rounded-full border border-line px-3 py-2 text-xs text-muted">3-panel workspace</span>
          </div>
        </div>

        <div className="h-[calc(100vh-7.5rem)] rounded-[34px] border border-line bg-panel/55 p-2 shadow-panel">
          <PanelGroup direction="horizontal" autoSaveId="maia-axon-panels">
            <Panel defaultSize={22} minSize={18} maxSize={32}>
              <div className="h-full rounded-[30px] border border-line bg-panel/90">
                <SidebarHistory />
              </div>
            </Panel>
            <ResizeHandle />
            <Panel minSize={35}>
              <div className="h-full rounded-[30px] border border-line bg-panel/85">
                <ChatPanel />
              </div>
            </Panel>
            <ResizeHandle />
            <Panel defaultSize={28} minSize={22} maxSize={38}>
              <div className="h-full rounded-[30px] border border-line bg-panel/90">
                <DocumentPanel />
              </div>
            </Panel>
          </PanelGroup>
        </div>
      </div>
    </ErrorBoundary>
  );
}
