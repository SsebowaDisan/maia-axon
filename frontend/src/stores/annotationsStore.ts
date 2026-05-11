"use client";

import { create } from "zustand";

import { api } from "@/lib/api";
import type {
  Annotation,
  AnnotationColor,
  AnnotationCreatePayload,
  AnnotationVisibility,
} from "@/lib/types";

interface AnnotationsState {
  // Annotations for the currently-open document only. Cleared when the
  // user opens a different document so we never accidentally render
  // teammate notes from doc A on top of doc B.
  documentId: string | null;
  annotations: Annotation[];
  loading: boolean;
  hovered: { annotationId: string; pageNumber: number } | null;
  load: (documentId: string) => Promise<void>;
  create: (payload: AnnotationCreatePayload) => Promise<Annotation | null>;
  update: (
    annotationId: string,
    patch: { color?: AnnotationColor; comment?: string | null; visibility?: AnnotationVisibility },
  ) => Promise<void>;
  remove: (annotationId: string) => Promise<void>;
  setHovered: (entry: { annotationId: string; pageNumber: number } | null) => void;
  clear: () => void;
}

export const useAnnotationsStore = create<AnnotationsState>((set, get) => ({
  documentId: null,
  annotations: [],
  loading: false,
  hovered: null,
  async load(documentId) {
    if (get().documentId === documentId && get().annotations.length > 0) {
      return;
    }
    set({ documentId, annotations: [], loading: true });
    try {
      const annotations = await api.listAnnotations(documentId);
      // Guard against the user switching documents mid-fetch.
      if (get().documentId !== documentId) {
        return;
      }
      set({ annotations, loading: false });
    } catch {
      set({ loading: false });
    }
  },
  async create(payload) {
    try {
      const annotation = await api.createAnnotation(payload);
      // Only add to the visible list if it belongs to the document the
      // user currently has open — avoids ghost highlights if the doc was
      // swapped between selection start and save.
      if (get().documentId === annotation.document_id) {
        set((state) => ({ annotations: [...state.annotations, annotation] }));
      }
      return annotation;
    } catch {
      return null;
    }
  },
  async update(annotationId, patch) {
    try {
      const updated = await api.updateAnnotation(annotationId, patch);
      set((state) => ({
        annotations: state.annotations.map((a) => (a.id === annotationId ? updated : a)),
      }));
    } catch {
      // No-op on failure; UI stays consistent with last server state.
    }
  },
  async remove(annotationId) {
    try {
      await api.deleteAnnotation(annotationId);
      set((state) => ({
        annotations: state.annotations.filter((a) => a.id !== annotationId),
      }));
    } catch {
      // ignore — keep showing in case server actually retained it.
    }
  },
  setHovered(entry) {
    set({ hovered: entry });
  },
  clear() {
    set({ documentId: null, annotations: [], hovered: null });
  },
}));
