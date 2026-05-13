"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getNodesBounds,
  getViewportForBounds,
  useReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
} from "@xyflow/react";
import { toPng } from "html-to-image";
import { ChevronRight, Download, GraduationCap, Loader2, Minus } from "lucide-react";

import { api } from "@/lib/api";
import type { MindmapSectionNode } from "@/lib/types";

import "@xyflow/react/dist/style.css";

interface CanvasProps {
  documentId: string;
  documentName: string;
  onJumpToPage: (page: number) => void;
  onLearnSection?: (sectionId: string, title: string) => void;
}

type Kind = "root" | "topic" | "subtopic" | "headline";

interface NodePayload {
  title: string;
  kind: Kind;
  pageStart: number;
  pageEnd: number;
  sectionId: string | null;
  summary: string | null;
  mastery: number | null;
  hasChildren: boolean;
  isExpanded: boolean;
  childCount: number;
  onToggle?: () => void;
  onLearn?: (sectionId: string, title: string) => void;
  [key: string]: unknown;
}

const ROOT_ID = "__book_root__";

// ---------------------------------------------------------------------------
// Visual tuning — generous spacing so curved edges have room to breathe.
// ---------------------------------------------------------------------------

const LEVEL_X = 360;
const LEAF_Y = 96;
const NODE_W = 280;
const NODE_W_ROOT = 320;

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

// ---------------------------------------------------------------------------
// Per-kind visual themes. Each kind gets a coherent (background,
// border, text, accent) palette so the tree reads at a glance.
// ---------------------------------------------------------------------------

interface Theme {
  bg: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  shadow: string;
}

function masteryAccent(score: number | null): string {
  if (score == null) return "rgba(110,103,93,0.6)";
  if (score >= 0.85) return "rgba(5,150,105,0.9)";
  if (score >= 0.65) return "rgba(217,119,6,0.9)";
  if (score >= 0.35) return "rgba(234,88,12,0.9)";
  return "rgba(225,29,72,0.9)";
}

function themeFor(kind: Kind, mastery: number | null): Theme {
  if (kind === "root") {
    return {
      bg: "linear-gradient(180deg, #2a2522 0%, #1a1614 100%)",
      border: "rgba(255,255,255,0.08)",
      text: "rgba(255,255,255,0.96)",
      muted: "rgba(255,255,255,0.6)",
      accent: "rgba(255,250,235,0.92)",
      shadow: "0 18px 40px rgba(17,12,8,0.28), 0 2px 4px rgba(17,12,8,0.18)",
    };
  }
  if (kind === "topic") {
    return {
      bg: "linear-gradient(180deg, #faf8f3 0%, #f1ede2 100%)",
      border: "rgba(146,138,128,0.32)",
      text: "rgba(31,27,24,0.94)",
      muted: "rgba(89,80,71,0.7)",
      accent: "rgba(110,80,55,0.85)",
      shadow: "0 8px 22px rgba(17,12,8,0.08), 0 1px 2px rgba(17,12,8,0.05)",
    };
  }
  if (kind === "subtopic") {
    return {
      bg: "#ffffff",
      border: "rgba(166,156,142,0.32)",
      text: "rgba(31,27,24,0.92)",
      muted: "rgba(89,80,71,0.65)",
      accent: "rgba(110,80,55,0.7)",
      shadow: "0 6px 16px rgba(17,12,8,0.07), 0 1px 2px rgba(17,12,8,0.04)",
    };
  }
  return {
    bg: "#ffffff",
    border: masteryAccent(mastery),
    text: "rgba(31,27,24,0.92)",
    muted: "rgba(89,80,71,0.65)",
    accent: masteryAccent(mastery),
    shadow: "0 6px 16px rgba(17,12,8,0.08), 0 1px 2px rgba(17,12,8,0.05)",
  };
}

function kindLabel(kind: Kind): string {
  if (kind === "root") return "Book";
  if (kind === "topic") return "Chapter";
  if (kind === "subtopic") return "Section";
  return "Sub-section";
}

// ---------------------------------------------------------------------------
// Layout
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
  const blockHeight = leafCount * LEAF_Y;
  const centerY = yOffset + blockHeight / 2 - LEAF_Y / 2;
  const mastery = rollupMastery(node);
  const resolvedKind: Kind =
    node.kind === "headline" || node.kind === "subtopic" || node.kind === "topic"
      ? node.kind
      : "topic";

  acc.nodes.push({
    id,
    type: "section",
    position: { x: depth * LEVEL_X, y: centerY },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data: {
      title: node.title,
      kind: resolvedKind,
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
    // Soft bezier curves instead of orthogonal smoothstep — feels
    // organic and avoids the T-junction look that smoothstep produces
    // when many siblings share a parent.
    type: "default",
    style: {
      stroke: "rgba(146,138,128,0.55)",
      strokeWidth: 1.6,
      strokeLinecap: "round" as const,
    },
  });

  if (renderChildren) {
    let childY = yOffset;
    for (const child of node.children) {
      const childLeaves = visibleLeafCount(child, expanded);
      layoutSubtree(child, depth + 1, childY, id, expanded, acc);
      childY += childLeaves * LEAF_Y;
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
  const visibleTops = rootIsExpanded ? tree : [];

  const totalLeaves =
    visibleTops.reduce((acc, t) => acc + visibleLeafCount(t, expanded), 0) || 1;
  const totalHeight = totalLeaves * LEAF_Y;

  acc.nodes.push({
    id: ROOT_ID,
    type: "section",
    position: { x: 0, y: totalHeight / 2 - LEAF_Y / 2 },
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
    y += leaves * LEAF_Y;
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Node renderer
// ---------------------------------------------------------------------------

function SectionNodeView({ data }: NodeProps<Node<NodePayload>>) {
  const t = themeFor(data.kind, data.mastery);
  const isRoot = data.kind === "root";
  const width = isRoot ? NODE_W_ROOT : NODE_W;

  return (
    <div
      style={{
        background: t.bg,
        border: `1px solid ${t.border}`,
        color: t.text,
        width,
        borderRadius: 18,
        padding: isRoot ? "14px 16px" : "12px 14px",
        boxShadow: t.shadow,
        position: "relative",
        cursor: data.hasChildren ? "pointer" : "default",
        transition: "transform 120ms ease, box-shadow 120ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-1px)";
        e.currentTarget.style.boxShadow = t.shadow.replace(/0\.\d+/g, (m) => {
          const v = parseFloat(m);
          return Math.min(0.95, v + 0.04).toFixed(2);
        });
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow = t.shadow;
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0, width: 1, height: 1 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0, width: 1, height: 1 }} />

      {/* Tiny kind label up top — small caps, low contrast, gentle. */}
      <div
        style={{
          fontSize: 9.5,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.14em",
          color: t.muted,
          marginBottom: 6,
        }}
      >
        {kindLabel(data.kind)}
      </div>

      {/* Title — clamps to three lines with ellipsis so long German
          subtitles don't blow the layout. */}
      <div
        style={{
          fontSize: isRoot ? 16 : data.kind === "topic" ? 14 : 13,
          fontWeight: isRoot ? 700 : data.kind === "headline" ? 500 : 600,
          lineHeight: 1.35,
          letterSpacing: "-0.005em",
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          color: t.text,
        }}
      >
        {data.title}
      </div>

      {/* Footer: page-range pill + expand affordance. */}
      <div
        style={{
          marginTop: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        {data.kind !== "root" ? (
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              color: t.muted,
              background: "rgba(0,0,0,0.04)",
              padding: "2px 8px",
              borderRadius: 999,
              letterSpacing: "0.02em",
            }}
          >
            p. {data.pageStart}
            {data.pageEnd && data.pageEnd !== data.pageStart ? `–${data.pageEnd}` : ""}
          </span>
        ) : (
          <span style={{ fontSize: 11, color: t.muted, fontWeight: 500 }}>
            {data.childCount} {data.childCount === 1 ? "chapter" : "chapters"}
          </span>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {data.kind === "headline" && data.onLearn && data.sectionId ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                data.onLearn?.(data.sectionId!, data.title);
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                background: "rgba(5,150,105,0.12)",
                color: "rgb(4,120,87)",
                border: "1px solid rgba(5,150,105,0.22)",
                padding: "2px 8px",
                borderRadius: 999,
                fontSize: 10.5,
                fontWeight: 600,
                cursor: "pointer",
              }}
              title="Start learning this section"
            >
              <GraduationCap style={{ width: 11, height: 11 }} />
              Learn
            </button>
          ) : null}

          {data.hasChildren ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                data.onToggle?.();
              }}
              title={data.isExpanded ? "Collapse" : `Expand · ${data.childCount}`}
              aria-label={data.isExpanded ? "Collapse" : "Expand"}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                height: 22,
                minWidth: 22,
                padding: data.isExpanded ? 0 : "0 7px",
                borderRadius: 999,
                background: isRoot
                  ? "rgba(255,255,255,0.12)"
                  : `${t.accent.replace("rgba(", "rgba(").replace(/[\d.]+\)$/, "0.10)")}`,
                border: `1px solid ${
                  isRoot ? "rgba(255,255,255,0.18)" : "rgba(0,0,0,0.08)"
                }`,
                color: isRoot ? "rgba(255,255,255,0.95)" : t.accent,
                fontSize: 10,
                fontWeight: 700,
                cursor: "pointer",
                transition: "background 100ms ease",
              }}
            >
              {data.isExpanded ? (
                <Minus style={{ width: 12, height: 12 }} />
              ) : (
                <>
                  <ChevronRight style={{ width: 12, height: 12 }} />
                  <span>{data.childCount}</span>
                </>
              )}
            </button>
          ) : null}
        </div>
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
    built.nodes = built.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        onToggle: node.data.hasChildren ? () => toggle(node.id) : undefined,
        onLearn: node.data.kind === "headline" ? onLearnSection : undefined,
      },
    }));
    return built;
  }, [tree, documentName, expanded, onLearnSection, toggle]);

  // Re-fit the viewport whenever the set of visible nodes changes.
  // We delay one frame so ReactFlow has measured the new layout
  // before computing the fit — otherwise the first frame after open
  // would fit-to-an-empty-set and the root ended up off-screen.
  useEffect(() => {
    if (!flow.nodes.length) return;
    const handle = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        reactFlow.fitView({ padding: 0.2, duration: 320, minZoom: 0.3, maxZoom: 1.2 });
      });
    });
    return () => window.cancelAnimationFrame(handle);
  }, [flow.nodes.length, flow.nodes.map((n) => n.id).join(","), reactFlow]);

  const handleNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      const data = node.data as NodePayload;
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

  const [downloading, setDownloading] = useState(false);

  const handleDownload = useCallback(async () => {
    // Capture the *whole* mindmap, not just what's visible in the
    // viewport. We compute the bounding box around all rendered
    // nodes, then ask html-to-image to render at that size with
    // a transform that fits the bounds, padded slightly. Pixel
    // ratio 2 keeps text crisp on retina screens / when the user
    // opens the PNG fullscreen.
    if (!flow.nodes.length) return;
    setDownloading(true);
    try {
      const viewportEl = document.querySelector<HTMLElement>(
        ".react-flow__viewport",
      );
      if (!viewportEl) return;
      const padding = 80;
      const bounds = getNodesBounds(flow.nodes);
      const width = Math.ceil(bounds.width + padding * 2);
      const height = Math.ceil(bounds.height + padding * 2);
      const viewport = getViewportForBounds(
        bounds,
        width,
        height,
        0.1,
        2,
        0,
      );
      const dataUrl = await toPng(viewportEl, {
        backgroundColor: "#f7f6f2",
        width,
        height,
        pixelRatio: 2,
        style: {
          width: `${width}px`,
          height: `${height}px`,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
        },
      });
      const safeName = documentName
        .replace(/\.[a-z0-9]+$/i, "")
        .replace(/[^a-z0-9-_\s]+/gi, "")
        .trim()
        .replace(/\s+/g, "_")
        .slice(0, 80) || "mindmap";
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `mindmap-${safeName}.png`;
      a.click();
    } catch (err) {
      // Surface failure in console — most likely cause is a CORS
      // taint when the page also embeds remote images. The mindmap
      // canvas itself uses only local DOM nodes so this is rare.
      // eslint-disable-next-line no-console
      console.error("Mindmap export failed:", err);
    } finally {
      setDownloading(false);
    }
  }, [flow.nodes, documentName]);

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
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <ReactFlow
        nodes={flow.nodes}
        edges={flow.edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2, minZoom: 0.3, maxZoom: 1.2 }}
        nodesDraggable={false}
        nodesConnectable={false}
        panOnScroll
        onNodeClick={handleNodeClick}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{
          type: "default",
          style: {
            stroke: "rgba(146,138,128,0.55)",
            strokeWidth: 1.6,
          },
        }}
        style={{
          background:
            "radial-gradient(circle at 20% 0%, rgba(244,239,228,0.85) 0%, rgba(244,239,228,0) 60%), #f7f6f2",
        }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={28}
          size={1.2}
          color="rgba(146,138,128,0.35)"
        />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>
      <button
        type="button"
        onClick={handleDownload}
        disabled={downloading || !flow.nodes.length}
        title="Download mindmap as PNG"
        aria-label="Download mindmap as PNG"
        style={{
          position: "absolute",
          top: 12,
          right: 12,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          borderRadius: 999,
          background: "rgba(255,255,255,0.92)",
          border: "1px solid rgba(0,0,0,0.08)",
          boxShadow: "0 4px 12px rgba(17,12,8,0.08)",
          color: "rgba(31,27,24,0.85)",
          fontSize: 12,
          fontWeight: 600,
          cursor: downloading ? "wait" : "pointer",
          opacity: downloading || !flow.nodes.length ? 0.65 : 1,
        }}
      >
        {downloading ? (
          <Loader2 style={{ width: 13, height: 13 }} className="animate-spin" />
        ) : (
          <Download style={{ width: 13, height: 13 }} />
        )}
        {downloading ? "Saving…" : "Download"}
      </button>
    </div>
  );
}

export function SectionMindmapCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
