"use client";

import { useEffect, useRef, useState } from "react";

import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer";
import { api } from "@/lib/api";
import { MessageBubble } from "@/components/chat/MessageBubble";
import type { ChatMessage, WelcomePayload } from "@/lib/types";
import { useChatStore } from "@/stores/chatStore";
import { useGroupStore } from "@/stores/groupStore";

const FALLBACK_WELCOME: WelcomePayload = {
  intro_markdown:
    "Hi colleague,\n\nMy name is **Maia AI**. I am an Axon Group AI assistant currently under development and being trained by Axon Group to support technical reasoning, document-grounded answers, calculations, and engineering analysis.\n\nI can assist you with the technical books currently available in your workspace, as well as broader engineering and technical questions when needed.",
  suggested_questions: [],
};

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  if (!messages.length) {
    return <WelcomeCanvas />;
  }

  return (
    <div className="mx-auto flex w-full max-w-[1220px] flex-col gap-12 px-2 pb-10 pt-2 md:px-4">
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

function WelcomeCanvas() {
  const activeGroupId = useGroupStore((state) => state.activeGroupId);
  const setDraft = useChatStore((state) => state.setDraft);
  const setDraftMode = useChatStore((state) => state.setDraftMode);
  const [welcome, setWelcome] = useState<WelcomePayload>(FALLBACK_WELCOME);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadWelcome() {
      setLoading(true);
      try {
        const payload = await api.getWelcome(activeGroupId);
        if (!cancelled) {
          setWelcome(payload);
        }
      } catch {
        if (!cancelled) {
          setWelcome(FALLBACK_WELCOME);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadWelcome();

    return () => {
      cancelled = true;
    };
  }, [activeGroupId]);

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[980px] flex-col justify-start px-6 pb-10 pt-4">
      <div className="border-l border-black/10 pl-8">
        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted">
          Document-grounded chat
        </p>
        <p className="mt-3 font-display text-[2.15rem] font-semibold tracking-[-0.05em] text-ink">
          Maia AI
        </p>
        <div className="mt-6 max-w-[820px]">
          {loading ? (
            <p className="text-base leading-8 text-muted">Preparing your workspace briefing...</p>
          ) : (
            <MarkdownRenderer content={welcome.intro_markdown} citations={[]} />
          )}
        </div>
        {!!welcome.suggested_questions.length && (
          <div className="mt-8">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted">
              Suggested Questions
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              {welcome.suggested_questions.map((question) => (
                <button
                  key={question}
                  type="button"
                  onClick={() => {
                    setDraftMode("compose");
                    setDraft(question);
                  }}
                  className="rounded-full border border-black/10 bg-white px-4 py-2 text-left text-[14px] text-ink transition hover:border-black hover:bg-black hover:text-white"
                >
                  {question}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
