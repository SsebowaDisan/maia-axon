"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { api, setStoredToken } from "@/lib/api";
import type { User } from "@/lib/types";

interface AuthState {
  token: string | null;
  user: User | null;
  isHydrated: boolean;
  isLoading: boolean;
  error: string | null;
  setHydrated: () => void;
  bootstrap: () => Promise<void>;
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      token: null,
      user: null,
      isHydrated: false,
      isLoading: false,
      error: null,
      setHydrated: () => set({ isHydrated: true }),
      async bootstrap() {
        if (!get().token) {
          set({ isHydrated: true });
          return;
        }

        set({ isLoading: true, error: null });
        try {
          const user = await api.me();
          set({ user, isHydrated: true });
        } catch (error) {
          setStoredToken(null);
          set({
            token: null,
            user: null,
            isHydrated: true,
            error: error instanceof Error ? error.message : "Authentication failed",
          });
        } finally {
          set({ isLoading: false });
        }
      },
      async login(identifier, password) {
        set({ isLoading: true, error: null });
        try {
          const response = await api.login(identifier, password);
          setStoredToken(response.access_token);
          set({
            token: response.access_token,
            user: response.user,
            isHydrated: true,
          });
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : "Login failed",
          });
          throw error;
        } finally {
          set({ isLoading: false });
        }
      },
      logout() {
        setStoredToken(null);
        set({
          token: null,
          user: null,
          error: null,
        });
      },
    }),
    {
      name: "maia-axon-auth",
      partialize: (state) => ({ token: state.token, user: state.user }),
      onRehydrateStorage: () => (state) => {
        state?.setHydrated();
      },
    },
  ),
);
