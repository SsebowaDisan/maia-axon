"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BaseEdge,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  getNodesBounds,
  getViewportForBounds,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
} from "@xyflow/react";
import { toPng } from "html-to-image";
import { ChevronRight, Download, GraduationCap, Loader2, Minus } from "lucide-react";

import { api } from "@/lib/api";
import type { MindmapChapterGroup, MindmapSectionNode } from "@/lib/types";

import "@xyflow/react/dist/style.css";

interface CanvasProps {
  documentId: string;
  documentName: string;
  onJumpToPage: (page: number) => void;
  onLearnSection?: (sectionId: string, title: string) => void;
}

type Kind = "root" | "group" | "topic" | "subtopic" | "headline";

// Synthetic node inserted between the book root and its chapters
// when thematic groups exist. ``id`` is a deterministic local key
// (not a section uuid).
interface SyntheticGroup {
  id: string;
  name: string;
  rationale: string;
  children: MindmapSectionNode[];
}

function buildGroupedTree(
  tree: MindmapSectionNode[],
  groups: MindmapChapterGroup[],
): { groups: SyntheticGroup[]; ungrouped: MindmapSectionNode[] } | null {
  if (!groups.length) return null;
  const byId = new Map(tree.map((node) => [node.id, node] as const));
  const used = new Set<string>();
  const out: SyntheticGroup[] = [];
  groups.forEach((g, idx) => {
    const children = g.section_ids
      .map((sid) => byId.get(sid))
      .filter((n): n is MindmapSectionNode => !!n);
    if (!children.length) return;
    children.forEach((c) => used.add(c.id));
    out.push({
      id: `__group_${idx}__`,
      name: g.name,
      rationale: g.rationale,
      children,
    });
  });
  // Any chapter the LLM forgot to assign falls into a residual
  // "Other" group so it doesn't disappear from the tree.
  const ungrouped = tree.filter((n) => !used.has(n.id));
  if (ungrouped.length) {
    out.push({
      id: "__group_other__",
      name: "Other",
      rationale: "Chapters that didn't fit the main thematic groups.",
      children: ungrouped,
    });
  }
  return { groups: out, ungrouped: [] };
}

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
// Visual tuning — copies the NotebookLM / genealogy-mindmap layout:
// long horizontal sweeps between levels so the bezier curves get the
// room to bend gracefully, with comparatively tight vertical stacking.
// ---------------------------------------------------------------------------

const LEVEL_X = 460;
const LEAF_Y = 44;
const NODE_W = 300;
const NODE_W_ROOT = 320;

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

function visibleLeafCount(node: MindmapSectionNode, expanded: Set<string>): number {
  if (!node.children.length || !expanded.has(node.id)) return 1;
  return node.children.reduce((acc, c) => acc + visibleLeafCount(c, expanded), 0);
}

// Wrap a synthetic group as a MindmapSectionNode-shaped object so
// the existing layout walks it transparently. The fake kind is
// validated downstream via the buildFlow ``isGroup`` predicate.
function groupAsSectionNode(g: SyntheticGroup): MindmapSectionNode {
  return {
    id: g.id,
    kind: "topic", // placeholder — overridden to "group" in buildFlow
    title: g.name,
    page_start: g.children[0]?.page_start ?? 0,
    page_end: g.children[g.children.length - 1]?.page_end ?? 0,
    ordinal: 0,
    summary: g.rationale,
    concept_ids: [],
    mastery_score: null,
    children: g.children,
  };
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
  // Compact-pill mindmap: each level has a distinct fill that reads at
  // a glance without needing a text label on the node. Shadows are
  // intentionally subtle — the pills sit on the canvas, they don't
  // hover above it. Edges remain the primary visual structure.
  if (kind === "root") {
    return {
      bg: "#2a2522",
      border: "rgba(0,0,0,0.18)",
      text: "rgba(255,255,255,0.96)",
      muted: "rgba(255,255,255,0.6)",
      accent: "rgba(255,250,235,0.92)",
      shadow: "0 2px 6px rgba(17,12,8,0.12)",
    };
  }
  if (kind === "group") {
    return {
      bg: "#f3e6c9",
      border: "rgba(166,124,73,0.42)",
      text: "rgba(78,52,22,0.94)",
      muted: "rgba(110,80,40,0.7)",
      accent: "rgba(166,124,73,0.95)",
      shadow: "0 1px 3px rgba(78,52,22,0.06)",
    };
  }
  if (kind === "topic") {
    return {
      bg: "#e9e3d1",
      border: "rgba(146,128,90,0.38)",
      text: "rgba(31,27,24,0.94)",
      muted: "rgba(89,80,71,0.7)",
      accent: "rgba(110,90,55,0.85)",
      shadow: "0 1px 3px rgba(17,12,8,0.05)",
    };
  }
  if (kind === "subtopic") {
    return {
      bg: "#f1ebd9",
      border: "rgba(166,156,128,0.38)",
      text: "rgba(31,27,24,0.92)",
      muted: "rgba(89,80,71,0.65)",
      accent: "rgba(110,90,55,0.75)",
      shadow: "0 1px 3px rgba(17,12,8,0.04)",
    };
  }
  // headline — mastery-tinted soft fill (always readable)
  return {
    bg: "#ffffff",
    border: masteryAccent(mastery),
    text: "rgba(31,27,24,0.92)",
    muted: "rgba(89,80,71,0.65)",
    accent: masteryAccent(mastery),
    shadow: "0 1px 3px rgba(17,12,8,0.06)",
  };
}

function kindLabel(kind: Kind): string {
  if (kind === "root") return "Book";
  if (kind === "group") return "Theme";
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
  forceKind?: Kind,
): void {
  const id = node.id;
  const isExpanded = expanded.has(id);
  const hasChildren = node.children.length > 0;
  const renderChildren = hasChildren && isExpanded;
  const leafCount = renderChildren ? visibleLeafCount(node, expanded) : 1;
  const blockHeight = leafCount * LEAF_Y;
  const centerY = yOffset + blockHeight / 2 - LEAF_Y / 2;
  const mastery = rollupMastery(node);
  const resolvedKind: Kind = forceKind
    ? forceKind
    : node.kind === "headline" || node.kind === "subtopic" || node.kind === "topic"
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
    // High-curvature bezier (see SweepEdge) so vertical sibling
    // runs still leave the parent with horizontal tangents and
    // sweep gracefully into the child.
    type: "sweep",
    style: {
      stroke: "rgba(110,90,55,0.45)",
      strokeWidth: 1.4,
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
  syntheticGroups: SyntheticGroup[] | null,
): FlowAccumulator {
  const acc: FlowAccumulator = { nodes: [], edges: [] };
  const rootIsExpanded = expanded.has(ROOT_ID);

  // When thematic groups exist, the top level of the tree becomes
  // those synthetic group nodes; chapters live one level deeper.
  // Without groups we fall back to the flat Book → Chapter layout.
  const tops: MindmapSectionNode[] = rootIsExpanded
    ? syntheticGroups && syntheticGroups.length > 0
      ? syntheticGroups.map(groupAsSectionNode)
      : tree
    : [];

  const topsAreGroups =
    rootIsExpanded && !!syntheticGroups && syntheticGroups.length > 0;

  const totalLeaves =
    tops.reduce((acc, t) => acc + visibleLeafCount(t, expanded), 0) || 1;
  const totalHeight = totalLeaves * LEAF_Y;

  const rootChildCount = topsAreGroups
    ? syntheticGroups!.length
    : tree.length;

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
      hasChildren: rootChildCount > 0,
      isExpanded: rootIsExpanded,
      childCount: rootChildCount,
    },
  });

  let y = 0;
  for (const top of tops) {
    const leaves = visibleLeafCount(top, expanded);
    layoutSubtree(
      top,
      1,
      y,
      ROOT_ID,
      expanded,
      acc,
      topsAreGroups ? "group" : undefined,
    );
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
  const titleTooltip =
    data.kind === "root"
      ? `${data.title} (${data.childCount} ${data.childCount === 1 ? "theme" : "themes"})`
      : `${data.title} · pp. ${data.pageStart}${
          data.pageEnd && data.pageEnd !== data.pageStart ? `–${data.pageEnd}` : ""
        }`;

  return (
    <div
      title={titleTooltip}
      style={{
        background: t.bg,
        border: `1px solid ${t.border}`,
        color: t.text,
        width,
        borderRadius: 8,
        padding: "3px 10px",
        boxShadow: t.shadow,
        position: "relative",
        cursor: data.hasChildren ? "pointer" : data.kind === "headline" ? "pointer" : "default",
        display: "flex",
        alignItems: "center",
        gap: 6,
        minHeight: 24,
        transition: "background 100ms ease, border-color 100ms ease",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0, width: 1, height: 1 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0, width: 1, height: 1 }} />

      {/* Single-line title with ellipsis. Color codes the level so
          we don't need a "TOPIC · P. 13" label cluttering the pill. */}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: isRoot ? 12.5 : data.kind === "group" ? 12 : 11.5,
          fontWeight: isRoot ? 700 : data.kind === "group" ? 600 : 500,
          lineHeight: 1.3,
          letterSpacing: "-0.005em",
          color: t.text,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {data.title}
      </span>

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
            gap: 2,
            height: 18,
            minWidth: 18,
            padding: data.isExpanded ? 0 : "0 5px",
            borderRadius: 999,
            background: isRoot
              ? "rgba(255,255,255,0.16)"
              : "rgba(0,0,0,0.05)",
            border: `1px solid ${isRoot ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.07)"}`,
            color: isRoot ? "rgba(255,255,255,0.92)" : t.accent,
            fontSize: 9.5,
            fontWeight: 700,
            flexShrink: 0,
            cursor: "pointer",
          }}
        >
          {data.isExpanded ? (
            <Minus style={{ width: 10, height: 10 }} />
          ) : (
            <>
              <ChevronRight style={{ width: 10, height: 10 }} />
              <span>{data.childCount}</span>
            </>
          )}
        </button>
      ) : data.kind === "headline" && data.onLearn && data.sectionId ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            data.onLearn?.(data.sectionId!, data.title);
          }}
          title="Start learning this section"
          aria-label="Start learning this section"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            height: 18,
            width: 18,
            borderRadius: 999,
            background: "rgba(5,150,105,0.14)",
            color: "rgb(4,120,87)",
            border: "1px solid rgba(5,150,105,0.22)",
            flexShrink: 0,
            cursor: "pointer",
          }}
        >
          <GraduationCap style={{ width: 10, height: 10 }} />
        </button>
      ) : null}
    </div>
  );
}

const nodeTypes = { section: SectionNodeView };

// ---------------------------------------------------------------------------
// Custom edge — high-curvature bezier so the curves leave the parent
// horizontally and sweep gracefully into the child, matching the
// long-arc S-curves in NotebookLM / genealogy-style mindmaps. The
// default ReactFlow curvature (0.25) makes nearly-vertical sibling
// runs look orthogonal instead of curvy; 0.55 pulls the control
// points out further so the tangents stay horizontal at each end.
// ---------------------------------------------------------------------------

function SweepEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  style,
  markerEnd,
}: EdgeProps) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.55,
  });
  return <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />;
}

const edgeTypes = { sweep: SweepEdge };

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
  const [chapterGroups, setChapterGroups] = useState<MindmapChapterGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([ROOT_ID]));
  const reactFlow = useReactFlow();

  useEffect(() => {
    let cancelled = false;
    setTree(null);
    setChapterGroups([]);
    setError(null);
    setExpanded(new Set([ROOT_ID]));
    // Fetch sections + groups in parallel; groups are optional, so a
    // 404 / empty list there should not block the mindmap.
    Promise.all([
      api.getDocumentSections(documentId),
      api.getDocumentChapterGroups(documentId).catch(() => [] as MindmapChapterGroup[]),
    ])
      .then(([sections, groups]) => {
        if (cancelled) return;
        setTree(sections);
        setChapterGroups(groups);
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

  // Group splicing — if the backend produced chapter groups, render
  // them as a synthetic layer between root and chapters. Otherwise
  // fall back to the flat Book → Chapter tree.
  const synthetic = useMemo(
    () => (tree ? buildGroupedTree(tree, chapterGroups) : null),
    [tree, chapterGroups],
  );

  const flow = useMemo(() => {
    if (!tree) return { nodes: [], edges: [] };
    const built = buildFlow(
      documentName,
      tree,
      expanded,
      synthetic ? synthetic.groups : null,
    );
    built.nodes = built.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        onToggle: node.data.hasChildren ? () => toggle(node.id) : undefined,
        onLearn: node.data.kind === "headline" ? onLearnSection : undefined,
      },
    }));
    return built;
  }, [tree, synthetic, documentName, expanded, onLearnSection, toggle]);

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
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.2, minZoom: 0.3, maxZoom: 1.2 }}
        nodesDraggable={false}
        nodesConnectable={false}
        panOnScroll
        onNodeClick={handleNodeClick}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{
          type: "sweep",
          style: {
            stroke: "rgba(110,90,55,0.45)",
            strokeWidth: 1.4,
          },
        }}
        style={{
          background: "#faf8f3",
        }}
      >
        {/* Very faint dot grid — visible at high zoom for orientation
            but invisible from typical fit-view distance, matching the
            reference's clean flat backdrop. */}
        <Background
          variant={BackgroundVariant.Dots}
          gap={32}
          size={0.8}
          color="rgba(146,138,128,0.20)"
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
