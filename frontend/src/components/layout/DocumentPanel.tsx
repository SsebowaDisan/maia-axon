"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, PanelRightOpen } from "lucide-react";

import { MindmapCanvas } from "@/components/mindmap/MindmapCanvas";
import { PDFViewer } from "@/components/pdf/PDFViewer";
import { Button } from "@/components/ui/button";
import { useMindmapStore } from "@/stores/mindmapStore";

export function DocumentPanel() {
  const mindmap = useMindmapStore((state) => state.data);
  const [mindmapCollapsed, setMindmapCollapsed] = useState(false);

  return (
    <div className="flex h-full flex-col gap-4 p-2">
      <div className="flex items-center justify-between rounded-[24px] border border-line bg-panel/95 px-4 py-3">
        <div>
          <p className="font-display text-xl text-ink">Sources & Reasoning</p>
          <p className="text-xs text-muted">Mindmap above, page viewer below. Click to inspect evidence.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setMindmapCollapsed((current) => !current)}
          >
            {mindmapCollapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </Button>
          <span className="rounded-full border border-line px-3 py-1 text-xs text-muted">
            <PanelRightOpen className="mr-1 inline h-3.5 w-3.5" />
            Panel 3
          </span>
        </div>
      </div>
      {!mindmapCollapsed ? (
        <div className="h-[38%] min-h-[220px] rounded-[28px] border border-line bg-panel/92 p-3">
          <MindmapCanvas data={mindmap} />
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <PDFViewer />
      </div>
    </div>
  );
}
