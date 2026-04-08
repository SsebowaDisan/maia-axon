"use client";

import { Brain, FileText, Sigma, User2 } from "lucide-react";

import { CitationChip } from "@/components/chat/Citation";
import type { Citation } from "@/lib/types";
import { extractCalculationLines } from "@/lib/utils";

function getLineMeta(line: string) {
  const lower = line.toLowerCase();
  if (lower.includes("formula")) {
    return {
      icon: FileText,
      className: "border-l-accent bg-accentSoft/50 text-ink",
      label: "From PDF",
    };
  }
  if (lower.includes("user")) {
    return {
      icon: User2,
      className: "border-l-success bg-success/5 text-ink",
      label: "From user",
    };
  }
  if (lower.includes("result")) {
    return {
      icon: Sigma,
      className: "border-l-success bg-success/10 text-success",
      label: "Result",
    };
  }
  return {
    icon: Brain,
    className: "border-l-line bg-black/5 text-ink",
    label: "Model reasoning",
  };
}

function matchCitation(line: string, citations: Citation[]) {
  const match = line.match(/\[Source (\d+)\]/i);
  if (!match) {
    return null;
  }
  return citations[Number(match[1]) - 1] ?? null;
}

export function CalculationSteps({
  content,
  citations,
  onCitationClick,
}: {
  content: string;
  citations: Citation[];
  onCitationClick?: (citation: Citation) => void;
}) {
  const lines = extractCalculationLines(content);

  if (lines.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 rounded-[26px] border border-line bg-white/60 p-4 dark:bg-panel/75">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="font-display text-sm tracking-[0.18em] text-muted uppercase">Calculation</h4>
      </div>
      <div className="space-y-3">
        {lines.map((line, index) => {
          const meta = getLineMeta(line);
          const citation = matchCitation(line, citations);
          const Icon = meta.icon;

          return (
            <div
              key={`${line}-${index}`}
              className={`rounded-2xl border border-line/70 border-l-4 px-4 py-3 ${meta.className}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="text-sm font-medium">{line}</p>
                    <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted">
                      {meta.label}
                    </p>
                  </div>
                </div>
                {citation ? (
                  <CitationChip citation={citation} onClick={() => onCitationClick?.(citation)} />
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
