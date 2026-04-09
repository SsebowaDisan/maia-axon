"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { MindmapCanvas } from "@/components/mindmap/MindmapCanvas";
import { PDFViewer } from "@/components/pdf/PDFViewer";
import { Button } from "@/components/ui/button";
import { useMindmapStore } from "@/stores/mindmapStore";

export function DocumentPanel() {
  const mindmap = useMindmapStore((state) => state.data);
  const [mindmapCollapsed, setMindmapCollapsed] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <div className="flex items-start justify-between px-2 py-1">
        <p className="font-display text-[1.35rem] font-semibold tracking-[-0.03em] text-ink">Sources</p>
        <div className="flex items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setMindmapCollapsed((current) => !current)}
          >
            {mindmapCollapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </Button>
        </div>
      </div>
      {!mindmapCollapsed ? (
        <div className="h-[34%] min-h-[180px] rounded-[22px] bg-black/[0.02] p-3">
          <MindmapCanvas data={mindmap} />
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <PDFViewer />
      </div>
    </div>
  );
}
