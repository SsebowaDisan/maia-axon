"use client";

import { create } from "zustand";

import { api } from "@/lib/api";
import type { Citation, Document, PageData } from "@/lib/types";

interface PDFViewerState {
  currentDocument: Document | null;
  currentPage: number;
  zoom: number;
  highlightCitations: Citation[];
  pageCache: Record<string, PageData>;
  pageData: PageData | null;
  loading: boolean;
  openCitation: (citation: Citation, document?: Document | null) => Promise<void>;
  loadPage: (document: Document, pageNumber: number, highlightCitations?: Citation[]) => Promise<void>;
  nextPage: () => Promise<void>;
  previousPage: () => Promise<void>;
  setZoom: (zoom: number) => void;
  fitWidth: () => void;
  clearHighlights: () => void;
  close: () => void;
}

function pageKey(documentId: string, pageNumber: number) {
  return `${documentId}:${pageNumber}`;
}

export const usePDFViewerStore = create<PDFViewerState>((set, get) => ({
  currentDocument: null,
  currentPage: 1,
  zoom: 1,
  highlightCitations: [],
  pageCache: {},
  pageData: null,
  loading: false,
  async openCitation(citation, document) {
    if (!citation.document_id || !document) {
      return;
    }
    await get().loadPage(document, citation.page, [citation]);
  },
  async loadPage(document, pageNumber, highlightCitations = []) {
    const key = pageKey(document.id, pageNumber);
    const cached = get().pageCache[key];

    set({
      currentDocument: document,
      currentPage: pageNumber,
      highlightCitations,
      loading: !cached,
      pageData: cached ?? get().pageData,
    });

    if (cached) {
      set({ pageData: cached, loading: false });
      return;
    }

    const pageData = await api.getPage(document.id, pageNumber);
    set((state) => ({
      pageData,
      loading: false,
      pageCache: {
        ...state.pageCache,
        [key]: pageData,
      },
    }));
  },
  async nextPage() {
    const { currentDocument, currentPage } = get();
    if (!currentDocument) {
      return;
    }
    const maxPage = currentDocument.page_count ?? currentPage;
    if (currentPage >= maxPage) {
      return;
    }
    await get().loadPage(currentDocument, currentPage + 1);
  },
  async previousPage() {
    const { currentDocument, currentPage } = get();
    if (!currentDocument || currentPage <= 1) {
      return;
    }
    await get().loadPage(currentDocument, currentPage - 1);
  },
  setZoom(zoom) {
    set({ zoom });
  },
  fitWidth() {
    set({ zoom: 1 });
  },
  clearHighlights() {
    set({ highlightCitations: [] });
  },
  close() {
    set({
      currentDocument: null,
      pageData: null,
      highlightCitations: [],
    });
  },
}));
