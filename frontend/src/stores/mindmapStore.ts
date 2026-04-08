"use client";

import { create } from "zustand";

import type { MindmapNode } from "@/lib/types";

interface MindmapState {
  data: MindmapNode | null;
  setMindmapData: (data: MindmapNode | null) => void;
  clearMindmap: () => void;
}

export const useMindmapStore = create<MindmapState>((set) => ({
  data: null,
  setMindmapData(data) {
    set({ data });
  },
  clearMindmap() {
    set({ data: null });
  },
}));
