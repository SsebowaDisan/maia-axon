"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, GraduationCap, Loader2, Target, X } from "lucide-react";

import { api } from "@/lib/api";
import type { LearnDepth, LearnPath, LearnPathStep } from "@/lib/types";

import { CheckInPanel } from "./CheckInPanel";

interface LearnDialogProps {
  documentId: string;
  documentName: string;
  open: boolean;
  onClose: () => void;
  onJumpToPage?: (page: number) => void;
}

const DEPTH_OPTIONS: { value: LearnDepth; label: string; detail: string }[] = [
  { value: "quick", label: "Quick", detail: "≤6 sections — the essentials" },
  { value: "normal", label: "Normal", detail: "≤12 sections — solid coverage" },
  { value: "deep", label: "Deep", detail: "≤24 sections — full prerequisite chain" },
];

function StepRow({
  step,
  isCurrent,
  onLearn,
  onCheckIn,
  onSkip,
}: {
  step: LearnPathStep;
  isCurrent: boolean;
  onLearn: () => void;
  onCheckIn: () => void;
  onSkip: () => void;
}) {
  const done = step.status === "completed";
  const skipped = step.status === "skipped";
  return (
    <div
      className={`rounded-2xl border px-4 py-3 transition ${
        isCurrent
          ? "border-accent bg-accentSoft"
          : done || skipped
            ? "border-black/10 bg-black/[0.03] opacity-70"
            : "border-black/10 bg-white/60"
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
            done
              ? "bg-emerald-500 text-white"
              : skipped
                ? "bg-black/15 text-black/60"
                : isCurrent
                  ? "bg-accent text-white"
                  : "bg-black/[0.08] text-black/60"
          }`}
        >
          {done ? <Check className="h-3.5 w-3.5" /> : null}
          {skipped ? "·" : null}
          {!done && !skipped ? (
            <span>{step.is_target ? "★" : "→"}</span>
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{step.title}</h3>
            <span className="shrink-0 text-[11px] text-black/55">
              p. {step.page_start}–{step.page_end}
            </span>
            {step.is_target ? (
              <span className="rounded-full bg-accent/15 px-2 py-[1px] text-[10px] font-medium text-accent">
                target
              </span>
            ) : null}
            {step.is_prereq ? (
              <span className="rounded-full bg-black/[0.06] px-2 py-[1px] text-[10px] font-medium text-black/60">
                prereq
              </span>
            ) : null}
          </div>
          {step.rationale ? (
            <p className="mt-1 text-[12px] leading-relaxed text-black/60">{step.rationale}</p>
          ) : null}
          {isCurrent && !done && !skipped ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onLearn}
                className="rounded-full bg-[#2a2522] px-3 py-[6px] text-[12px] font-medium text-white hover:bg-[#3a3530]"
              >
                Read this section
              </button>
              <button
                type="button"
                onClick={onCheckIn}
                className="rounded-full bg-accent px-3 py-[6px] text-[12px] font-medium text-white hover:bg-accent/90"
              >
                Start check-in
              </button>
              <button
                type="button"
                onClick={onSkip}
                className="rounded-full px-3 py-[6px] text-[12px] font-medium text-black/55 hover:text-black/80"
              >
                Skip
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DiagnosticForm({
  documentName,
  onStart,
  starting,
  error,
}: {
  documentName: string;
  onStart: (goal: string, depth: LearnDepth) => void;
  starting: boolean;
  error: string | null;
}) {
  const [goal, setGoal] = useState("");
  const [depth, setDepth] = useState<LearnDepth>("normal");

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Target className="h-4 w-4 text-accent" />
          What do you want to learn from {documentName}?
        </div>
        <p className="mt-1 text-[12.5px] text-black/55">
          Be specific — &quot;I want to design a fan system for a 12 kW
          server room&quot; produces a better path than &quot;fans&quot;.
        </p>
        <textarea
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          rows={3}
          className="mt-2 w-full resize-none rounded-2xl border border-black/10 bg-white px-3 py-2 text-sm focus:border-accent focus:outline-none"
          placeholder="Type your learning goal…"
        />
      </div>
      <div>
        <div className="text-sm font-semibold">How deep do you want to go?</div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {DEPTH_OPTIONS.map((option) => {
            const active = option.value === depth;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setDepth(option.value)}
                className={`rounded-2xl border px-3 py-2 text-left transition ${
                  active
                    ? "border-accent bg-accentSoft"
                    : "border-black/10 bg-white hover:border-black/20"
                }`}
              >
                <div className="text-sm font-semibold">{option.label}</div>
                <div className="mt-1 text-[11px] text-black/55">{option.detail}</div>
              </button>
            );
          })}
        </div>
      </div>
      {error ? (
        <div className="rounded-xl bg-warn/10 px-3 py-2 text-[12px] text-warn">{error}</div>
      ) : null}
      <button
        type="button"
        disabled={goal.trim().length < 4 || starting}
        onClick={() => onStart(goal.trim(), depth)}
        className="flex w-full items-center justify-center gap-2 rounded-full bg-[#2a2522] px-4 py-2.5 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50 hover:bg-[#3a3530]"
      >
        {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <GraduationCap className="h-4 w-4" />}
        Generate my learning path
      </button>
    </div>
  );
}

export function LearnDialog({
  documentId,
  documentName,
  open,
  onClose,
  onJumpToPage,
}: LearnDialogProps) {
  const [path, setPath] = useState<LearnPath | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkInSectionId, setCheckInSectionId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getActiveLearningPath(documentId)
      .then((data) => {
        if (cancelled) return;
        setPath(data);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        // 404 means no active path — that's a normal state; show diagnostic.
        if (err.message.toLowerCase().includes("no active path")) {
          setPath(null);
        } else {
          setError(err.message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [documentId, open]);

  const handleStart = async (goal: string, depth: LearnDepth) => {
    setStarting(true);
    setError(null);
    try {
      const newPath = await api.startLearningPath({
        document_id: documentId,
        goal_text: goal,
        depth,
      });
      setPath(newPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start path";
      setError(message);
    } finally {
      setStarting(false);
    }
  };

  const currentStep = useMemo(() => {
    if (!path) return null;
    if (path.current_step >= path.plan.length) return null;
    return path.plan[path.current_step];
  }, [path]);

  const handleAdvance = async (skip: boolean) => {
    if (!path) return;
    try {
      const next = await api.advanceLearningPath(path.id, { skip });
      setPath(next);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to advance";
      setError(message);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-[28px] bg-panel shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-black/[0.06] px-5 py-3">
          <div className="flex items-center gap-2">
            <GraduationCap className="h-5 w-5 text-accent" />
            <h2 className="text-sm font-semibold">Learn mode — {documentName}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-black/55 hover:bg-black/[0.05] hover:text-black"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5 scrollbar-thin">
          {checkInSectionId && path ? (
            <CheckInPanel
              sectionId={checkInSectionId}
              pathId={path.id}
              onClose={() => setCheckInSectionId(null)}
              onSectionCompleted={async () => {
                setCheckInSectionId(null);
                await handleAdvance(false);
              }}
            />
          ) : loading ? (
            <div className="flex items-center gap-2 text-sm text-black/55">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading your path…
            </div>
          ) : path && path.plan.length > 0 ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-[12px] uppercase tracking-[0.18em] text-black/45">
                  Path · {path.depth} · {path.status}
                </div>
                <div className="text-[12px] text-black/45">
                  Step {Math.min(path.current_step + 1, path.plan.length)} of {path.plan.length}
                </div>
              </div>
              <div className="rounded-2xl border border-black/[0.06] bg-white/55 px-3 py-2">
                <div className="text-[11px] uppercase tracking-[0.18em] text-black/40">Goal</div>
                <div className="mt-0.5 text-[13.5px] text-black/80">{path.goal_text}</div>
              </div>
              <div className="space-y-2">
                {path.plan.map((step, idx) => (
                  <StepRow
                    key={step.section_id}
                    step={step}
                    isCurrent={idx === path.current_step && path.status === "active"}
                    onLearn={() => {
                      onJumpToPage?.(step.page_start);
                      onClose();
                    }}
                    onCheckIn={() => setCheckInSectionId(step.section_id)}
                    onSkip={() => void handleAdvance(true)}
                  />
                ))}
              </div>
              {error ? (
                <div className="rounded-xl bg-warn/10 px-3 py-2 text-[12px] text-warn">{error}</div>
              ) : null}
              <button
                type="button"
                onClick={() => setPath(null)}
                className="w-full rounded-full border border-black/10 px-4 py-2 text-[12px] text-black/60 hover:bg-black/[0.04]"
              >
                Start a new path instead
              </button>
            </div>
          ) : path && path.plan.length === 0 ? (
            <div className="text-sm text-black/65">
              Your path returned no sections — looks like you already know everything
              the goal requires.
              <button
                type="button"
                className="ml-2 text-accent hover:underline"
                onClick={() => setPath(null)}
              >
                Start a different goal
              </button>
            </div>
          ) : (
            <DiagnosticForm
              documentName={documentName}
              onStart={handleStart}
              starting={starting}
              error={error}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// Re-export the current step type for the page-jump action so the
// PDF viewer can render an inline "current section" indicator.
export type { LearnPathStep };

// Convenience hook: returns the active path's current step or null.
export function _internal_currentStep(path: LearnPath | null) {
  if (!path) return null;
  if (path.current_step >= path.plan.length) return null;
  return path.plan[path.current_step];
}
