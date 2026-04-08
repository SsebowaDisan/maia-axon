"use client";

import { usePDFViewerStore } from "@/stores/pdfViewerStore";

export function usePDFViewer() {
  return usePDFViewerStore();
}
