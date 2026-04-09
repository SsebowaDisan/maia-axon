"use client";

import { create } from "zustand";

import { api } from "@/lib/api";
import type { Citation, Document, PageData } from "@/lib/types";

interface PDFViewerState {
  currentDocument: Document | null;
  currentWebCitation: Citation | null;
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
  currentWebCitation: null,
  currentPage: 1,
  zoom: 1,
  highlightCitations: [],
  pageCache: {},
  pageData: null,
  loading: false,
  async openCitation(citation, document) {
    if (citation.source_type === "web") {
      set({
        currentDocument: null,
        currentWebCitation: citation,
        currentPage: 1,
        pageData: null,
        highlightCitations: [citation],
        loading: false,
      });
      return;
    }

    if (!citation.document_id) {
      return;
    }

    const fallbackDocument =
      document ??
      ({
        id: citation.document_id,
        group_id: "",
        filename: citation.document_name || citation.title || "Source document",
        file_url: citation.url ?? "",
        file_size_bytes: null,
        page_count: null,
        status: "ready",
        error_detail: null,
        uploaded_by: "",
        created_at: "",
        updated_at: "",
      } satisfies Document);

    await get().loadPage(fallbackDocument, citation.page, [citation]);
  },
  async loadPage(document, pageNumber, highlightCitations = []) {
    const key = pageKey(document.id, pageNumber);
    const cached = get().pageCache[key];

    set({
      currentDocument: document,
      currentWebCitation: null,
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
      currentWebCitation: null,
      pageData: null,
      highlightCitations: [],
    });
  },
}));
