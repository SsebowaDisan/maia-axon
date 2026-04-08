"use client";

import { useMemo } from "react";
import { Folder, SearchCode } from "lucide-react";

import { Composer } from "@/components/chat/Composer";
import { MessageList } from "@/components/chat/MessageList";
import { useChatStore } from "@/stores/chatStore";
import { useGroupStore } from "@/stores/groupStore";

export function ChatPanel() {
  const messages = useChatStore((state) => state.messages);
  const activeGroupId = useGroupStore((state) => state.activeGroupId);
  const groups = useGroupStore((state) => state.groups);

  const activeGroup = useMemo(
    () => groups.find((group) => group.id === activeGroupId) ?? null,
    [activeGroupId, groups],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden px-2 py-2">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 px-2">
        <div>
          <p className="font-display text-[2rem] leading-none text-ink">Current Chat</p>
          <p className="mt-2 text-sm text-muted">
            {activeGroup ? `Working inside ${activeGroup.name}` : "Choose a group to start querying your library."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-white/65 px-3 py-2 text-xs font-medium text-muted">
            <Folder className="h-3.5 w-3.5" />
            {activeGroup?.name ?? "No active group"}
          </span>
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-white/65 px-3 py-2 text-xs font-medium text-muted">
            <SearchCode className="h-3.5 w-3.5" />
            PDF-grounded reasoning
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6 scrollbar-thin">
        <MessageList messages={messages} />
      </div>
      <div className="pt-4">
        <Composer />
      </div>
    </div>
  );
}
