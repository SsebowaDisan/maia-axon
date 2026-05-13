"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";

// pdfjs's outline node shape (what pdf.getOutline() returns). Re-declared
// locally so we don't pull in pdfjs's internal types just for the field
// names we use; the API is stable across v3-v5.
interface PdfOutlineNode {
  title: string;
  bold?: boolean;
  italic?: boolean;
  dest?: string | unknown[] | null;
  url?: string | null;
  items?: PdfOutlineNode[];
}

interface ResolvedNode {
  title: string;
  bold: boolean;
  italic: boolean;
  pageNumber: number | null;
  url: string | null;
  children: ResolvedNode[];
}

interface PDFOutlineProps {
  pdf: PDFDocumentProxy | null;
  currentPage: number;
  onSelectPage: (pageNumber: number) => void;
}

// Walk the outline tree from pdfjs and resolve each node's destination
// to a 1-indexed page number. Destinations come in three shapes (named
// string, explicit array starting with a Ref, or an external URL); we
// flatten all three into a simple { pageNumber } that the UI can click.
async function resolveOutline(
  pdf: PDFDocumentProxy,
  nodes: PdfOutlineNode[],
): Promise<ResolvedNode[]> {
  const resolved: ResolvedNode[] = [];
  for (const node of nodes) {
    let pageNumber: number | null = null;
    let url: string | null = node.url ?? null;
    try {
      let destArray: unknown[] | null = null;
      if (typeof node.dest === "string") {
        destArray = (await pdf.getDestination(node.dest)) as unknown[] | null;
      } else if (Array.isArray(node.dest)) {
        destArray = node.dest;
      }
      if (destArray && destArray.length > 0) {
        const ref = destArray[0];
        if (ref && typeof ref === "object") {
          const pageIndex = await pdf.getPageIndex(ref as never);
          pageNumber = pageIndex + 1;
        }
      }
    } catch {
      // Outline entry without a resolvable destination — render it as a
      // disabled label rather than dropping it (useful for section
      // headers with no direct target page).
      pageNumber = null;
    }
    const children = node.items?.length ? await resolveOutline(pdf, node.items as PdfOutlineNode[]) : [];
    resolved.push({
      title: node.title,
      bold: !!node.bold,
      italic: !!node.italic,
      pageNumber,
      url,
      children,
    });
  }
  return resolved;
}

function OutlineNode({
  node,
  depth,
  currentPage,
  onSelectPage,
}: {
  node: ResolvedNode;
  depth: number;
  currentPage: number;
  onSelectPage: (pageNumber: number) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasChildren = node.children.length > 0;
  const isActive = node.pageNumber !== null && node.pageNumber === currentPage;

  return (
    <div>
      <div
        className={`group flex items-start gap-1 rounded-md px-1 py-1 text-[12px] leading-5 transition ${
          isActive
            ? "bg-white/15 text-white"
            : "text-white/80 hover:bg-white/[0.06] hover:text-white"
        }`}
        style={{ paddingLeft: 4 + depth * 10 }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={expanded ? "Collapse" : "Expand"}
            onClick={() => setExpanded((value) => !value)}
            className="mt-0.5 shrink-0 text-white/50 hover:text-white"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="mt-0.5 inline-block h-3 w-3 shrink-0" />
        )}
        {node.url ? (
          <a
            href={node.url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 flex-1 truncate text-left underline-offset-2 hover:underline"
            title={node.title}
          >
            {node.title}
          </a>
        ) : node.pageNumber !== null ? (
          <button
            type="button"
            onClick={() => onSelectPage(node.pageNumber as number)}
            className="min-w-0 flex-1 truncate text-left"
            title={`${node.title} — page ${node.pageNumber}`}
            style={{ fontWeight: node.bold ? 600 : 400, fontStyle: node.italic ? "italic" : "normal" }}
          >
            {node.title}
          </button>
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-left text-white/50"
            title={node.title}
            style={{ fontWeight: node.bold ? 600 : 400, fontStyle: node.italic ? "italic" : "normal" }}
          >
            {node.title}
          </span>
        )}
        {node.pageNumber !== null && !node.url ? (
          <span className="ml-1 shrink-0 text-[10px] tabular-nums text-white/45">
            {node.pageNumber}
          </span>
        ) : null}
      </div>
      {hasChildren && expanded ? (
        <div>
          {node.children.map((child, index) => (
            <OutlineNode
              key={`${depth}-${index}-${child.title}`}
              node={child}
              depth={depth + 1}
              currentPage={currentPage}
              onSelectPage={onSelectPage}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function PDFOutline({ pdf, currentPage, onSelectPage }: PDFOutlineProps) {
  const [outline, setOutline] = useState<ResolvedNode[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!pdf) {
      setOutline(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const raw = (await pdf.getOutline()) as PdfOutlineNode[] | null;
        const resolved = raw && raw.length ? await resolveOutline(pdf, raw) : [];
        if (!cancelled) {
          setOutline(resolved);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setOutline([]);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf]);

  if (loading) {
    return (
      <div className="px-3 py-4 text-[11px] uppercase tracking-[0.16em] text-white/55">
        Loading outline…
      </div>
    );
  }

  if (!outline || outline.length === 0) {
    return (
      <div className="px-3 py-4 text-[11px] leading-5 text-white/55">
        This PDF has no embedded outline.
      </div>
    );
  }

  return (
    <div className="space-y-0.5 px-1 py-2">
      {outline.map((node, index) => (
        <OutlineNode
          key={`root-${index}-${node.title}`}
          node={node}
          depth={0}
          currentPage={currentPage}
          onSelectPage={onSelectPage}
        />
      ))}
    </div>
  );
}

// Helper used by PDFViewer to know whether the document has an outline
// before rendering the tab — lets us hide the "Outline" tab on PDFs that
// don't ship one (so the UI doesn't tease an empty panel).
export async function pdfHasOutline(pdf: PDFDocumentProxy | null): Promise<boolean> {
  if (!pdf) return false;
  try {
    const outline = (await pdf.getOutline()) as PdfOutlineNode[] | null;
    return !!outline && outline.length > 0;
  } catch {
    return false;
  }
}
