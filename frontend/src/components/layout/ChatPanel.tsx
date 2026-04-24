"use client";

import { useRef } from "react";

import { Composer } from "@/components/chat/Composer";
import { MessageList } from "@/components/chat/MessageList";
import { useChatStore } from "@/stores/chatStore";

export function ChatPanel() {
  const messages = useChatStore((state) => state.messages);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto,minmax(0,1fr),auto] overflow-hidden px-3 py-3">
      <div className="mx-auto mb-3 w-full max-w-[1480px] px-2 py-1">
        <p className="font-display text-[1.7rem] font-semibold tracking-[-0.05em] text-ink">Chat</p>
      </div>
      <div ref={scrollContainerRef} className="min-h-0 overflow-y-auto pb-2 scrollbar-thin">
        <MessageList messages={messages} scrollContainerRef={scrollContainerRef} />
      </div>
      <div className="sticky bottom-0 bg-panel pt-2">
        <div className="mx-auto w-full max-w-[1480px] px-2">
          <Composer />
        </div>
      </div>
    </div>
  );
}
