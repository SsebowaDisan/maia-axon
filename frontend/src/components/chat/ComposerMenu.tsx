"use client";

import { forwardRef } from "react";
import { BarChart3, BookOpen, Bot, Building2, Globe } from "lucide-react";

import type { SearchMode } from "@/lib/types";

export const ComposerMenu = forwardRef<HTMLDivElement, {
  value: SearchMode;
  onSelect: (value: SearchMode) => void;
}>(function ComposerMenu(
  { value, onSelect },
  ref,
) {
  return (
    <div ref={ref} className="absolute bottom-full left-0 mb-3 w-52 rounded-[24px] border border-line bg-panel p-2 shadow-card">
      <button
        type="button"
        className={`flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left text-sm transition ${
          value === "standard" ? "bg-accentSoft text-accent" : "hover:bg-black/5"
        }`}
        onClick={() => onSelect("standard")}
      >
        <span className="flex items-center gap-2">
          <Bot className="h-4 w-4" />
          Standard
        </span>
        {value === "standard" ? (
          <span className="rounded-full bg-white/80 px-2 py-1 text-[11px] font-semibold">Active</span>
        ) : null}
      </button>
      <button
        type="button"
        className={`mt-1 flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left text-sm transition ${
          value === "library" ? "bg-accentSoft text-accent" : "hover:bg-black/5"
        }`}
        onClick={() => onSelect("library")}
      >
        <span className="flex items-center gap-2">
          <BookOpen className="h-4 w-4" />
          Library
        </span>
        {value === "library" ? <span className="rounded-full bg-white/80 px-2 py-1 text-[11px] font-semibold">Active</span> : null}
      </button>
      <button
        type="button"
        className={`mt-1 flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left text-sm transition ${
          value === "deep_search" ? "bg-accentSoft text-accent" : "hover:bg-black/5"
        }`}
        onClick={() => onSelect("deep_search")}
      >
        <span className="flex items-center gap-2">
          <Globe className="h-4 w-4" />
          Deep Search
        </span>
        {value === "deep_search" ? (
          <span className="rounded-full bg-white/80 px-2 py-1 text-[11px] font-semibold">Active</span>
        ) : null}
      </button>
      <div className="my-2 border-t border-black/[0.06]" />
      <button
        type="button"
        className={`flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left text-sm transition ${
          value === "google_analytics" ? "bg-accentSoft text-accent" : "hover:bg-black/5"
        }`}
        onClick={() => onSelect("google_analytics")}
      >
        <span className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4" />
          Google Analytics
        </span>
        {value === "google_analytics" ? (
          <span className="rounded-full bg-white/80 px-2 py-1 text-[11px] font-semibold">Active</span>
        ) : null}
      </button>
      <button
        type="button"
        className={`mt-1 flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left text-sm transition ${
          value === "google_ads" ? "bg-accentSoft text-accent" : "hover:bg-black/5"
        }`}
        onClick={() => onSelect("google_ads")}
      >
        <span className="flex items-center gap-2">
          <Building2 className="h-4 w-4" />
          Google Ads
        </span>
        {value === "google_ads" ? (
          <span className="rounded-full bg-white/80 px-2 py-1 text-[11px] font-semibold">Active</span>
        ) : null}
      </button>
    </div>
  );
});
