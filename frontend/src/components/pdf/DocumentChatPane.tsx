"use client";

import { useRef } from "react";

import { Composer } from "@/components/chat/Composer";
import { MessageList } from "@/components/chat/MessageList";
import { useChatStore } from "@/stores/chatStore";

/**
 * Slim chat surface that lives next to the PDF inside the preview
 * dialog. Reuses the same MessageList + Composer the main app uses,
 * driven by the same chatStore — so the conversation persists when
 * the user closes the preview and goes back to the regular chat
 * panel.
 *
 * Differences from {@link ChatPanel}:
 * * No big "Chat" header — the dialog already shows the doc name.
 * * Narrower column max-width — the dialog's right pane is ~420px
 *   wide, so we drop the 1120px content cap.
 * * Tighter padding so the composer doesn't eat half the vertical
 *   real estate.
 */
export function DocumentChatPane() {
  const messages = useChatStore((state) => state.messages);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr),auto] overflow-hidden">
      <div
        ref={scrollContainerRef}
        className="min-h-0 overflow-y-auto px-3 pb-2 pt-3 scrollbar-thin"
      >
        <MessageList messages={messages} scrollContainerRef={scrollContainerRef} />
      </div>
      <div className="sticky bottom-0 border-t border-black/[0.05] bg-panel px-3 pb-2 pt-2">
        <Composer />
      </div>
    </div>
  );
}
