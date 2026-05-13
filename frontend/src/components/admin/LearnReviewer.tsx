"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  RefreshCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";

import { api } from "@/lib/api";
import type {
  AdminLearnConceptRow,
  AdminLearnDocumentRow,
  AdminLearnQuestionRow,
  AdminLearnSectionDetail,
  AdminLearnSectionSummary,
} from "@/lib/types";

type View =
  | { kind: "docs" }
  | { kind: "sections"; documentId: string; filename: string }
  | { kind: "section"; documentId: string; sectionId: string; filename: string }
  | { kind: "concepts"; documentId: string; filename: string };

function flagSeverity(flags: string[]): "none" | "low" | "high" {
  if (!flags.length) return "none";
  if (flags.some((f) => f.startsWith("low confidence"))) return "low";
  return "high";
}

function FlagBadge({ flags }: { flags: string[] }) {
  const sev = flagSeverity(flags);
  if (sev === "none") return null;
  const bg = sev === "high" ? "bg-rose-100 text-rose-800" : "bg-amber-100 text-amber-800";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-[1px] text-[10.5px] ${bg}`}
      title={flags.join(" · ")}
    >
      <AlertTriangle className="h-2.5 w-2.5" />
      {flags.length}
    </span>
  );
}

function DocumentsList({ onPick }: { onPick: (doc: AdminLearnDocumentRow) => void }) {
  const [docs, setDocs] = useState<AdminLearnDocumentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .adminListLearnDocuments()
      .then((data) => !cancelled && setDocs(data))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <div className="text-sm text-warn">{error}</div>;
  if (!docs) return <Loader />;
  if (!docs.length) return <Empty text="No documents enriched yet." />;

  return (
    <div className="space-y-2">
      {docs.map((doc) => (
        <button
          type="button"
          key={doc.id}
          onClick={() => onPick(doc)}
          className="flex w-full items-center justify-between gap-3 rounded-2xl border border-black/10 bg-white px-4 py-3 text-left transition hover:border-black/20"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{doc.filename}</p>
            <p className="mt-0.5 text-[12px] text-black/55">
              {doc.section_count} sections · {doc.question_count} questions
              {doc.page_count ? ` · ${doc.page_count} pages` : ""}
            </p>
          </div>
          {doc.flagged_section_count > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-[3px] text-[11px] font-semibold text-amber-800">
              <AlertTriangle className="h-3 w-3" />
              {doc.flagged_section_count} to review
            </span>
          ) : (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-100 px-2 py-[3px] text-[11px] font-semibold text-emerald-800">
              <Check className="h-3 w-3" />
              Clean
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function SectionsList({
  documentId,
  onPick,
  onBack,
  onConcepts,
  filename,
}: {
  documentId: string;
  filename: string;
  onPick: (sectionId: string) => void;
  onBack: () => void;
  onConcepts: () => void;
}) {
  const [sections, setSections] = useState<AdminLearnSectionSummary[] | null>(null);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSections(null);
    api
      .adminListLearnSections(documentId, flaggedOnly)
      .then((data) => !cancelled && setSections(data))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [documentId, flaggedOnly]);

  if (error) return <div className="text-sm text-warn">{error}</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[12px] text-black/55 hover:text-black"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All documents
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onConcepts}
            className="rounded-full border border-black/10 px-3 py-1 text-[12px] hover:bg-black/[0.04]"
          >
            View concepts
          </button>
          <label className="inline-flex items-center gap-2 text-[12px] text-black/55">
            <input
              type="checkbox"
              checked={flaggedOnly}
              onChange={(e) => setFlaggedOnly(e.target.checked)}
            />
            Flagged only
          </label>
        </div>
      </div>
      <p className="truncate text-sm font-semibold">{filename}</p>
      {sections === null ? (
        <Loader />
      ) : !sections.length ? (
        <Empty text={flaggedOnly ? "No flagged sections." : "No sections."} />
      ) : (
        <div className="space-y-1">
          {sections.map((section) => (
            <button
              type="button"
              key={section.id}
              onClick={() => onPick(section.id)}
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-black/[0.06] bg-white px-3 py-2 text-left transition hover:border-black/15"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={`shrink-0 rounded-full px-2 py-[1px] text-[10px] uppercase tracking-[0.14em] ${
                    section.kind === "headline"
                      ? "bg-black/[0.06] text-black/70"
                      : section.kind === "subtopic"
                        ? "bg-black/[0.04] text-black/55"
                        : "bg-black/[0.04] font-semibold text-black/70"
                  }`}
                >
                  {section.kind}
                </span>
                <span className="truncate text-[13px]">{section.title}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-[11px] text-black/45">
                <FlagBadge flags={section.review_flags} />
                <span>
                  p. {section.page_start}–{section.page_end}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SectionDetail({
  sectionId,
  onBack,
  onJumpSection,
}: {
  sectionId: string;
  onBack: () => void;
  onJumpSection: (id: string) => void;
}) {
  const [detail, setDetail] = useState<AdminLearnSectionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "save" | "regenerate" | "delete">(null);
  const [tab, setTab] = useState<"payload" | "questions">("payload");
  const [draftSummary, setDraftSummary] = useState("");
  const [draftJson, setDraftJson] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);

  const reload = () => {
    setDetail(null);
    api
      .adminGetLearnSection(sectionId)
      .then((data) => {
        setDetail(data);
        const c = (data.content_json ?? {}) as Record<string, unknown>;
        setDraftSummary(typeof c.summary === "string" ? c.summary : "");
        setDraftJson(JSON.stringify(data.content_json ?? {}, null, 2));
      })
      .catch((err: Error) => setError(err.message));
  };

  useEffect(() => {
    setError(null);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionId]);

  const handleSave = async () => {
    if (!detail) return;
    setBusy("save");
    try {
      let parsed: Record<string, unknown> | undefined;
      if (draftJson) {
        try {
          parsed = JSON.parse(draftJson);
          setJsonError(null);
        } catch (err) {
          setJsonError(err instanceof Error ? err.message : "Invalid JSON");
          setBusy(null);
          return;
        }
      }
      const next = await api.adminPatchLearnSection(detail.id, {
        content_summary: draftSummary,
        ...(parsed ? { content_json: parsed } : {}),
      });
      setDetail(next);
      setDraftJson(JSON.stringify(next.content_json ?? {}, null, 2));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(null);
    }
  };

  const handleRegenerate = async () => {
    if (!detail) return;
    if (!window.confirm("Re-run LLM enrichment for this section? The current payload will be overwritten.")) return;
    setBusy("regenerate");
    try {
      const next = await api.adminRegenerateLearnSection(detail.id);
      setDetail(next);
      setDraftJson(JSON.stringify(next.content_json ?? {}, null, 2));
      const c = (next.content_json ?? {}) as Record<string, unknown>;
      setDraftSummary(typeof c.summary === "string" ? c.summary : "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Regenerate failed");
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    if (!detail) return;
    if (!window.confirm("Delete this section? Cascades to its questions and concept introductions.")) return;
    setBusy("delete");
    try {
      await api.adminDeleteLearnSection(detail.id);
      onBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
      setBusy(null);
    }
  };

  if (error) return <div className="text-sm text-warn">{error}</div>;
  if (!detail) return <Loader />;

  const content = (detail.content_json ?? {}) as Record<string, unknown>;
  const flags = Array.isArray(content.review_flags) ? (content.review_flags as string[]) : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[12px] text-black/55 hover:text-black"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRegenerate}
            disabled={busy !== null || detail.kind !== "headline"}
            className="inline-flex items-center gap-1.5 rounded-full border border-black/10 px-3 py-1 text-[12px] disabled:opacity-50 hover:bg-black/[0.04]"
          >
            {busy === "regenerate" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
            Regenerate
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-full border border-warn/30 px-3 py-1 text-[12px] text-warn disabled:opacity-50 hover:bg-warn/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
        </div>
      </div>
      <div>
        <p className="text-[11px] uppercase tracking-[0.18em] text-black/40">{detail.kind}</p>
        <p className="mt-0.5 text-base font-semibold">{detail.title}</p>
        <p className="mt-0.5 text-[12px] text-black/55">
          Pages {detail.page_start}–{detail.page_end} · {detail.question_count} questions
        </p>
        {flags.length > 0 ? (
          <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-[2px] text-[11px] text-amber-800">
            <AlertTriangle className="h-3 w-3" />
            {flags.join(" · ")}
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 gap-2 border-b border-black/[0.06]">
        <button
          type="button"
          onClick={() => setTab("payload")}
          className={`px-3 py-2 text-[12px] font-medium ${
            tab === "payload" ? "border-b-2 border-accent text-ink" : "text-black/55 hover:text-black"
          }`}
        >
          Payload
        </button>
        <button
          type="button"
          onClick={() => setTab("questions")}
          className={`px-3 py-2 text-[12px] font-medium ${
            tab === "questions" ? "border-b-2 border-accent text-ink" : "text-black/55 hover:text-black"
          }`}
        >
          Questions ({detail.question_count})
        </button>
      </div>

      {tab === "payload" ? (
        <div className="space-y-3">
          <div>
            <label className="text-[12px] font-semibold text-black/65">Summary</label>
            <textarea
              value={draftSummary}
              onChange={(e) => setDraftSummary(e.target.value)}
              rows={2}
              className="mt-1 w-full resize-none rounded-xl border border-black/10 bg-white px-3 py-2 text-sm focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label className="text-[12px] font-semibold text-black/65">
              Full content_json (advanced — edit JSON directly)
            </label>
            <textarea
              value={draftJson}
              onChange={(e) => setDraftJson(e.target.value)}
              rows={18}
              spellCheck={false}
              className="mt-1 w-full resize-y rounded-xl border border-black/10 bg-white px-3 py-2 font-mono text-[12px] focus:border-accent focus:outline-none"
            />
            {jsonError ? (
              <p className="mt-1 text-[11.5px] text-warn">JSON parse error: {jsonError}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={handleSave}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#2a2522] px-4 py-2 text-[12.5px] font-semibold text-white disabled:opacity-50 hover:bg-[#3a3530]"
          >
            {busy === "save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save changes
          </button>
        </div>
      ) : (
        <QuestionsList sectionId={detail.id} onJumpSection={onJumpSection} />
      )}
    </div>
  );
}

function QuestionsList({
  sectionId,
  onJumpSection: _onJumpSection,
}: {
  sectionId: string;
  onJumpSection: (id: string) => void;
}) {
  const [questions, setQuestions] = useState<AdminLearnQuestionRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = () => {
    setQuestions(null);
    api
      .adminListLearnQuestions(sectionId)
      .then((data) => setQuestions(data))
      .catch((err: Error) => setError(err.message));
  };

  useEffect(() => {
    setError(null);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionId]);

  const handleRegenerate = async () => {
    if (!window.confirm("Re-generate the entire question bank for this section? Existing questions will be deleted.")) return;
    setBusy(true);
    try {
      const next = await api.adminRegenerateLearnQuestions(sectionId);
      setQuestions(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Regenerate failed");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this question?")) return;
    try {
      await api.adminDeleteLearnQuestion(id);
      setQuestions((prev) => prev?.filter((q) => q.id !== id) ?? prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  if (error) return <div className="text-sm text-warn">{error}</div>;
  if (!questions) return <Loader />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={handleRegenerate}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-full border border-black/10 px-3 py-1 text-[12px] disabled:opacity-50 hover:bg-black/[0.04]"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
          Re-generate all
        </button>
      </div>
      {!questions.length ? (
        <Empty text="No questions for this section." />
      ) : (
        questions.map((q) => <QuestionCard key={q.id} q={q} onDelete={() => handleDelete(q.id)} />)
      )}
    </div>
  );
}

function QuestionCard({ q, onDelete }: { q: AdminLearnQuestionRow; onDelete: () => void }) {
  const conf = q.review_meta?.confidence;
  const lowConf = typeof conf === "number" && conf <= 1;
  const leaky = !!q.review_meta?.leakage_flag;

  return (
    <div
      className={`rounded-2xl border px-4 py-3 ${
        leaky ? "border-rose-300 bg-rose-50/40" : lowConf ? "border-amber-300 bg-amber-50/40" : "border-black/[0.06] bg-white"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-black/45">
            <span>{q.question_type.replace("_", " ")}</span>
            <span>· difficulty {q.difficulty}</span>
            {typeof conf === "number" ? <span>· confidence {conf}/3</span> : null}
            {leaky ? <span className="text-rose-700">· leaky</span> : null}
          </div>
          <p className="mt-1.5 text-[13.5px] font-semibold leading-snug">{q.stem}</p>
        </div>
        <button
          type="button"
          onClick={onDelete}
          className="rounded-full p-1 text-black/45 hover:bg-warn/10 hover:text-warn"
          title="Delete question"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {q.review_meta?.source_quote ? (
        <p className="mt-2 rounded bg-black/[0.04] px-2 py-1 text-[11.5px] italic text-black/65">
          Quote: {q.review_meta.source_quote}
        </p>
      ) : null}
      <details className="mt-2 text-[12px] text-black/65">
        <summary className="cursor-pointer hover:text-black">Show answer key + payload</summary>
        <pre className="mt-1 overflow-x-auto rounded bg-black/[0.04] p-2 font-mono text-[11px] leading-snug">
          {JSON.stringify(q.payload, null, 2)}
        </pre>
        <p className="mt-1">
          <span className="font-semibold">Explanation:</span> {q.explanation}
        </p>
      </details>
    </div>
  );
}

function ConceptsList({
  documentId,
  filename,
  onBack,
}: {
  documentId: string;
  filename: string;
  onBack: () => void;
}) {
  const [concepts, setConcepts] = useState<AdminLearnConceptRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingMerge, setPendingMerge] = useState<{ keep: AdminLearnConceptRow | null; absorb: AdminLearnConceptRow | null }>({
    keep: null,
    absorb: null,
  });

  const reload = () => {
    setConcepts(null);
    api
      .adminListLearnConcepts(documentId)
      .then((data) => setConcepts(data))
      .catch((err: Error) => setError(err.message));
  };

  useEffect(() => {
    setError(null);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  const canMerge = pendingMerge.keep && pendingMerge.absorb && pendingMerge.keep.id !== pendingMerge.absorb.id;

  const handleMerge = async () => {
    if (!pendingMerge.keep || !pendingMerge.absorb) return;
    if (!window.confirm(`Merge "${pendingMerge.absorb.canonical_name}" into "${pendingMerge.keep.canonical_name}"?`)) return;
    try {
      await api.adminMergeLearnConcepts({
        keep_id: pendingMerge.keep.id,
        absorb_id: pendingMerge.absorb.id,
      });
      setPendingMerge({ keep: null, absorb: null });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Merge failed");
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this concept entirely? Use this for hallucinations only.")) return;
    try {
      await api.adminDeleteLearnConcept(id);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  if (error) return <div className="text-sm text-warn">{error}</div>;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[12px] text-black/55 hover:text-black"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to sections
        </button>
        <p className="truncate text-[12px] text-black/55">{filename}</p>
      </div>

      {pendingMerge.keep || pendingMerge.absorb ? (
        <div className="rounded-2xl border border-accent/40 bg-accentSoft px-4 py-3">
          <p className="text-[12px] font-semibold">Stage a merge</p>
          <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
            <div className="rounded-xl bg-white/85 px-3 py-2">
              <p className="text-[10.5px] uppercase tracking-[0.16em] text-black/45">Keep</p>
              <p className="truncate text-[13px] font-semibold">
                {pendingMerge.keep?.canonical_name ?? "— pick one below"}
              </p>
            </div>
            <ArrowRight className="h-4 w-4 text-black/45" />
            <div className="rounded-xl bg-white/85 px-3 py-2">
              <p className="text-[10.5px] uppercase tracking-[0.16em] text-black/45">Absorb</p>
              <p className="truncate text-[13px] font-semibold">
                {pendingMerge.absorb?.canonical_name ?? "— pick one below"}
              </p>
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={handleMerge}
              disabled={!canMerge}
              className="rounded-full bg-[#2a2522] px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-50 hover:bg-[#3a3530]"
            >
              Confirm merge
            </button>
            <button
              type="button"
              onClick={() => setPendingMerge({ keep: null, absorb: null })}
              className="rounded-full border border-black/10 px-3 py-1.5 text-[12px] hover:bg-black/[0.04]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {!concepts ? (
        <Loader />
      ) : !concepts.length ? (
        <Empty text="No concepts yet for this document." />
      ) : (
        <div className="space-y-1">
          {concepts.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-black/[0.06] bg-white px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold">{c.canonical_name}</p>
                <p className="mt-0.5 line-clamp-1 text-[11.5px] text-black/55">
                  {c.canonical_definition || "(no definition)"}
                </p>
                <p className="mt-0.5 text-[11px] text-black/45">
                  introduced ×{c.introduction_count} · applied ×{c.application_count}
                  {c.aliases && c.aliases.length ? ` · aka ${c.aliases.slice(0, 3).join(", ")}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPendingMerge((m) => ({ ...m, keep: c }))}
                  className="rounded-full border border-black/10 px-2 py-[2px] text-[11px] hover:bg-black/[0.04]"
                >
                  Keep
                </button>
                <button
                  type="button"
                  onClick={() => setPendingMerge((m) => ({ ...m, absorb: c }))}
                  className="rounded-full border border-black/10 px-2 py-[2px] text-[11px] hover:bg-black/[0.04]"
                >
                  Absorb
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(c.id)}
                  className="rounded-full p-1 text-black/45 hover:bg-warn/10 hover:text-warn"
                  title="Delete (hallucination)"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Loader() {
  return (
    <div className="flex items-center gap-2 text-sm text-black/55">
      <Loader2 className="h-4 w-4 animate-spin" />
      Loading…
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-xl border border-dashed border-black/10 px-3 py-6 text-center text-sm text-black/55">{text}</div>;
}

export function LearnReviewer() {
  const [view, setView] = useState<View>({ kind: "docs" });

  const content = useMemo(() => {
    if (view.kind === "docs") {
      return (
        <DocumentsList
          onPick={(doc) => setView({ kind: "sections", documentId: doc.id, filename: doc.filename })}
        />
      );
    }
    if (view.kind === "sections") {
      return (
        <SectionsList
          documentId={view.documentId}
          filename={view.filename}
          onBack={() => setView({ kind: "docs" })}
          onConcepts={() =>
            setView({ kind: "concepts", documentId: view.documentId, filename: view.filename })
          }
          onPick={(sectionId) =>
            setView({
              kind: "section",
              sectionId,
              documentId: view.documentId,
              filename: view.filename,
            })
          }
        />
      );
    }
    if (view.kind === "section") {
      return (
        <SectionDetail
          sectionId={view.sectionId}
          onBack={() =>
            setView({ kind: "sections", documentId: view.documentId, filename: view.filename })
          }
          onJumpSection={(id) =>
            setView({
              kind: "section",
              sectionId: id,
              documentId: view.documentId,
              filename: view.filename,
            })
          }
        />
      );
    }
    return (
      <ConceptsList
        documentId={view.documentId}
        filename={view.filename}
        onBack={() =>
          setView({ kind: "sections", documentId: view.documentId, filename: view.filename })
        }
      />
    );
  }, [view]);

  return <div className="space-y-4">{content}</div>;
}
