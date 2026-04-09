"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { CitationChip } from "@/components/chat/Citation";
import { cn, citationById, normalizeMathMarkdown, transformCitationLinks } from "@/lib/utils";
import type { Citation } from "@/lib/types";

function textFromChildren(children: React.ReactNode) {
  return React.Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }
      return "";
    })
    .join("")
    .trim();
}

function citationFromLinkLabel(label: string, citations: Citation[]) {
  const sourceMatch = label.match(/^Source\s+(\d+)$/i);
  if (sourceMatch) {
    return citations[Number(sourceMatch[1]) - 1] ?? null;
  }

  const bracketMatch = label.match(/^\[(\d+)\]$/);
  if (bracketMatch) {
    return citations[Number(bracketMatch[1]) - 1] ?? null;
  }

  return null;
}

export function MarkdownRenderer({
  content,
  citations,
  onCitationClick,
}: {
  content: string;
  citations: Citation[];
  onCitationClick?: (citation: Citation) => void;
}) {
  const indexedCitations = citationById(citations);
  const markdown = transformCitationLinks(normalizeMathMarkdown(content), citations);

  return (
    <ReactMarkdown
      className="chat-markdown prose prose-slate max-w-none text-[16px] leading-8 text-ink prose-headings:font-display prose-headings:text-ink prose-strong:text-ink prose-p:text-ink prose-li:text-ink prose-code:rounded-xl prose-code:border prose-code:border-black/8 prose-code:bg-black/[0.04] prose-code:px-1.5 prose-code:py-0.5 prose-code:font-mono prose-code:text-[12px] prose-pre:rounded-[24px] prose-pre:border prose-pre:border-black/8 prose-pre:bg-black prose-pre:px-5 prose-pre:py-4 prose-pre:text-white"
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        a({ href, children }) {
          const labelText = textFromChildren(children);
          const linkedCitation =
            (href?.startsWith("citation:")
              ? indexedCitations[href.replace("citation:", "")]
              : citationFromLinkLabel(labelText, citations)) ?? null;

          if (linkedCitation) {
            return (
              <CitationChip
                citation={linkedCitation}
                label={children}
                className="align-[0.1em] border-black/8 bg-black/[0.035] text-black hover:bg-black hover:text-white"
                onClick={() => onCitationClick?.(linkedCitation)}
              />
            );
          }

          if (!href?.startsWith("citation:")) {
            return (
              <a href={href} rel="noreferrer" className="text-accent underline">
                {children}
              </a>
            );
          }

          return <span className="text-accent">{children}</span>;
        },
        h1({ children }) {
          return <h1 className="mt-2 text-[1.9rem] font-semibold tracking-[-0.05em] text-ink">{children}</h1>;
        },
        h2({ children }) {
          return <h2 className="mt-10 border-t border-black/6 pt-6 text-[1.34rem] font-semibold tracking-[-0.03em] text-ink">{children}</h2>;
        },
        h3({ children }) {
          return <h3 className="mt-7 text-[1.08rem] font-semibold tracking-[-0.02em] text-ink">{children}</h3>;
        },
        ul({ children }) {
          return <ul className="my-5 space-y-3 pl-0">{children}</ul>;
        },
        ol({ children }) {
          return <ol className="my-5 space-y-3 pl-0">{children}</ol>;
        },
        li({ children }) {
          return <li className="ml-6 pl-1 marker:text-black/35">{children}</li>;
        },
        p({ children }) {
          return <p className="my-5 text-[16px] leading-9 text-ink">{children}</p>;
        },
        blockquote({ children }) {
          return (
            <blockquote className="my-6 rounded-[24px] border border-black/8 bg-black/[0.025] px-5 py-4 text-ink/80">
              {children}
            </blockquote>
          );
        },
        hr() {
          return <hr className="my-8 border-black/8" />;
        },
        table({ children }) {
          return (
            <div className="my-6 overflow-x-auto rounded-[24px] border border-black/8 bg-white">
              <table className="min-w-full border-collapse overflow-hidden rounded-[24px] border border-black/8 bg-white text-sm">
                {children}
              </table>
            </div>
          );
        },
        th({ children }) {
          return <th className="bg-black/[0.04] px-4 py-3 text-left text-[11px] uppercase tracking-[0.18em] text-muted">{children}</th>;
        },
        td({ children }) {
          return <td className="border-t border-black/8 px-4 py-3 align-top text-ink/85">{children}</td>;
        },
        code({ className, children }) {
          const isInline = !className;
          return (
            <code
              className={cn(
                isInline ? "rounded-xl border border-black/8 bg-black/[0.04] px-1.5 py-0.5 font-mono text-[12px]" : "block",
                className,
              )}
            >
              {children}
            </code>
          );
        },
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}
