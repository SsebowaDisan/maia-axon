"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
} from "@xyflow/react";
import { ChevronDown, ChevronRight, GraduationCap, Loader2 } from "lucide-react";

import { api } from "@/lib/api";
import type { MindmapSectionNode } from "@/lib/types";

import "@xyflow/react/dist/style.css";

interface CanvasProps {
  documentId: string;
  documentName: string;
  onJumpToPage: (page: number) => void;
  onLearnSection?: (sectionId: string, title: string) => void;
}

interface NodePayload {
  title: string;
  kind: "root" | "topic" | "subtopic" | "headline";
  pageStart: number;
  pageEnd: number;
  sectionId: string | null;
  summary: string | null;
  mastery: number | null;
  // NotebookLM-style expansion state. ``hasChildren`` lets the node
  // renderer draw an expand affordance; ``isExpanded`` toggles the
  // chevron direction. ``childCount`` powers the "+N" hint when the
  // subtree is hidden.
  hasChildren: boolean;
  isExpanded: boolean;
  childCount: number;
  onToggle?: () => void;
  onLearn?: (sectionId: string, title: string) => void;
  [key: string]: unknown;
}

const ROOT_ID = "__book_root__";

// ---------------------------------------------------------------------------
// Visual tuning
// ---------------------------------------------------------------------------

const _LEVEL_X = 320;
const _LEAF_Y = 64;
const _NODE_WIDTH = 240;

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

function visibleLeafCount(node: MindmapSectionNode, expanded: Set<string>): number {
  if (!node.children.length || !expanded.has(node.id)) return 1;
  return node.children.reduce((acc, c) => acc + visibleLeafCount(c, expanded), 0);
}

function rollupMastery(node: MindmapSectionNode): number | null {
  if (node.mastery_score != null) return node.mastery_score;
  if (!node.children.length) return null;
  const scores = node.children
    .map((c) => rollupMastery(c))
    .filter((v): v is number => v != null);
  if (!scores.length) return null;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

function masteryColor(score: number | null): string {
  if (score == null) return "rgba(241,245,249,1)";
  if (score >= 0.85) return "rgba(167,243,208,1)";
  if (score >= 0.65) return "rgba(253,230,138,1)";
  if (score >= 0.35) return "rgba(254,215,170,1)";
  return "rgba(254,205,211,1)";
}

function masteryBorder(score: number | null): string {
  if (score == null) return "rgba(148,163,184,0.6)";
  if (score >= 0.85) return "rgba(5,150,105,0.9)";
  if (score >= 0.65) return "rgba(217,119,6,0.9)";
  if (score >= 0.35) return "rgba(234,88,12,0.9)";
  return "rgba(225,29,72,0.9)";
}

function kindStyle(
  kind: NodePayload["kind"],
  mastery: number | null,
): { background: string; borderColor: string; color: string; borderWidth: number } {
  if (kind === "root") {
    return {
      background: "rgba(42,37,34,1)",
      borderColor: "rgba(42,37,34,1)",
      color: "white",
      borderWidth: 1,
    };
  }
  if (kind === "topic") {
    return {
      background: "rgba(229,229,224,1)",
      borderColor: "rgba(110,103,93,0.7)",
      color: "rgba(31,27,24,1)",
      borderWidth: 1,
    };
  }
  if (kind === "subtopic") {
    return {
      background: "rgba(245,243,238,1)",
      borderColor: "rgba(146,138,128,0.55)",
      color: "rgba(31,27,24,1)",
      borderWidth: 1,
    };
  }
  return {
    background: masteryColor(mastery),
    borderColor: masteryBorder(mastery),
    color: "rgba(31,27,24,1)",
    borderWidth: 2,
  };
}

// ---------------------------------------------------------------------------
// Layout — recursive top-down placement that only renders nodes whose
// ancestor chain is fully expanded. Each rendered node carries the
// expand/collapse state so the renderer can show an affordance.
// ---------------------------------------------------------------------------

interface FlowAccumulator {
  nodes: Node<NodePayload>[];
  edges: Edge[];
}

function layoutSubtree(
  node: MindmapSectionNode,
  depth: number,
  yOffset: number,
  parentId: string,
  expanded: Set<string>,
  acc: FlowAccumulator,
): void {
  const id = node.id;
  const isExpanded = expanded.has(id);
  const hasChildren = node.children.length > 0;
  const renderChildren = hasChildren && isExpanded;
  const leafCount = renderChildren ? visibleLeafCount(node, expanded) : 1;
  const blockHeight = leafCount * _LEAF_Y;
  const centerY = yOffset + blockHeight / 2 - _LEAF_Y / 2;
  const mastery = rollupMastery(node);

  acc.nodes.push({
    id,
    type: "section",
    position: { x: depth * _LEVEL_X, y: centerY },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data: {
      title: node.title,
      kind: (node.kind === "headline" || node.kind === "subtopic" || node.kind === "topic")
        ? node.kind
        : "topic",
      pageStart: node.page_start,
      pageEnd: node.page_end,
      sectionId: id,
      summary: node.summary,
      mastery,
      hasChildren,
      isExpanded,
      childCount: node.children.length,
    },
  });

  acc.edges.push({
    id: `${parentId}->${id}`,
    source: parentId,
    target: id,
    type: "smoothstep",
    style: { stroke: "rgba(110,103,93,0.45)", strokeWidth: 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed, color: "rgba(110,103,93,0.6)" },
  });

  if (renderChildren) {
    let childY = yOffset;
    for (const child of node.children) {
      const childLeaves = visibleLeafCount(child, expanded);
      layoutSubtree(child, depth + 1, childY, id, expanded, acc);
      childY += childLeaves * _LEAF_Y;
    }
  }
}

function buildFlow(
  documentName: string,
  tree: MindmapSectionNode[],
  expanded: Set<string>,
): FlowAccumulator {
  const acc: FlowAccumulator = { nodes: [], edges: [] };
  const rootIsExpanded = expanded.has(ROOT_ID);
  // When the root is collapsed the canvas shows only the book node —
  // that's the "give me one starting point" first frame.
  const visibleTops = rootIsExpanded ? tree : [];

  const totalLeaves =
    visibleTops.reduce((acc, t) => acc + visibleLeafCount(t, expanded), 0) || 1;
  const totalHeight = totalLeaves * _LEAF_Y;

  acc.nodes.push({
    id: ROOT_ID,
    type: "section",
    position: { x: 0, y: totalHeight / 2 - _LEAF_Y / 2 },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data: {
      title: documentName,
      kind: "root",
      pageStart: 1,
      pageEnd: 0,
      sectionId: null,
      summary: null,
      mastery: null,
      hasChildren: tree.length > 0,
      isExpanded: rootIsExpanded,
      childCount: tree.length,
    },
  });

  let y = 0;
  for (const top of visibleTops) {
    const leaves = visibleLeafCount(top, expanded);
    layoutSubtree(top, 1, y, ROOT_ID, expanded, acc);
    y += leaves * _LEAF_Y;
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Node renderer
// ---------------------------------------------------------------------------

function SectionNodeView({ data }: NodeProps<Node<NodePayload>>) {
  const style = kindStyle(data.kind, data.mastery);
  const fontSize =
    data.kind === "root"
      ? 13
      : data.kind === "topic"
        ? 12.5
        : data.kind === "subtopic"
          ? 12
          : 11.5;
  const fontWeight = data.kind === "headline" ? 500 : 600;

  return (
    <div
      style={{
        background: style.background,
        border: `${style.borderWidth}px solid ${style.borderColor}`,
        color: style.color,
        width: _NODE_WIDTH,
        borderRadius: 14,
        padding: "8px 12px",
        boxShadow: "0 4px 12px rgba(17,17,17,0.06)",
        fontSize,
        fontWeight,
        lineHeight: 1.3,
        cursor: data.hasChildren ? "pointer" : "default",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <div className="flex items-start justify-between gap-2">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 9.5,
              textTransform: "uppercase",
              letterSpacing: "0.16em",
              opacity: 0.55,
            }}
          >
            {data.kind === "root" ? "Book" : data.kind}
            {data.kind !== "root" ? ` · p. ${data.pageStart}` : ""}
          </div>
          <div style={{ marginTop: 4, wordBreak: "break-word" }}>{data.title}</div>
          {data.kind === "headline" && data.onLearn && data.sectionId ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                data.onLearn?.(data.sectionId!, data.title);
              }}
              className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-white/85 px-2 py-[1px] text-[10px] font-semibold text-emerald-700 hover:bg-white"
            >
              <GraduationCap className="h-2.5 w-2.5" />
              Learn this
            </button>
          ) : null}
        </div>
        {data.hasChildren ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              data.onToggle?.();
            }}
            title={data.isExpanded ? "Collapse" : `Expand (${data.childCount})`}
            aria-label={data.isExpanded ? "Collapse" : "Expand"}
            style={{
              marginTop: 1,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: 22,
              height: 22,
              borderRadius: 11,
              border: `1px solid ${data.kind === "root" ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.08)"}`,
              background:
                data.kind === "root"
                  ? "rgba(255,255,255,0.12)"
                  : "rgba(255,255,255,0.85)",
              color: data.kind === "root" ? "white" : "rgba(31,27,24,0.7)",
              fontSize: 10,
              fontWeight: 700,
              padding: data.isExpanded ? 0 : "0 6px",
              gap: 2,
              cursor: "pointer",
            }}
          >
            {data.isExpanded ? (
              <ChevronDown style={{ width: 12, height: 12 }} />
            ) : (
              <>
                <ChevronRight style={{ width: 12, height: 12 }} />
                {data.childCount > 0 ? <span>{data.childCount}</span> : null}
              </>
            )}
          </button>
        ) : null}
      </div>
    </div>
  );
}

const nodeTypes = { section: SectionNodeView };

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

function CanvasInner({
  documentId,
  documentName,
  onJumpToPage,
  onLearnSection,
}: CanvasProps) {
  const [tree, setTree] = useState<MindmapSectionNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The set of parent ids whose direct children are visible. We seed
  // with the book root so the first frame shows root + top-level
  // topics. Everything else stays collapsed until the user opens it
  // — same pattern as NotebookLM's mindmap.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([ROOT_ID]));
  const reactFlow = useReactFlow();

  useEffect(() => {
    let cancelled = false;
    setTree(null);
    setError(null);
    setExpanded(new Set([ROOT_ID]));
    api
      .getDocumentSections(documentId)
      .then((data) => {
        if (cancelled) return;
        setTree(data);
      })
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const flow = useMemo(() => {
    if (!tree) return { nodes: [], edges: [] };
    const built = buildFlow(documentName, tree, expanded);
    // Inject runtime handlers via the data payload — keeps the node
    // renderer pure of any store / context plumbing.
    built.nodes = built.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        onToggle: node.data.hasChildren
          ? () => toggle(node.id)
          : undefined,
        onLearn: node.data.kind === "headline" ? onLearnSection : undefined,
      },
    }));
    return built;
  }, [tree, documentName, expanded, onLearnSection, toggle]);

  // Re-fit the viewport whenever the set of visible nodes changes so
  // the user always sees the new layout centred. We use a small
  // duration so it feels like an animation rather than a jump.
  useEffect(() => {
    if (!flow.nodes.length) return;
    const handle = window.requestAnimationFrame(() => {
      reactFlow.fitView({ padding: 0.18, duration: 300 });
    });
    return () => window.cancelAnimationFrame(handle);
  }, [flow.nodes.length, reactFlow]);

  const handleNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      const data = node.data as NodePayload;
      // Clicking a non-leaf toggles its children. Clicking a leaf
      // (headline) jumps the PDF to that section. Clicking the root
      // toggles the entire top level so the user can hide everything
      // and start over.
      if (data.hasChildren) {
        toggle(node.id);
        return;
      }
      if (data.pageStart && data.kind !== "root") {
        onJumpToPage(data.pageStart);
      }
    },
    [onJumpToPage, toggle],
  );

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-warn">{error}</div>
    );
  }
  if (!tree) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-black/55">
        <Loader2 className="h-4 w-4 animate-spin" />
        Building mindmap…
      </div>
    );
  }
  if (!tree.length) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-black/55">
        No section map for this document yet. Run section enrichment first
        (<code>python -m app.cli enrich-document &lt;id&gt;</code>) and reload.
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={flow.nodes}
      edges={flow.edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.18 }}
      nodesDraggable={false}
      nodesConnectable={false}
      panOnScroll
      onNodeClick={handleNodeClick}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={24} color="rgba(148,163,184,0.18)" />
      <Controls position="bottom-right" showInteractive={false} />
    </ReactFlow>
  );
}

export function SectionMindmapCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
