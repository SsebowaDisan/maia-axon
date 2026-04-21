"use client";

import { create } from "zustand";

import { api } from "@/lib/api";
import type { Document, DocumentStatus, UploadProgressState } from "@/lib/types";
import { useGroupStore } from "@/stores/groupStore";

const DELETE_TOMBSTONE_MS = 1200;

interface DocumentState {
  documentsByGroup: Record<string, Document[]>;
  selectedDocumentIds: string[];
  uploadStates: UploadProgressState[];
  documentStatuses: Record<string, DocumentStatus>;
  deletedDocumentIds: Record<string, true>;
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
  deletedDocumentIds: {},
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
    } catch (error) {
      if (error instanceof Error && error.message === "Group not found") {
        const activeGroupId = useGroupStore.getState().activeGroupId;
        set((state) => ({
          documentsByGroup: {
            ...state.documentsByGroup,
            [groupId]: [],
          },
          selectedDocumentIds: [],
        }));
        if (activeGroupId === groupId) {
          useGroupStore.getState().setActiveGroup(null);
        }
        return;
      }
      throw error;
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
      deletedDocumentIds: {
        ...state.deletedDocumentIds,
        [documentId]: true,
      },
      selectedDocumentIds: state.selectedDocumentIds.filter((id) => id !== documentId),
    }));

    window.setTimeout(() => {
      set((state) => {
        const nextDeletedDocumentIds = { ...state.deletedDocumentIds };
        delete nextDeletedDocumentIds[documentId];

        return {
          deletedDocumentIds: nextDeletedDocumentIds,
          documentsByGroup: {
            ...state.documentsByGroup,
            [groupId]: (state.documentsByGroup[groupId] ?? []).filter((doc) => doc.id !== documentId),
          },
        };
      });
    }, DELETE_TOMBSTONE_MS);
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
    while (attempts < 900) {
      const status = await api.getDocumentStatus(documentId);
      set((state) => ({
        documentStatuses: {
          ...state.documentStatuses,
          [documentId]: status,
        },
        uploadStates: state.uploadStates.map((entry) =>
          entry.documentId === documentId
            ? {
                ...entry,
                progress: status.status === "ready" ? 100 : entry.progress >= 100 ? entry.progress : 100,
                status:
                  status.status === "failed"
                    ? "failed"
                    : status.status === "ready"
                      ? "done"
                      : "processing",
                error: status.error_detail ?? entry.error,
              }
            : entry,
        ),
      }));
      if (status.status === "ready" || status.status === "failed") {
        return;
      }
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  },
}));
