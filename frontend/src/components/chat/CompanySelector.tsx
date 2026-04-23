"use client";

import { forwardRef } from "react";
import { BarChart3, Building2 } from "lucide-react";

import { Input } from "@/components/ui/input";
import type { Company, SearchMode } from "@/lib/types";

function subtitleForCompany(company: Company, mode: Extract<SearchMode, "google_analytics" | "google_ads">) {
  if (mode === "google_analytics") {
    return company.ga4_property_id ? `GA4 Property · ${company.ga4_property_id}` : "GA4 property missing";
  }
  return company.google_ads_customer_id
    ? `Ads Customer · ${company.google_ads_customer_id}`
    : "Ads customer missing";
}

export const CompanySelector = forwardRef<HTMLDivElement, {
  companies: Company[];
  query: string;
  mode: Extract<SearchMode, "google_analytics" | "google_ads">;
  onQueryChange: (value: string) => void;
  onSelect: (company: Company) => void;
}>(function CompanySelector(
  { companies, query, mode, onQueryChange, onSelect },
  ref,
) {
  const Icon = mode === "google_analytics" ? BarChart3 : Building2;
  const emptyLabel = mode === "google_analytics" ? "No companies with GA4 access matched your search." : "No companies with Google Ads access matched your search.";

  return (
    <div ref={ref} className="absolute bottom-full left-14 mb-3 w-[360px] rounded-[24px] border border-line bg-panel p-3 shadow-card">
      <Input
        autoFocus
        placeholder="Search companies..."
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
      />
      <div className="mt-3 max-h-72 space-y-1 overflow-y-auto scrollbar-thin">
        {companies.length ? (
          companies.map((company) => (
            <button
              key={company.id}
              type="button"
              className="flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left transition hover:bg-black/5"
              onClick={() => onSelect(company)}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="rounded-2xl bg-accentSoft p-2 text-accent">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{company.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {subtitleForCompany(company, mode)}
                  </span>
                </span>
              </span>
            </button>
          ))
        ) : (
          <p className="px-2 py-6 text-center text-sm text-muted">{emptyLabel}</p>
        )}
      </div>
    </div>
  );
});
