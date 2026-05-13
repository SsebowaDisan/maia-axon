"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Loader2, X } from "lucide-react";

import { api } from "@/lib/api";
import type {
  CheckInQuestion,
  CheckInResult,
  MasteryUpdate,
} from "@/lib/types";

interface CheckInPanelProps {
  sectionId: string;
  pathId: string;
  onClose: () => void;
  onSectionCompleted: () => void;
}

interface QuestionState {
  result: CheckInResult | null;
  userAnswer: string;
  submitting: boolean;
  error: string | null;
}

function emptyState(): QuestionState {
  return { result: null, userAnswer: "", submitting: false, error: null };
}

function MasteryDeltaBadge({ delta }: { delta: MasteryUpdate }) {
  const diff = delta.new_score - delta.previous_score;
  const positive = diff >= 0;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-[1px] text-[10.5px] ${
        positive ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
      }`}
    >
      {positive ? "+" : ""}
      {(diff * 100).toFixed(0)}%
      {delta.became_known ? " · now known" : null}
      {delta.became_unknown ? " · slipped" : null}
    </span>
  );
}

function MCQInput({
  question,
  value,
  onChange,
  disabled,
}: {
  question: CheckInQuestion;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const choices = (question.payload.choices as { label: string; text: string }[] | undefined) ?? [];
  return (
    <div className="space-y-2">
      {choices.map((choice) => {
        const active = value === choice.label;
        return (
          <button
            key={choice.label}
            type="button"
            disabled={disabled}
            onClick={() => onChange(choice.label)}
            className={`flex w-full items-start gap-3 rounded-2xl border px-3 py-2 text-left text-sm transition disabled:cursor-not-allowed ${
              active
                ? "border-accent bg-accentSoft"
                : "border-black/10 bg-white hover:border-black/20"
            }`}
          >
            <span
              className={`mt-[2px] flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                active ? "bg-accent text-white" : "bg-black/[0.06] text-black/60"
              }`}
            >
              {choice.label}
            </span>
            <span className="leading-relaxed">{choice.text}</span>
          </button>
        );
      })}
    </div>
  );
}

function FreeFormInput({
  question,
  value,
  onChange,
  disabled,
}: {
  question: CheckInQuestion;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const placeholder =
    question.question_type === "numeric"
      ? `Enter your numeric answer${question.payload.units ? ` (${question.payload.units})` : ""}`
      : question.question_type === "symbolic"
        ? "Enter your expression (e.g. (m*v^2)/2)"
        : question.question_type === "code"
          ? "Paste your code"
          : "Type your answer here";
  const rows = question.question_type === "free_text" || question.question_type === "code" ? 6 : 2;
  return (
    <textarea
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      rows={rows}
      className="w-full resize-none rounded-2xl border border-black/10 bg-white px-3 py-2 text-sm focus:border-accent focus:outline-none disabled:bg-black/[0.04]"
    />
  );
}

function ResultBlock({ result }: { result: CheckInResult }) {
  return (
    <div
      className={`mt-4 rounded-2xl border px-4 py-3 ${
        result.is_correct
          ? "border-emerald-500/40 bg-emerald-50"
          : "border-rose-500/40 bg-rose-50"
      }`}
    >
      <div className="flex items-center gap-2 text-sm font-semibold">
        {result.is_correct ? (
          <Check className="h-4 w-4 text-emerald-700" />
        ) : (
          <X className="h-4 w-4 text-rose-700" />
        )}
        <span className={result.is_correct ? "text-emerald-800" : "text-rose-800"}>
          {result.is_correct ? "Correct" : "Not quite"} · {(result.score * 100).toFixed(0)}%
        </span>
        {result.misconception_tag ? (
          <span className="rounded-full bg-black/[0.05] px-2 py-[1px] text-[10.5px] text-black/60">
            {result.misconception_tag}
          </span>
        ) : null}
      </div>
      {result.feedback ? (
        <p className="mt-2 text-[13px] leading-relaxed text-black/80">{result.feedback}</p>
      ) : null}
      {result.explanation ? (
        <details className="mt-2 text-[12.5px] text-black/65">
          <summary className="cursor-pointer hover:text-black">Show explanation</summary>
          <p className="mt-1 leading-relaxed">{result.explanation}</p>
        </details>
      ) : null}
      {result.mastery_updates.length ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {result.mastery_updates.map((delta) => (
            <MasteryDeltaBadge key={delta.concept_id} delta={delta} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function CheckInPanel({
  sectionId,
  pathId: _pathId,
  onClose,
  onSectionCompleted,
}: CheckInPanelProps) {
  const [questions, setQuestions] = useState<CheckInQuestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [byId, setById] = useState<Record<string, QuestionState>>({});

  useEffect(() => {
    let cancelled = false;
    setQuestions(null);
    setError(null);
    setActiveIdx(0);
    setById({});
    api
      .getSectionQuestions(sectionId)
      .then((data) => {
        if (cancelled) return;
        setQuestions(data);
        const initial: Record<string, QuestionState> = {};
        data.forEach((q) => {
          initial[q.id] = emptyState();
        });
        setById(initial);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [sectionId]);

  const active = useMemo(() => {
    if (!questions || !questions.length) return null;
    return questions[Math.min(activeIdx, questions.length - 1)];
  }, [questions, activeIdx]);

  const activeState = active ? byId[active.id] : null;

  const setActiveAnswer = (val: string) => {
    if (!active) return;
    setById((prev) => ({
      ...prev,
      [active.id]: { ...prev[active.id], userAnswer: val },
    }));
  };

  const submit = async () => {
    if (!active || !activeState || activeState.submitting) return;
    if (!activeState.userAnswer.trim()) return;
    setById((prev) => ({
      ...prev,
      [active.id]: { ...prev[active.id], submitting: true, error: null },
    }));
    try {
      const result = await api.submitCheckIn({
        question_id: active.id,
        user_answer: activeState.userAnswer,
      });
      setById((prev) => ({
        ...prev,
        [active.id]: {
          ...prev[active.id],
          submitting: false,
          result,
        },
      }));
      // When the backend signals the section is done (last question
      // submitted), call the parent so the path advances.
      if (result.section_completed) {
        // Give the user a beat to read the explanation before
        // bouncing back to the path view.
        setTimeout(() => onSectionCompleted(), 1500);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Submission failed";
      setById((prev) => ({
        ...prev,
        [active.id]: {
          ...prev[active.id],
          submitting: false,
          error: message,
        },
      }));
    }
  };

  if (error) {
    return (
      <div className="space-y-3">
        <div className="rounded-xl bg-warn/10 px-3 py-2 text-sm text-warn">{error}</div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-black/10 px-3 py-1.5 text-[12px]"
        >
          Back to path
        </button>
      </div>
    );
  }
  if (!questions) {
    return (
      <div className="flex items-center gap-2 text-sm text-black/55">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading questions…
      </div>
    );
  }
  if (!questions.length) {
    return (
      <div className="space-y-3">
        <div className="text-sm text-black/65">
          No questions are available for this section yet.
        </div>
        <button
          type="button"
          onClick={onSectionCompleted}
          className="rounded-full bg-accent px-3 py-1.5 text-[12px] font-medium text-white"
        >
          Mark section done anyway
        </button>
      </div>
    );
  }

  if (!active || !activeState) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[12px] text-black/55 hover:text-black"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to path
        </button>
        <div className="text-[12px] text-black/45">
          Question {activeIdx + 1} of {questions.length}
        </div>
      </div>
      <div className="rounded-2xl bg-white/65 border border-black/[0.06] px-4 py-4">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-black/45">
          <span>{active.question_type.replace("_", " ")}</span>
          <span>· difficulty {active.difficulty}</span>
        </div>
        <h3 className="mt-2 text-[14.5px] font-semibold leading-relaxed">{active.stem}</h3>
        <div className="mt-3">
          {active.question_type === "mcq" || active.question_type === "counterexample" ? (
            <MCQInput
              question={active}
              value={activeState.userAnswer}
              onChange={setActiveAnswer}
              disabled={!!activeState.result}
            />
          ) : (
            <FreeFormInput
              question={active}
              value={activeState.userAnswer}
              onChange={setActiveAnswer}
              disabled={!!activeState.result}
            />
          )}
        </div>
        {activeState.error ? (
          <div className="mt-2 rounded-xl bg-warn/10 px-3 py-2 text-[12px] text-warn">
            {activeState.error}
          </div>
        ) : null}
        {!activeState.result ? (
          <button
            type="button"
            onClick={submit}
            disabled={activeState.submitting || !activeState.userAnswer.trim()}
            className="mt-4 inline-flex items-center gap-2 rounded-full bg-[#2a2522] px-4 py-2 text-[12.5px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 hover:bg-[#3a3530]"
          >
            {activeState.submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Submit answer
          </button>
        ) : (
          <ResultBlock result={activeState.result} />
        )}
      </div>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setActiveIdx((v) => Math.max(0, v - 1))}
          disabled={activeIdx === 0}
          className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[12px] text-black/55 disabled:opacity-40 hover:text-black"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Previous
        </button>
        <button
          type="button"
          onClick={() => setActiveIdx((v) => Math.min(questions.length - 1, v + 1))}
          disabled={activeIdx >= questions.length - 1}
          className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-[12px] text-black/55 disabled:opacity-40 hover:text-black"
        >
          Next
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
