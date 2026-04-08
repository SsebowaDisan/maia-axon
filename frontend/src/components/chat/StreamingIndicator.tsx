"use client";

import { Search, Brain, Sigma, Loader2 } from "lucide-react";

import type { StreamingStatus } from "@/lib/types";

const statusConfig: Record<Exclude<StreamingStatus, "idle" | "done">, { label: string; icon: typeof Search }> = {
  retrieving: { label: "Searching documents...", icon: Search },
  reasoning: { label: "Reasoning...", icon: Brain },
  calculating: { label: "Calculating...", icon: Sigma },
};

export function StreamingIndicator({ status }: { status: StreamingStatus }) {
  if (status === "idle" || status === "done") {
    return null;
  }

  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-accent/15 bg-accentSoft px-3 py-1 text-xs font-medium text-accent">
      <Icon className="h-3.5 w-3.5" />
      <span>{config.label}</span>
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
    </div>
  );
}
