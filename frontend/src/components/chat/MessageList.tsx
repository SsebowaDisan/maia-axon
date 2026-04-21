"use client";

import { RefObject, useCallback, useEffect, useState } from "react";

import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer";
import { api } from "@/lib/api";
import { MessageBubble } from "@/components/chat/MessageBubble";
import type { ChatMessage, WelcomePayload } from "@/lib/types";
import { useChatStore } from "@/stores/chatStore";
import { useConversationStore } from "@/stores/conversationStore";
import { useGroupStore } from "@/stores/groupStore";

const FALLBACK_WELCOME: WelcomePayload = {
  intro_markdown:
    "Welcome to the Axon Group engineering workspace.\n\nMaia AI is being developed and trained by Axon Group to support technical reasoning, document-grounded answers, calculations, and engineering analysis.\n\n### How to use Maia\n- Use `#` in the composer to choose the right group before asking document-grounded questions.\n- Use `@` after selecting a group to target one or more specific PDFs.\n- Open **Library** to upload PDFs, organize groups, and review what is available.\n- Wait until a document shows **Ready** before relying on it for grounded answers.\n- Ask clear questions such as definitions, summaries, comparisons, calculations, troubleshooting, or \"show me the supporting pages\".",
  suggested_questions: [],
};

function buildWelcomeMarkdown(introMarkdown: string) {
  return introMarkdown.trim();
}

export function MessageList({
  messages,
  scrollContainerRef,
}: {
  messages: ChatMessage[];
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}) {
  const streaming = useChatStore((state) => state.streaming);
  const chatHydrated = useChatStore((state) => state.isHydrated);
  const autoScrollNonce = useChatStore((state) => state.autoScrollNonce);
  const restoredConversationId = useConversationStore((state) => state.activeConversationId);
  const conversationHydrated = useConversationStore((state) => state.isHydrated);
  const conversationLoading = useConversationStore((state) => state.loading);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);

  useEffect(() => {
    const container = scrollContainerRef.current;
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
  }, [scrollContainerRef]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior) => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const run = () => {
      container.scrollTo({
        top: container.scrollHeight,
        behavior,
      });
    };

    run();
    window.requestAnimationFrame(() => {
      run();
      window.requestAnimationFrame(run);
    });
  }, [scrollContainerRef]);

  useEffect(() => {
    if (!isPinnedToBottom) {
      return;
    }

    if (streaming) {
      return;
    }

    scrollToBottom("smooth");
  }, [isPinnedToBottom, messages, scrollToBottom, streaming]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const scrollLatestUserMessageToTop = () => {
      const userMessages = container.querySelectorAll<HTMLElement>('[data-message-role="user"]');
      const latestUserMessage = userMessages[userMessages.length - 1];
      if (!latestUserMessage) {
        scrollToBottom("smooth");
        return;
      }
      latestUserMessage.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    };

    scrollLatestUserMessageToTop();
    window.requestAnimationFrame(() => {
      scrollLatestUserMessageToTop();
      window.requestAnimationFrame(scrollLatestUserMessageToTop);
    });
  }, [autoScrollNonce, scrollContainerRef, scrollToBottom]);

  const hasRestorableConversation = !!restoredConversationId;

  if (!messages.length && hasRestorableConversation && (!chatHydrated || !conversationHydrated || conversationLoading)) {
    return (
      <div className="mx-auto flex min-h-full w-full max-w-[980px] flex-col justify-start px-6 pb-10 pt-4">
        <div className="border-l border-black/10 pl-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted">
            Restoring conversation
          </p>
          <p className="mt-4 text-base leading-8 text-muted">
            Loading your previous chat...
          </p>
        </div>
      </div>
    );
  }

  if (!messages.length) {
    return <WelcomeCanvas />;
  }

  return (
    <div className="mx-auto flex w-full max-w-[1220px] flex-col gap-12 px-2 pb-10 pt-2 md:px-4">
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} />
      ))}
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
