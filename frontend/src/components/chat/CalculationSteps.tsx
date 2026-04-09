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
      className: "border-l-black bg-white text-ink",
      label: "From PDF",
    };
  }
  if (lower.includes("user")) {
    return {
      icon: User2,
      className: "border-l-black/40 bg-black/[0.03] text-ink",
      label: "From user",
    };
  }
  if (lower.includes("result")) {
    return {
      icon: Sigma,
      className: "border-l-black bg-black text-white",
      label: "Result",
    };
  }
  return {
    icon: Brain,
    className: "border-l-black/10 bg-black/[0.03] text-ink",
    label: "Model reasoning",
  };
}

function matchCitation(line: string, citations: Citation[]) {
  const match = line.match(/\[(\d+)\]|\[Source (\d+)\]/i);
  if (!match) {
    return null;
  }
  return citations[Number(match[1] || match[2]) - 1] ?? null;
}

function normalizeCitationLabel(line: string) {
  return line.replace(/\[Source\s+(\d+)\]/gi, "[$1]");
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
    <div className="mt-2 rounded-[28px] border border-black/8 bg-[linear-gradient(180deg,rgba(251,251,251,0.95),rgba(246,246,246,0.95))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
      <div className="mb-4 flex items-center justify-between">
        <h4 className="text-[12px] font-semibold uppercase tracking-[0.22em] text-muted">Working</h4>
      </div>
      <div className="space-y-3">
        {lines.map((line, index) => {
          const meta = getLineMeta(line);
          const citation = matchCitation(line, citations);
          const Icon = meta.icon;

          return (
            <div
              key={`${line}-${index}`}
              className={`rounded-[22px] border border-black/8 border-l-4 px-4 py-3.5 shadow-[0_8px_20px_rgba(15,23,42,0.03)] ${meta.className}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="text-[15px] font-medium leading-7 tracking-[-0.01em]">
                      {normalizeCitationLabel(line)}
                    </p>
                    <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted">
                      {meta.label}
                    </p>
                  </div>
                </div>
                {citation ? (
                  <CitationChip
                    citation={citation}
                    className="border-black/8 bg-white text-black hover:bg-black hover:text-white"
                    onClick={() => onCitationClick?.(citation)}
                  />
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
