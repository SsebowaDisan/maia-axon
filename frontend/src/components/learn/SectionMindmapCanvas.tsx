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
  // Index into BRANCH_HUES — every non-root node carries the index
  // of the top-level branch it descends from so the renderer can
  // pick the right hue for that whole subtree. ``null`` only on
  // the synthetic book root.
  branchIndex: number | null;
  depth: number; // 0 root, 1 group/topic, 2 subtopic, 3 headline, ...
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

const LEVEL_X = 540;
const LEAF_Y = 80;
const NODE_W = 220;
const NODE_W_ROOT = 240;

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
// Per-branch colour palette. NotebookLM gives each top-level branch
// of the mindmap its own hue and tints all descendants with lighter
// shades of the same colour. We do the same: every top-level node
// (group when grouped, else chapter) picks one hue from this rotating
// palette; its subtree inherits a depth-dependent tint of that hue;
// the edges connecting nodes within the branch use the branch's
// accent colour so the eye can follow a path at a glance.
//
// Hue choice is deterministic by branch position so re-renders stay
// stable. Saturation/lightness curves are tuned so deeper depths
// fade toward white without losing the branch identity.
// ---------------------------------------------------------------------------

interface Theme {
  bg: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  shadow: string;
}

// Hues spread evenly around the wheel + tuned to feel friendly on a
// cream backdrop (skipping aggressive primaries). 8 entries handles
// any reasonable number of top-level branches without colour repeats.
const BRANCH_HUES = [165, 25, 200, 280, 340, 50, 215, 105];

function branchTheme(
  kind: Kind,
  depth: number,
  branchIndex: number | null,
  mastery: number | null,
): Theme {
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
  if (branchIndex == null) {
    // Defensive fallback — should never trigger in practice because
    // every non-root node is assigned a branch by buildFlow.
    return {
      bg: "#f1ebd9",
      border: "rgba(166,156,128,0.4)",
      text: "rgba(31,27,24,0.92)",
      muted: "rgba(89,80,71,0.65)",
      accent: "rgba(110,90,55,0.75)",
      shadow: "0 1px 3px rgba(17,12,8,0.05)",
    };
  }
  const hue = BRANCH_HUES[branchIndex % BRANCH_HUES.length];
  // Depth 1 (group): full branch colour. Each deeper level pulls
  // the lightness toward 96% and trims saturation, so descendant
  // pills feel like a soft echo of their parent.
  const level = depth - 1; // 0-indexed within the branch
  const sat = Math.max(18, 38 - level * 6);
  const light = Math.min(96, 82 + level * 4);
  const bg = `hsl(${hue} ${sat}% ${light}%)`;
  const border = `hsl(${hue} ${Math.min(60, sat + 20)}% ${Math.max(45, light - 30)}% / 0.55)`;
  const muted = `hsl(${hue} 38% 32%)`;
  const accent = `hsl(${hue} 50% 38%)`;
  const text =
    kind === "headline"
      ? "rgba(31,27,24,0.92)"
      : "rgba(31,27,24,0.94)";
  return {
    bg,
    border,
    text,
    muted,
    accent,
    shadow: "0 1px 3px rgba(17,12,8,0.05)",
  };
}

// Edge stroke uses the branch's accent so the line that connects
// "Mechanical components" → "12.1.1 Verluste …" carries the same
// colour as both pills — visually wires the subtree together.
function branchEdgeColor(branchIndex: number | null): string {
  if (branchIndex == null) return "rgba(110,80,40,0.65)";
  const hue = BRANCH_HUES[branchIndex % BRANCH_HUES.length];
  return `hsl(${hue} 50% 50% / 0.7)`;
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
  branchIndex: number,
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
      branchIndex,
      depth,
    },
  });

  acc.edges.push({
    id: `${parentId}->${id}`,
    source: parentId,
    target: id,
    // High-curvature bezier (see SweepEdge) so vertical sibling
    // runs still leave the parent with horizontal tangents and
    // sweep gracefully into the child. Stroke colour matches the
    // branch so the eye can follow a subtree at a glance.
    type: "sweep",
    style: {
      stroke: branchEdgeColor(branchIndex),
      strokeWidth: 1.8,
      strokeLinecap: "round" as const,
    },
  });

  if (renderChildren) {
    let childY = yOffset;
    for (const child of node.children) {
      const childLeaves = visibleLeafCount(child, expanded);
      layoutSubtree(child, depth + 1, childY, id, expanded, acc, branchIndex);
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
      branchIndex: null,
      depth: 0,
    },
  });

  // Each top-level child gets its own branch index. Children
  // inherit the parent's index, so a whole subtree shares a hue.
  let y = 0;
  tops.forEach((top, idx) => {
    const leaves = visibleLeafCount(top, expanded);
    layoutSubtree(
      top,
      1,
      y,
      ROOT_ID,
      expanded,
      acc,
      idx,
      topsAreGroups ? "group" : undefined,
    );
    y += leaves * LEAF_Y;
  });
  return acc;
}

// ---------------------------------------------------------------------------
// Node renderer
// ---------------------------------------------------------------------------

function SectionNodeView({ data }: NodeProps<Node<NodePayload>>) {
  const t = branchTheme(data.kind, data.depth, data.branchIndex, data.mastery);
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
        borderRadius: 10,
        padding: "8px 12px",
        boxShadow: t.shadow,
        position: "relative",
        cursor: data.hasChildren ? "pointer" : data.kind === "headline" ? "pointer" : "default",
        display: "flex",
        alignItems: "center",
        gap: 8,
        minHeight: 44,
        transition: "background 100ms ease, border-color 100ms ease",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0, width: 1, height: 1 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0, width: 1, height: 1 }} />

      {/* Two-line title with ellipsis. Narrower pills mean German
          titles like "System performance and pressure management"
          need to wrap; the 2-line clamp keeps them readable while
          capping pill height at a predictable value. */}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: isRoot ? 12.5 : data.kind === "group" ? 12 : 11.5,
          fontWeight: isRoot ? 700 : data.kind === "group" ? 600 : 500,
          lineHeight: 1.35,
          letterSpacing: "-0.005em",
          color: t.text,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          wordBreak: "break-word",
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
  // Curvature must stay strictly below 0.5 — at 0.5 both control
  // points land on the midpoint, and anything above causes the
  // source control to overshoot past the target control. That
  // crossover is why my earlier 0.55 setting collapsed every curve
  // into a vertical-ish band at the parent's edge. 0.4 gives a
  // pronounced sweep without the artefact.
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.4,
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
  //
  // minZoom is capped at 0.75 on purpose: when a parent has many
  // siblings (the German book has 58 chapters), letting fitView
  // zoom out to 0.3 squashes every pill together and the user
  // can't read anything. Instead we keep a comfortable zoom and
  // let them scroll/pan — same pattern as NotebookLM.
  useEffect(() => {
    if (!flow.nodes.length) return;
    const handle = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        reactFlow.fitView({ padding: 0.15, duration: 320, minZoom: 0.75, maxZoom: 1.0 });
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
    <div
      style={{ position: "relative", width: "100%", height: "100%" }}
      className="learn-mindmap-canvas"
    >
      {/* Override ReactFlow's default node-wrapper styling so each pill
          renders directly on the canvas rather than inside a white card.
          ReactFlow ships a baseline background/border/shadow on
          ``.react-flow__node`` that's only appropriate for the built-in
          node types; we want the pill's branch colour to be the only
          fill the user sees. */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
            .learn-mindmap-canvas .react-flow__node {
              background: transparent !important;
              border: none !important;
              padding: 0 !important;
              border-radius: 0 !important;
              box-shadow: none !important;
              width: auto !important;
            }
            .learn-mindmap-canvas .react-flow__node.selected,
            .learn-mindmap-canvas .react-flow__node:focus,
            .learn-mindmap-canvas .react-flow__node:focus-visible {
              box-shadow: none !important;
              outline: none !important;
            }
          `,
        }}
      />
      <ReactFlow
        nodes={flow.nodes}
        edges={flow.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.15, minZoom: 0.75, maxZoom: 1.0 }}
        nodesDraggable={false}
        nodesConnectable={false}
        panOnScroll
        onNodeClick={handleNodeClick}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{
          type: "sweep",
          style: {
            stroke: "rgba(110,80,40,0.7)",
            strokeWidth: 1.8,
            strokeLinecap: "round" as const,
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
