"use client";

import { useDocumentStore } from "@/stores/documentStore";

export function useDocuments() {
  return useDocumentStore();
}
