"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  Check,
  ChevronDown,
  Copy,
  GripHorizontal,
  Languages,
  X,
} from "lucide-react";

import { api } from "@/lib/api";

interface TranslatePopoverProps {
  sourceText: string;
  anchorLeft: number;
  anchorTop: number;
  onClose: () => void;
}

const LANGUAGES: { code: string; label: string }[] = [
  { code: "English", label: "English" },
  { code: "Spanish", label: "Spanish" },
  { code: "French", label: "French" },
  { code: "German", label: "German" },
  { code: "Dutch", label: "Dutch" },
  { code: "Italian", label: "Italian" },
  { code: "Portuguese", label: "Portuguese" },
  { code: "Polish", label: "Polish" },
  { code: "Russian", label: "Russian" },
  { code: "Turkish", label: "Turkish" },
  { code: "Arabic", label: "Arabic" },
  { code: "Chinese (Simplified)", label: "Chinese (Simplified)" },
  { code: "Japanese", label: "Japanese" },
  { code: "Korean", label: "Korean" },
  { code: "Hindi", label: "Hindi" },
  { code: "Swahili", label: "Swahili" },
];

const LS_LANG_KEY = "maia-translate-target";

function loadTarget(): string {
  if (typeof window === "undefined") return "English";
  const saved = window.localStorage.getItem(LS_LANG_KEY);
  if (saved && LANGUAGES.some((l) => l.code === saved)) return saved;
  const browser = window.navigator?.language?.split("-")[0]?.toLowerCase() ?? "en";
  return (
    LANGUAGES.find((l) => l.code.toLowerCase().startsWith(browser))?.code ?? "English"
  );
}

export function TranslatePopover({ sourceText, anchorLeft, anchorTop, onClose }: TranslatePopoverProps) {
  const [target, setTarget] = useState<string>(loadTarget);
  const [translated, setTranslated] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [compact, setCompact] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const langDropdownRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerX: number;
    pointerY: number;
    startLeft: number;
    startTop: number;
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LS_LANG_KEY, target);
    }
  }, [target]);

  // Auto-translate on mount + whenever target changes. User came here
  // already knowing what they want — no extra "Translate" click.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setTranslated(null);
    setCopied(false);
    (async () => {
      try {
        const response = await api.translateText(sourceText, target);
        if (!cancelled) setTranslated(response.translated_text);
      } catch (exc) {
        if (!cancelled) {
          setError(exc instanceof Error ? exc.message : "Translation failed");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceText, target]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    const el = popoverRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setCompact(el.clientWidth < 340);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Close the custom language dropdown on outside click.
  useEffect(() => {
    if (!langOpen) return;
    const handler = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return;
      if (langDropdownRef.current?.contains(event.target)) return;
      setLangOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [langOpen]);

  const startDrag = (event: React.MouseEvent) => {
    event.preventDefault();
    const popover = popoverRef.current;
    if (!popover) return;
    const rect = popover.getBoundingClientRect();
    dragRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      width: rect.width,
      height: rect.height,
    };
    popover.style.left = `${rect.left}px`;
    popover.style.top = `${rect.top}px`;
    popover.style.cursor = "grabbing";
    popover.style.userSelect = "none";

    const handleMove = (moveEvent: MouseEvent) => {
      const origin = dragRef.current;
      if (!origin) return;
      const MARGIN = 8;
      const maxLeft = window.innerWidth - origin.width - MARGIN;
      const maxTop = window.innerHeight - origin.height - MARGIN;
      const dx = moveEvent.clientX - origin.pointerX;
      const dy = moveEvent.clientY - origin.pointerY;
      const nextLeft = Math.max(MARGIN, Math.min(origin.startLeft + dx, maxLeft));
      const nextTop = Math.max(MARGIN, Math.min(origin.startTop + dy, maxTop));
      popover.style.left = `${nextLeft}px`;
      popover.style.top = `${nextTop}px`;
    };

    const handleUp = () => {
      const finalLeft = parseFloat(popover.style.left);
      const finalTop = parseFloat(popover.style.top);
      dragRef.current = null;
      popover.style.cursor = "";
      popover.style.userSelect = "";
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      if (!Number.isNaN(finalLeft) && !Number.isNaN(finalTop)) {
        setPosition({ left: finalLeft, top: finalTop });
      }
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  };

  const handleCopy = async () => {
    if (!translated) return;
    try {
      await navigator.clipboard.writeText(translated);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Fallback: select the text so the user can hit Ctrl+C themselves.
      const target = popoverRef.current?.querySelector("[data-translated]");
      const selection = window.getSelection();
      if (target && selection) {
        const range = document.createRange();
        range.selectNodeContents(target);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  };

  const effectiveLeft = position?.left ?? anchorLeft;
  const effectiveTop = position?.top ?? anchorTop;

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      ref={popoverRef}
      className="maia-popover-in pointer-events-auto fixed z-[125] flex flex-col overflow-hidden rounded-2xl border border-black/[0.08] bg-panel shadow-[0_18px_48px_rgba(15,23,42,0.18)]"
      style={{
        left: effectiveLeft,
        top: effectiveTop,
        width: 380,
        // Resizable in both directions. The source quote acts as the
        // flexible region, so extra height grows the visible source
        // area rather than leaving white space.
        resize: "both",
        minWidth: 280,
        minHeight: 320,
        maxWidth: "min(calc(100vw - 24px), 720px)",
        maxHeight: "calc(100vh - 48px)",
      }}
    >
      {/* Drag handle */}
      <div
        onMouseDown={startDrag}
        className="flex cursor-grab items-center justify-center border-b border-black/[0.04] py-1.5 text-muted/60 transition hover:text-ink active:cursor-grabbing"
        title="Drag to move"
      >
        <GripHorizontal className="h-4 w-4" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-3.5">
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.18em] text-ink">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-black text-white">
              <Languages className="h-3.5 w-3.5" />
            </span>
            {!compact ? "Translate" : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted transition hover:bg-black/[0.05] hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Source */}
        <div className="mt-3.5 flex min-h-0 flex-1 flex-col">
          <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted/80">
            From selection
          </p>
          <blockquote
            className="mt-1.5 min-h-[60px] flex-1 overflow-y-auto rounded-md bg-black/[0.03] py-2 pl-3 pr-2.5 font-serif text-[12.5px] italic leading-5 text-ink/85 scrollbar-thin"
            style={{ borderLeft: "3px solid rgba(15, 23, 42, 0.16)" }}
          >
            &ldquo;{sourceText}&rdquo;
          </blockquote>
        </div>

        {/* Direction marker */}
        <div className="mt-3 flex items-center justify-center">
          <div className="flex h-7 w-7 items-center justify-center rounded-full border border-black/[0.08] bg-white text-muted">
            <ArrowDown className="h-3.5 w-3.5" />
          </div>
        </div>

        {/* Target language picker — custom dropdown so the hover/
            selected highlight is brand-black instead of OS blue. */}
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted/80">
            Into
          </p>
          <div ref={langDropdownRef} className="relative min-w-0 flex-1">
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={langOpen}
              onClick={() => setLangOpen((value) => !value)}
              className="flex w-full items-center justify-between gap-2 rounded-md border border-black/[0.12] bg-white px-2 py-1 text-left text-[12.5px] font-medium text-ink outline-none transition hover:border-black/[0.24] focus:border-ink/40"
            >
              <span className="truncate">{target}</span>
              <ChevronDown
                className={`h-3.5 w-3.5 shrink-0 text-muted transition ${
                  langOpen ? "rotate-180" : ""
                }`}
              />
            </button>
            {langOpen ? (
              <ul
                role="listbox"
                className="absolute left-0 right-0 top-full z-10 mt-1 max-h-[240px] overflow-y-auto rounded-md border border-black/[0.10] bg-white py-1 shadow-[0_12px_28px_rgba(15,23,42,0.14)] scrollbar-thin"
              >
                {LANGUAGES.map((lang) => {
                  const selected = lang.code === target;
                  return (
                    <li key={lang.code} role="option" aria-selected={selected}>
                      <button
                        type="button"
                        onClick={() => {
                          setTarget(lang.code);
                          setLangOpen(false);
                        }}
                        className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[12.5px] transition ${
                          selected
                            ? "bg-black text-white"
                            : "text-ink hover:bg-black hover:text-white"
                        }`}
                      >
                        {lang.label}
                        {selected ? <Check className="h-3.5 w-3.5" /> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        </div>

        {/* Translation result */}
        <div className="group relative mt-3 min-h-[88px] rounded-xl border border-black/[0.08] bg-[rgb(250,250,251)] p-3 text-[13px] leading-6 text-ink">
          {loading ? (
            // Skeleton lines instead of a spinner — feels closer to
            // "content arriving" than "we're hanging."
            <div className="space-y-2" aria-hidden="true">
              <div className="h-3 w-[90%] animate-pulse rounded bg-black/[0.06]" />
              <div className="h-3 w-[80%] animate-pulse rounded bg-black/[0.06]" />
              <div className="h-3 w-[55%] animate-pulse rounded bg-black/[0.06]" />
            </div>
          ) : error ? (
            <p className="text-[12px] text-warn">{error}</p>
          ) : translated ? (
            <>
              <p data-translated className="whitespace-pre-wrap pr-10">
                {translated}
              </p>
              <button
                type="button"
                onClick={handleCopy}
                title={copied ? "Copied" : "Copy translation"}
                aria-label="Copy translation"
                className={`absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full border border-black/[0.10] bg-white shadow-sm transition hover:bg-black hover:text-white ${
                  copied ? "border-emerald-300 text-emerald-600" : "text-muted opacity-0 group-hover:opacity-100 focus:opacity-100"
                }`}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </>
          ) : (
            <p className="text-[12px] italic text-muted">No translation yet.</p>
          )}
        </div>

        <p className="mt-2.5 text-[10px] leading-4 text-muted/70">
          Translations are shown only to you and are not saved.
        </p>
      </div>
    </div>,
    document.body,
  );
}
