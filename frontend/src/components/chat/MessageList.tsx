"use client";

import { useEffect, useRef } from "react";

import { MessageBubble } from "@/components/chat/MessageBubble";
import type { ChatMessage } from "@/lib/types";

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  if (!messages.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 text-center">
        <div className="max-w-lg rounded-[32px] border border-line bg-panel/85 p-10 shadow-card">
          <p className="font-display text-3xl text-ink">Ask Maia Axon from a document group.</p>
          <p className="mt-4 text-sm leading-7 text-muted">
            Select a group with <code>#</code>, optionally narrow documents with <code>@</code>,
            then ask for a grounded answer or a step-by-step calculation.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
