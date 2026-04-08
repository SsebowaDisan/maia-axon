"use client";

import { useGroupStore } from "@/stores/groupStore";

export function useGroups() {
  return useGroupStore();
}
