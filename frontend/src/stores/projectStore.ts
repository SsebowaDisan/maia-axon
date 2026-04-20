"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { api } from "@/lib/api";
import type { Project } from "@/lib/types";

interface ProjectState {
  projects: Project[];
  activeProjectId: string | null;
  loading: boolean;
  error: string | null;
  fetchProjects: () => Promise<void>;
  setActiveProject: (projectId: string | null) => void;
  createProject: (payload: { name: string }) => Promise<Project>;
  updateProject: (projectId: string, payload: { name?: string }) => Promise<Project>;
  deleteProject: (projectId: string) => Promise<void>;
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      projects: [],
      activeProjectId: null,
      loading: false,
      error: null,
      async fetchProjects() {
        set({ loading: true, error: null });
        try {
          const projects = await api.listProjects();
          const activeProjectId = get().activeProjectId;
          const stillExists = projects.some((project) => project.id === activeProjectId);
          set({
            projects,
            activeProjectId: stillExists ? activeProjectId : projects[0]?.id ?? null,
          });
        } catch (error) {
          set({ error: error instanceof Error ? error.message : "Failed to load projects" });
        } finally {
          set({ loading: false });
        }
      },
      setActiveProject(projectId) {
        set({ activeProjectId: projectId });
      },
      async createProject(payload) {
        const project = await api.createProject(payload);
        set((state) => ({
          projects: [project, ...state.projects].sort((a, b) => a.name.localeCompare(b.name)),
        }));
        return project;
      },
      async updateProject(projectId, payload) {
        const project = await api.updateProject(projectId, payload);
        set((state) => ({
          projects: state.projects.map((item) => (item.id === projectId ? project : item)),
        }));
        return project;
      },
      async deleteProject(projectId) {
        await api.deleteProject(projectId);
        set((state) => ({
          projects: state.projects.filter((project) => project.id !== projectId),
          activeProjectId: state.activeProjectId === projectId ? null : state.activeProjectId,
        }));
      },
    }),
    {
      name: "maia-axon-project",
      partialize: (state) => ({ activeProjectId: state.activeProjectId }),
    },
  ),
);
