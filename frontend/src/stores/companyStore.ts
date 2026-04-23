"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { api } from "@/lib/api";
import type { Company, SearchMode, User } from "@/lib/types";

const DELETE_TOMBSTONE_MS = 1200;

interface CompanyState {
  companies: Company[];
  companyUsers: Record<string, User[]>;
  selectedCompanyByMode: {
    google_analytics: string | null;
    google_ads: string | null;
  };
  deletedCompanyIds: Record<string, true>;
  deletedCompanyUserIds: Record<string, Record<string, true>>;
  loading: boolean;
  error: string | null;
  setSelectedCompany: (
    mode: Extract<SearchMode, "google_analytics" | "google_ads">,
    companyId: string | null,
  ) => void;
  fetchCompanies: () => Promise<void>;
  createCompany: (payload: {
    name: string;
    ga4_property_id?: string | null;
    google_ads_customer_id?: string | null;
    google_ads_login_customer_id?: string | null;
  }) => Promise<Company>;
  updateCompany: (
    companyId: string,
    payload: {
      name?: string;
      ga4_property_id?: string | null;
      google_ads_customer_id?: string | null;
      google_ads_login_customer_id?: string | null;
    },
  ) => Promise<Company>;
  deleteCompany: (companyId: string) => Promise<void>;
  fetchCompanyUsers: (companyId: string) => Promise<void>;
  assignUser: (companyId: string, userId: string) => Promise<void>;
  removeUser: (companyId: string, userId: string) => Promise<void>;
}

export const useCompanyStore = create<CompanyState>()(
  persist(
    (set) => ({
      companies: [],
      companyUsers: {},
      selectedCompanyByMode: {
        google_analytics: null,
        google_ads: null,
      },
      deletedCompanyIds: {},
      deletedCompanyUserIds: {},
      loading: false,
      error: null,
      setSelectedCompany(mode, companyId) {
        set((state) => ({
          selectedCompanyByMode: {
            ...state.selectedCompanyByMode,
            [mode]: companyId,
          },
        }));
      },
      async fetchCompanies() {
        set({ loading: true, error: null });
        try {
          const companies = await api.listCompanies();
          set({ companies });
        } catch (error) {
          set({ error: error instanceof Error ? error.message : "Failed to load companies" });
        } finally {
          set({ loading: false });
        }
      },
      async createCompany(payload) {
        const company = await api.createCompany(payload);
        set((state) => ({
          companies: [...state.companies, company].sort((a, b) => a.name.localeCompare(b.name)),
        }));
        return company;
      },
      async updateCompany(companyId, payload) {
        const company = await api.updateCompany(companyId, payload);
        set((state) => ({
          companies: state.companies.map((item) => (item.id === companyId ? company : item)),
        }));
        return company;
      },
      async deleteCompany(companyId) {
        await api.deleteCompany(companyId);
        set((state) => ({
          deletedCompanyIds: {
            ...state.deletedCompanyIds,
            [companyId]: true,
          },
        }));

        window.setTimeout(() => {
          set((state) => {
            const nextDeletedCompanyIds = { ...state.deletedCompanyIds };
            const nextDeletedCompanyUserIds = { ...state.deletedCompanyUserIds };
            const nextCompanyUsers = { ...state.companyUsers };
            delete nextDeletedCompanyIds[companyId];
            delete nextDeletedCompanyUserIds[companyId];
            delete nextCompanyUsers[companyId];

            return {
              deletedCompanyIds: nextDeletedCompanyIds,
              deletedCompanyUserIds: nextDeletedCompanyUserIds,
              companyUsers: nextCompanyUsers,
              companies: state.companies.filter((company) => company.id !== companyId),
            };
          });
        }, DELETE_TOMBSTONE_MS);
      },
      async fetchCompanyUsers(companyId) {
        const users = await api.listCompanyUsers(companyId);
        set((state) => ({
          companyUsers: {
            ...state.companyUsers,
            [companyId]: users,
          },
        }));
      },
      async assignUser(companyId, userId) {
        await api.assignCompanyUser(companyId, userId);
        const users = await api.listCompanyUsers(companyId);
        set((state) => ({
          companyUsers: {
            ...state.companyUsers,
            [companyId]: users,
          },
        }));
      },
      async removeUser(companyId, userId) {
        await api.removeCompanyUser(companyId, userId);
        set((state) => ({
          deletedCompanyUserIds: {
            ...state.deletedCompanyUserIds,
            [companyId]: {
              ...(state.deletedCompanyUserIds[companyId] ?? {}),
              [userId]: true,
            },
          },
        }));

        window.setTimeout(() => {
          set((state) => {
            const nextDeletedCompanyUserIds = {
              ...state.deletedCompanyUserIds,
              [companyId]: {
                ...(state.deletedCompanyUserIds[companyId] ?? {}),
              },
            };

            delete nextDeletedCompanyUserIds[companyId]?.[userId];
            if (
              nextDeletedCompanyUserIds[companyId] &&
              !Object.keys(nextDeletedCompanyUserIds[companyId]).length
            ) {
              delete nextDeletedCompanyUserIds[companyId];
            }

            return {
              deletedCompanyUserIds: nextDeletedCompanyUserIds,
              companyUsers: {
                ...state.companyUsers,
                [companyId]: (state.companyUsers[companyId] ?? []).filter((user) => user.id !== userId),
              },
            };
          });
        }, DELETE_TOMBSTONE_MS);
      },
    }),
    {
      name: "maia-axon-company",
      partialize: (state) => ({
        selectedCompanyByMode: state.selectedCompanyByMode,
      }),
    },
  ),
);
