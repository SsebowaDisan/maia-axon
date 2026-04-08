"use client";

import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { CitationChip } from "@/components/chat/Citation";
import { cn, citationById, transformCitationLinks } from "@/lib/utils";
import type { Citation } from "@/lib/types";

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
  const markdown = transformCitationLinks(content, citations);

  return (
    <ReactMarkdown
      className="prose prose-slate max-w-none text-sm leading-7 prose-headings:font-display prose-headings:text-ink prose-strong:text-ink prose-p:text-ink prose-li:text-ink prose-code:rounded prose-code:bg-black/5 prose-code:px-1 prose-code:py-0.5 prose-code:font-mono prose-code:text-xs dark:prose-invert"
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        a({ href, children }) {
          if (!href?.startsWith("citation:")) {
            return (
              <a href={href} target="_blank" rel="noreferrer" className="text-accent underline">
                {children}
              </a>
            );
          }

          const citation = indexedCitations[href.replace("citation:", "")];
          if (!citation) {
            return <span className="text-accent">{children}</span>;
          }

          return (
            <CitationChip
              citation={citation}
              label={children}
              onClick={() => onCitationClick?.(citation)}
            />
          );
        },
        table({ children }) {
          return (
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse overflow-hidden rounded-2xl border border-line text-sm">
                {children}
              </table>
            </div>
          );
        },
        th({ children }) {
          return <th className="bg-black/5 px-3 py-2 text-left text-xs uppercase tracking-[0.16em]">{children}</th>;
        },
        td({ children }) {
          return <td className="border-t border-line px-3 py-2 align-top">{children}</td>;
        },
        code({ className, children }) {
          const isInline = !className;
          return (
            <code
              className={cn(
                isInline ? "rounded bg-black/5 px-1 py-0.5 font-mono text-xs" : "block",
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
