"use client";

import { create } from "zustand";

import { api } from "@/lib/api";
import type { Document, DocumentStatus, UploadProgressState } from "@/lib/types";

interface DocumentState {
  documentsByGroup: Record<string, Document[]>;
  selectedDocumentIds: string[];
  uploadStates: UploadProgressState[];
  documentStatuses: Record<string, DocumentStatus>;
  loading: boolean;
  fetchDocuments: (groupId: string) => Promise<void>;
  toggleDocument: (documentId: string) => void;
  setSelectedDocuments: (documentIds: string[]) => void;
  clearSelection: () => void;
  uploadDocument: (groupId: string, file: File) => Promise<void>;
  deleteDocument: (documentId: string, groupId: string) => Promise<void>;
  reindexDocument: (documentId: string) => Promise<void>;
  pollStatus: (documentId: string) => Promise<void>;
}

export const useDocumentStore = create<DocumentState>((set, get) => ({
  documentsByGroup: {},
  selectedDocumentIds: [],
  uploadStates: [],
  documentStatuses: {},
  loading: false,
  async fetchDocuments(groupId) {
    set({ loading: true });
    try {
      const documents = await api.listDocuments(groupId);
      set((state) => ({
        documentsByGroup: {
          ...state.documentsByGroup,
          [groupId]: documents,
        },
      }));
    } finally {
      set({ loading: false });
    }
  },
  toggleDocument(documentId) {
    set((state) => {
      const exists = state.selectedDocumentIds.includes(documentId);
      return {
        selectedDocumentIds: exists
          ? state.selectedDocumentIds.filter((id) => id !== documentId)
          : [...state.selectedDocumentIds, documentId],
      };
    });
  },
  setSelectedDocuments(documentIds) {
    set({ selectedDocumentIds: documentIds });
  },
  clearSelection() {
    set({ selectedDocumentIds: [] });
  },
  async uploadDocument(groupId, file) {
    set((state) => ({
      uploadStates: [
        ...state.uploadStates,
        {
          fileName: file.name,
          progress: 0,
          status: "uploading",
        },
      ],
    }));

    try {
      const document = await api.uploadDocument(groupId, file, (progress) => {
        set((state) => ({
          uploadStates: state.uploadStates.map((entry) =>
            entry.fileName === file.name
              ? { ...entry, progress, status: progress >= 100 ? "processing" : "uploading" }
              : entry,
          ),
        }));
      });

      set((state) => ({
        uploadStates: state.uploadStates.map((entry) =>
          entry.fileName === file.name
            ? {
                ...entry,
                progress: 100,
                status: "processing",
                documentId: document.id,
              }
            : entry,
        ),
        documentsByGroup: {
          ...state.documentsByGroup,
          [groupId]: [document, ...(state.documentsByGroup[groupId] ?? [])],
        },
      }));

      await get().pollStatus(document.id);
      await get().fetchDocuments(groupId);

      set((state) => ({
        uploadStates: state.uploadStates.map((entry) =>
          entry.documentId === document.id ? { ...entry, status: "done" } : entry,
        ),
      }));
    } catch (error) {
      set((state) => ({
        uploadStates: state.uploadStates.map((entry) =>
          entry.fileName === file.name
            ? {
                ...entry,
                status: "failed",
                error: error instanceof Error ? error.message : "Upload failed",
              }
            : entry,
        ),
      }));
      throw error;
    }
  },
  async deleteDocument(documentId, groupId) {
    await api.deleteDocument(documentId);
    set((state) => ({
      documentsByGroup: {
        ...state.documentsByGroup,
        [groupId]: (state.documentsByGroup[groupId] ?? []).filter((doc) => doc.id !== documentId),
      },
      selectedDocumentIds: state.selectedDocumentIds.filter((id) => id !== documentId),
    }));
  },
  async reindexDocument(documentId) {
    const status = await api.reindexDocument(documentId);
    set((state) => ({
      documentStatuses: {
        ...state.documentStatuses,
        [documentId]: status,
      },
    }));
    await get().pollStatus(documentId);
  },
  async pollStatus(documentId) {
    let attempts = 0;
    while (attempts < 60) {
      const status = await api.getDocumentStatus(documentId);
      set((state) => ({
        documentStatuses: {
          ...state.documentStatuses,
          [documentId]: status,
        },
      }));
      if (status.status === "ready" || status.status === "failed") {
        return;
      }
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  },
}));
