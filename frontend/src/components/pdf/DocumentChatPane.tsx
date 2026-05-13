"use client";

import { useRef } from "react";

import { MessageList } from "@/components/chat/MessageList";
import { DocumentChatComposer } from "@/components/pdf/DocumentChatComposer";
import { useChatStore } from "@/stores/chatStore";

/**
 * Chat surface that lives next to the PDF inside the preview dialog.
 *
 * Reuses {@link MessageList} (which already renders citations / pages
 * / mindmaps for assistant messages) driven by the same chatStore the
 * main-app chat uses, but isolates the conversation via
 * DocumentPreviewDialog's stash-and-restore so the user only ever
 * sees messages about this PDF here.
 *
 * The composer is the slim {@link DocumentChatComposer}, not the full
 * main-app one — it strips Standard / Google / Deep-Search modes and
 * the #group / @document selectors so the 420px chat column doesn't
 * spend two thirds of its height on chrome.
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
      <div className="sticky bottom-0 border-t border-black/[0.05] bg-panel px-2.5 pb-2 pt-2">
        <DocumentChatComposer />
      </div>
    </div>
  );
}
