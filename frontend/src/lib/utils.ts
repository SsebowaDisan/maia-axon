import {
  formatDistanceToNowStrict,
  isToday,
  isYesterday,
  subDays,
} from "date-fns";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

import type { ChatMessage, Citation, ConversationSummary, DocumentStatusValue } from "@/lib/types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatRelativeTime(value: string) {
  return formatDistanceToNowStrict(new Date(value), { addSuffix: true });
}

export function bucketConversations(conversations: ConversationSummary[]) {
  const now = new Date();
  const last7 = subDays(now, 7);
  const last30 = subDays(now, 30);

  return conversations.reduce<Record<string, ConversationSummary[]>>((acc, conversation) => {
    const date = new Date(conversation.updated_at);
    const key = isToday(date)
      ? "Today"
      : isYesterday(date)
        ? "Yesterday"
        : date > last7
          ? "Last 7 Days"
          : date > last30
            ? "Last 30 Days"
            : "Older";

    acc[key] ??= [];
    acc[key].push(conversation);
    return acc;
  }, {});
}

export function formatBytes(bytes?: number | null) {
  if (!bytes) {
    return "Unknown size";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function statusLabel(status: DocumentStatusValue) {
  switch (status) {
    case "uploading":
      return "Uploading";
    case "splitting":
      return "Splitting pages";
    case "glm_ocr":
      return "Analyzing (GLM-OCR)";
    case "captioning":
      return "Processing figures";
    case "embedding":
      return "Generating embeddings";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

export function transformCitationLinks(content: string, citations: Citation[]) {
  return content.replace(/\[Source (\d+)\]/g, (_match, rawNumber: string) => {
    const index = Number(rawNumber) - 1;
    const citation = citations[index];
    if (!citation) {
      return `[Source ${rawNumber}]`;
    }
    return `[Source ${rawNumber}](citation:${citation.id})`;
  });
}

export function inferClarification(message: ChatMessage) {
  return message.citations.length === 0 && /\?$/.test(message.content.trim());
}

export function extractCalculationLines(content: string) {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const signals = ["formula", "variables", "substitut", "result", "calculation"];
  const relevant = lines.filter((line) =>
    signals.some((signal) => line.toLowerCase().includes(signal)),
  );

  return relevant.length >= 2 ? relevant : [];
}

export function citationById(citations: Citation[]) {
  return citations.reduce<Record<string, Citation>>((acc, citation) => {
    acc[citation.id] = citation;
    return acc;
  }, {});
}

export function titleFromMessage(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 80) || "Untitled conversation";
}
