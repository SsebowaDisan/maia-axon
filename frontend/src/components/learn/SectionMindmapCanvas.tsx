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
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
} from "@xyflow/react";
import { GraduationCap, Loader2 } from "lucide-react";

import { api } from "@/lib/api";
import type { MindmapSectionNode } from "@/lib/types";

import "@xyflow/react/dist/style.css";

interface CanvasProps {
  documentId: string;
  documentName: string;
  onJumpToPage: (page: number) => void;
  onLearnSection?: (sectionId: string, title: string) => void;
}

// ReactFlow's Node generic requires the data type to be assignable to
// Record<string, unknown>; add an index signature so our specific
// payload types satisfy that constraint without losing strong typing
// on the named fields.
interface NodePayload {
  title: string;
  kind: "root" | "topic" | "subtopic" | "headline";
  pageStart: number;
  pageEnd: number;
  sectionId: string | null;
  summary: string | null;
  mastery: number | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Layout: recursive hierarchical layout (book on the left, branches grow
// rightward). Each node's vertical span is proportional to the leaf count
// of its subtree, so siblings stack without overlap regardless of how
// unbalanced the tree is.
// ---------------------------------------------------------------------------

const _LEVEL_X = 320;       // horizontal gap between levels
const _LEAF_Y = 56;         // vertical gap between leaves
const _NODE_WIDTH = 240;    // node width (used for handle anchoring math)

function countLeaves(node: MindmapSectionNode): number {
  if (!node.children.length) return 1;
  return node.children.reduce((acc, child) => acc + countLeaves(child), 0);
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
  if (score == null) return "rgba(241,245,249,1)"; // slate-100
  if (score >= 0.85) return "rgba(167,243,208,1)"; // emerald-200
  if (score >= 0.65) return "rgba(253,230,138,1)"; // amber-200
  if (score >= 0.35) return "rgba(254,215,170,1)"; // orange-200
  return "rgba(254,205,211,1)"; // rose-200
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
  // headline — mastery colour drives the fill
  return {
    background: masteryColor(mastery),
    borderColor: masteryBorder(mastery),
    color: "rgba(31,27,24,1)",
    borderWidth: 2,
  };
}

interface FlowAccumulator {
  nodes: Node<NodePayload>[];
  edges: Edge[];
}

function layoutSubtree(
  node: MindmapSectionNode,
  depth: number,
  yOffset: number,
  parentId: string | null,
  acc: FlowAccumulator,
  collapsed: Set<string>,
): number {
  const id = node.id;
  const isLeaf = !node.children.length || collapsed.has(id);
  const mastery = rollupMastery(node);
  const leafCount = isLeaf ? 1 : countLeaves(node);
  const blockHeight = leafCount * _LEAF_Y;

  const centerY = yOffset + blockHeight / 2 - _LEAF_Y / 2;
  acc.nodes.push({
    id,
    type: "section",
    position: { x: depth * _LEVEL_X, y: centerY },
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
    },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  });

  if (parentId) {
    acc.edges.push({
      id: `${parentId}->${id}`,
      source: parentId,
      target: id,
      type: "smoothstep",
      style: { stroke: "rgba(110,103,93,0.45)", strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "rgba(110,103,93,0.6)" },
    });
  }

  if (!isLeaf) {
    let childY = yOffset;
    for (const child of node.children) {
      const childLeaves = countLeaves(child);
      layoutSubtree(child, depth + 1, childY, id, acc, collapsed);
      childY += childLeaves * _LEAF_Y;
    }
  }

  return blockHeight;
}

function buildFlow(
  documentName: string,
  tree: MindmapSectionNode[],
  collapsed: Set<string>,
): FlowAccumulator {
  const acc: FlowAccumulator = { nodes: [], edges: [] };
  const totalLeaves =
    tree.reduce((acc, t) => acc + countLeaves(t), 0) || 1;
  const totalHeight = totalLeaves * _LEAF_Y;
  const rootId = "__book_root__";

  acc.nodes.push({
    id: rootId,
    type: "section",
    position: { x: 0, y: totalHeight / 2 - _LEAF_Y / 2 },
    data: {
      title: documentName,
      kind: "root",
      pageStart: 1,
      pageEnd: 0,
      sectionId: null,
      summary: null,
      mastery: null,
    },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  });

  let y = 0;
  for (const top of tree) {
    const leaves = countLeaves(top);
    layoutSubtree(top, 1, y, rootId, acc, collapsed);
    y += leaves * _LEAF_Y;
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Custom node renderer — gives us pill-shaped nodes with mastery indicator,
// page-range badge, and a learn-this action that NotebookLM-style mindmaps
// also lean on (click a node to drill into the source).
// ---------------------------------------------------------------------------

interface SectionNodeData extends NodePayload {
  onLearn?: (sectionId: string, title: string) => void;
}

function SectionNodeView({ data }: NodeProps<Node<SectionNodeData>>) {
  const style = kindStyle(data.kind, data.mastery);
  const showHandles = data.kind !== "root" ? true : true;
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
      }}
    >
      {showHandles ? (
        <>
          <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
          <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
        </>
      ) : null}
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
  // Track which non-leaf nodes the user collapsed. Lets the user
  // tame a wide subtree the same way notebook-style mindmaps do.
  const [collapsed, _setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setTree(null);
    setError(null);
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

  const flow = useMemo(() => {
    if (!tree) return { nodes: [], edges: [] };
    const built = buildFlow(documentName, tree, collapsed);
    // Inject the onLearn handler into headline nodes via data.
    built.nodes = built.nodes.map((node) =>
      node.data.kind === "headline"
        ? ({ ...node, data: { ...node.data, onLearn: onLearnSection } } as Node<SectionNodeData>)
        : node,
    ) as Node<NodePayload>[];
    return built;
  }, [tree, documentName, collapsed, onLearnSection]);

  const handleNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      const data = node.data as NodePayload;
      if (data.pageStart && data.kind !== "root") {
        onJumpToPage(data.pageStart);
      }
    },
    [onJumpToPage],
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
      fitViewOptions={{ padding: 0.15 }}
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
