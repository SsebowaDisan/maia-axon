"use client";

import { useMemo } from "react";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";

import type { Citation, MindmapNode } from "@/lib/types";
import { useDocumentStore } from "@/stores/documentStore";
import { useGroupStore } from "@/stores/groupStore";
import { usePDFViewerStore } from "@/stores/pdfViewerStore";

function colorByNodeType(nodeType: MindmapNode["node_type"]) {
  switch (nodeType) {
    case "answer":
      return { background: "rgba(222,240,246,0.95)", borderColor: "rgb(23,97,122)" };
    case "pdf_source":
      return { background: "rgba(255,252,247,0.98)", borderColor: "rgba(23,97,122,0.5)" };
    case "web_source":
      return { background: "rgba(240,244,248,0.96)", borderColor: "rgba(80,109,144,0.5)" };
    case "model_reasoning":
      return { background: "rgba(249,250,251,0.96)", borderColor: "rgba(148,163,184,0.7)" };
    case "user_input":
      return { background: "rgba(228,245,237,0.96)", borderColor: "rgba(28,126,88,0.4)" };
    default:
      return { background: "rgba(255,255,255,0.96)", borderColor: "rgba(203,213,225,0.9)" };
  }
}

function flattenTree(root: MindmapNode) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const queue: Array<{ node: MindmapNode; depth: number; row: number; parentId?: string }> = [
    { node: root, depth: 0, row: 0 },
  ];
  const levelCounts = new Map<number, number>();

  while (queue.length) {
    const current = queue.shift()!;
    const siblingsSeen = levelCounts.get(current.depth) ?? 0;
    levelCounts.set(current.depth, siblingsSeen + 1);

    const palette = colorByNodeType(current.node.node_type);

    nodes.push({
      id: current.node.id,
      data: {
        label: current.node.label,
        source: current.node.source,
        nodeType: current.node.node_type,
      },
      position: {
        x: current.depth * 250,
        y: siblingsSeen * 130,
      },
      style: {
        background: palette.background,
        borderColor: palette.borderColor,
        borderStyle: current.node.node_type === "model_reasoning" ? "dashed" : "solid",
      },
    });

    if (current.parentId) {
      edges.push({
        id: `${current.parentId}-${current.node.id}`,
        source: current.parentId,
        target: current.node.id,
        markerEnd: { type: MarkerType.ArrowClosed, color: "rgba(23,97,122,0.45)" },
      });
    }

    current.node.children.forEach((child) => {
      queue.push({
        node: child,
        depth: current.depth + 1,
        row: 0,
        parentId: current.node.id,
      });
    });
  }

  return { nodes, edges };
}

function MindmapCanvasInner({ data }: { data: MindmapNode | null }) {
  const activeGroupId = useGroupStore((state) => state.activeGroupId);
  const documents = useDocumentStore((state) =>
    activeGroupId ? state.documentsByGroup[activeGroupId] ?? [] : [],
  );
  const openCitation = usePDFViewerStore((state) => state.openCitation);

  const flow = useMemo(() => (data ? flattenTree(data) : { nodes: [], edges: [] }), [data]);

  const handleNodeClick: NodeMouseHandler = (_event, node) => {
    const source = node.data.source as Citation | undefined;
    if (!source) {
      return;
    }

    if (source.source_type === "web" && source.url) {
      window.open(source.url, "_blank", "noopener,noreferrer");
      return;
    }

    const document = documents.find((item) => item.id === source.document_id);
    if (document) {
      void openCitation(source, document);
    }
  };

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center rounded-[28px] border border-dashed border-line bg-panel/50 p-6 text-center text-sm text-muted">
        Ask a question to see how the answer was constructed.
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={flow.nodes}
      edges={flow.edges}
      fitView
      nodesDraggable={false}
      nodesConnectable={false}
      onNodeClick={handleNodeClick}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={24} color="rgba(148,163,184,0.18)" />
      <Controls />
    </ReactFlow>
  );
}

export function MindmapCanvas({ data }: { data: MindmapNode | null }) {
  return (
    <ReactFlowProvider>
      <MindmapCanvasInner data={data} />
    </ReactFlowProvider>
  );
}
