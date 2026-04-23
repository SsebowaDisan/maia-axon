"use client";

import { create } from "zustand";

import { api } from "@/lib/api";
import type { ExportDestination } from "@/lib/types";

interface ExportDestinationState {
  destinations: ExportDestination[];
  serviceAccountEmail: string;
  loading: boolean;
  error: string | null;
  fetchInfo: () => Promise<void>;
  fetchDestinations: () => Promise<void>;
  saveDestination: (payload: {
    company_id?: string | null;
    type: "google_doc" | "google_sheet";
    title?: string | null;
    url: string;
  }) => Promise<ExportDestination>;
  deleteDestination: (destinationId: string) => Promise<void>;
  writeDestination: (payload: {
    destination_id: string;
    title: string;
    content: string;
    search_mode?: string | null;
    company_name?: string | null;
    visualizations?: unknown[];
  }) => Promise<void>;
}

export const useExportDestinationStore = create<ExportDestinationState>((set) => ({
  destinations: [],
  serviceAccountEmail: "",
  loading: false,
  error: null,
  async fetchInfo() {
    try {
      const info = await api.getExportDestinationInfo();
      set({ serviceAccountEmail: info.service_account_email });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "Failed to load export info" });
    }
  },
  async fetchDestinations() {
    set({ loading: true, error: null });
    try {
      const destinations = await api.listExportDestinations();
      set({ destinations });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "Failed to load destinations" });
    } finally {
      set({ loading: false });
    }
  },
  async saveDestination(payload) {
    const destination = await api.createExportDestination(payload);
    set((state) => {
      const next = [
        destination,
        ...state.destinations.filter((item) => item.id !== destination.id),
      ];
      return { destinations: next };
    });
    return destination;
  },
  async deleteDestination(destinationId) {
    await api.deleteExportDestination(destinationId);
    set((state) => ({
      destinations: state.destinations.filter((destination) => destination.id !== destinationId),
    }));
  },
  async writeDestination(payload) {
    await api.writeExportDestination(payload);
  },
}));
