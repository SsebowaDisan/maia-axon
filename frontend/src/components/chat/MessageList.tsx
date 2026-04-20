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

const ONBOARDING_MARKDOWN = [
  "### How to use Maia",
  "- Type `#` in the composer to choose a group or document workspace.",
  "- Type `@` after selecting a group to target one or more specific PDFs.",
  "- Open **Library**, choose the correct group, and use **Upload PDFs** to add new files.",
  "- Wait until a document shows **Ready** in the Library before asking grounded questions about it.",
  "- Ask in plain language. Maia will use the selected group documents and cite pages when available.",
].join("\n");

function buildWelcomeMarkdown(introMarkdown: string) {
  return `${introMarkdown.trim()}\n\n${ONBOARDING_MARKDOWN}`;
}

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const streaming = useChatStore((state) => state.streaming);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const handleScroll = () => {
      const nearBottom =
        container.scrollTop + container.clientHeight >= container.scrollHeight - 72;
      setIsPinnedToBottom(nearBottom);
    };

    handleScroll();
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, []);

  useEffect(() => {
    if (!isPinnedToBottom) {
      return;
    }

    const container = containerRef.current;
    if (!container) {
      return;
    }

    container.scrollTo({
      top: container.scrollHeight,
      behavior: streaming ? "auto" : "smooth",
    });
  }, [isPinnedToBottom, messages, streaming]);

  if (!messages.length) {
    return <WelcomeCanvas />;
  }

  return (
    <div ref={containerRef} className="mx-auto flex w-full max-w-[1220px] flex-col gap-12 overflow-y-auto px-2 pb-10 pt-2 md:px-4">
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
  const setWelcomeStreaming = useChatStore((state) => state.setWelcomeStreaming);
  const [welcome, setWelcome] = useState<WelcomePayload>(FALLBACK_WELCOME);
  const [loading, setLoading] = useState(true);
  const [displayedMarkdown, setDisplayedMarkdown] = useState("");

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    async function loadWelcome() {
      setLoading(true);
      setDisplayedMarkdown("");
      setWelcomeStreaming(true);
      try {
        const payload = await api.getWelcome(activeGroupId);
        if (!cancelled) {
          setWelcome(payload);
          const fullMarkdown = buildWelcomeMarkdown(payload.intro_markdown);
          let index = 0;
          const typeNext = () => {
            if (cancelled) {
              return;
            }
            index += 3;
            setDisplayedMarkdown(fullMarkdown.slice(0, index));
            if (index < fullMarkdown.length) {
              timer = window.setTimeout(typeNext, 12);
              return;
            }
            setWelcomeStreaming(false);
          };
          typeNext();
        }
      } catch {
        if (!cancelled) {
          setWelcome(FALLBACK_WELCOME);
          const fullMarkdown = buildWelcomeMarkdown(FALLBACK_WELCOME.intro_markdown);
          let index = 0;
          const typeNext = () => {
            if (cancelled) {
              return;
            }
            index += 3;
            setDisplayedMarkdown(fullMarkdown.slice(0, index));
            if (index < fullMarkdown.length) {
              timer = window.setTimeout(typeNext, 12);
              return;
            }
            setWelcomeStreaming(false);
          };
          typeNext();
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
      setWelcomeStreaming(false);
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [activeGroupId, setWelcomeStreaming]);

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
            <MarkdownRenderer content={displayedMarkdown || buildWelcomeMarkdown(welcome.intro_markdown)} citations={[]} />
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
