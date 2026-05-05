"use client";

import { create } from "zustand";

import { api, getCachedPageData, prefetchAuthorized } from "@/lib/api";
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
  // Increments on every openCitation call (even when the user clicks the
  // same chip twice). The PDFViewer scroll/visible-range effects include
  // this nonce in their dedupe keys so a repeat click re-triggers the
  // jump-to-evidence behaviour instead of being short-circuited as a
  // duplicate of the previous state.
  openClickNonce: number;
  prefetchPages: (document: Document, pageNumbers: number[]) => Promise<void>;
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
  openClickNonce: 0,
  async prefetchPages(document, pageNumbers) {
    const uniquePageNumbers = [...new Set(pageNumbers)]
      .filter((pageNumber) => pageNumber >= 1 && (!document.page_count || pageNumber <= document.page_count));

    const cachedPages = uniquePageNumbers
      .map((pageNumber) => ({
        pageNumber,
        pageData: get().pageCache[pageKey(document.id, pageNumber)] ?? getCachedPageData(document.id, pageNumber),
      }))
      .filter((entry): entry is { pageNumber: number; pageData: PageData } => !!entry.pageData);

    if (cachedPages.length) {
      set((state) => ({
        pageCache: {
          ...state.pageCache,
          ...Object.fromEntries(
            cachedPages.map(({ pageNumber, pageData }) => [pageKey(document.id, pageNumber), pageData]),
          ),
        },
      }));
    }

    const missingPages = uniquePageNumbers.filter(
      (pageNumber) =>
        !get().pageCache[pageKey(document.id, pageNumber)] && !getCachedPageData(document.id, pageNumber),
    );
    if (!missingPages.length) {
      return;
    }

    const pageResults = await Promise.all(
      missingPages.map(async (pageNumber) => ({
        pageNumber,
        pageData: await api.getPage(document.id, pageNumber),
      })),
    );

    set((state) => ({
      pageCache: {
        ...state.pageCache,
        ...Object.fromEntries(
          pageResults.map(({ pageNumber, pageData }) => [pageKey(document.id, pageNumber), pageData]),
        ),
      },
    }));

    void Promise.all(
      missingPages.map((pageNumber) =>
        prefetchAuthorized(`/documents/${document.id}/pages/${pageNumber}/image`),
      ),
    );
  },
  async openCitation(citation, document) {
    if (citation.source_type === "web") {
      // Web citations: nonce + content set atomically so React only sees
      // one consistent transition (no stale-state flicker for the
      // PDFViewer effects, even if a PDF citation was previously open).
      set((state) => ({
        openClickNonce: state.openClickNonce + 1,
        currentDocument: null,
        currentWebCitation: citation,
        currentPage: 1,
        pageData: null,
        highlightCitations: [citation],
        loading: false,
      }));
      return;
    }

    if (!citation.document_id) {
      return;
    }

    let resolvedDocument: Document | null = document ?? null;
    if (!resolvedDocument) {
      try {
        resolvedDocument = await api.getDocument(citation.document_id);
      } catch {
        // Fetch can fail if the document was deleted or the user no longer
        // has access. Fall back to a synthetic shell so the user still gets
        // the cited page; pagination beyond the cited page will be limited
        // because page_count is unknown.
        resolvedDocument = {
          id: citation.document_id,
          group_id: "",
          filename: citation.document_name || citation.title || "Source document",
          file_url: citation.url ?? "",
          file_size_bytes: null,
          page_count: null,
          status: "ready",
          current_stage: null,
          progress_current: null,
          progress_total: null,
          error_detail: null,
          uploaded_by: "",
          created_at: "",
          updated_at: "",
        } satisfies Document;
      }
    }

    await get().loadPage(resolvedDocument, citation.page, [citation]);
    // Wider prefetch window so scrolling around the cited page is instant
    // (covers ±3 around the hit). Hover-prefetch on the citation chip
    // already warms the immediate ±1 before the user even clicks.
    const prefetchWindow = [
      citation.page - 3,
      citation.page - 2,
      citation.page - 1,
      citation.page + 1,
      citation.page + 2,
      citation.page + 3,
    ];
    void get().prefetchPages(resolvedDocument, prefetchWindow);
  },
  async loadPage(document, pageNumber, highlightCitations = []) {
    const key = pageKey(document.id, pageNumber);
    const cached = get().pageCache[key] ?? getCachedPageData(document.id, pageNumber);

    // Bump openClickNonce atomically with the new page/highlight state.
    // Doing it in the same ``set`` call avoids the prior-state flicker
    // where PDFViewer effects fired with a fresh nonce against the
    // *previous* citation, scrolling to the wrong page.
    set((state) => ({
      currentDocument: document,
      currentWebCitation: null,
      currentPage: pageNumber,
      highlightCitations,
      loading: !cached,
      pageData: cached ?? state.pageData,
      openClickNonce: state.openClickNonce + 1,
    }));

    if (cached) {
      set((state) => ({
        pageData: cached,
        loading: false,
        pageCache: {
          ...state.pageCache,
          [key]: cached,
        },
      }));
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
