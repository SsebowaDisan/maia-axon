"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  BarChart3,
  Building2,
  PencilLine,
  Plus,
  Search,
  Trash2,
  Users,
  X,
} from "lucide-react";

import { DeleteConfirmDialog } from "@/components/shared/DeleteConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDialogDismiss } from "@/hooks/useDialogDismiss";
import { api } from "@/lib/api";
import type { Company, User } from "@/lib/types";
import { useCompanyStore } from "@/stores/companyStore";

type CompanyDraft = {
  name: string;
  ga4_property_id: string;
  google_ads_customer_id: string;
  google_ads_login_customer_id: string;
};

function CompanyUserPanel({ companyId }: { companyId: string }) {
  const companyUsers = useCompanyStore((state) => state.companyUsers);
  const deletedCompanyUserIds = useCompanyStore((state) => state.deletedCompanyUserIds);
  const fetchCompanyUsers = useCompanyStore((state) => state.fetchCompanyUsers);
  const assignUser = useCompanyStore((state) => state.assignUser);
  const removeUser = useCompanyStore((state) => state.removeUser);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [query, setQuery] = useState("");
  const [removeTarget, setRemoveTarget] = useState<User | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);

  useEffect(() => {
    void fetchCompanyUsers(companyId);
    void api.listUsers().then(setAllUsers).catch(() => undefined);
  }, [companyId, fetchCompanyUsers]);

  const assignedUsers = useMemo(() => companyUsers[companyId] ?? [], [companyId, companyUsers]);
  const deletedUserIds = deletedCompanyUserIds[companyId] ?? {};
  const assignedIds = useMemo(() => new Set(assignedUsers.map((user) => user.id)), [assignedUsers]);
  const availableUsers = allUsers.filter((user) => {
    if (assignedIds.has(user.id)) {
      return false;
    }
    const needle = query.toLowerCase();
    return user.name.toLowerCase().includes(needle) || user.email.toLowerCase().includes(needle);
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
      <div className="rounded-[26px] border border-black/[0.05] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(247,247,246,0.95))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.86)]">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Assigned</p>
            <p className="mt-2 text-lg font-semibold tracking-[-0.03em] text-ink">Assigned users</p>
            <p className="mt-1 text-sm leading-6 text-muted">People who can already use this company.</p>
          </div>
          <span className="rounded-full border border-black/[0.06] bg-white/92 px-3 py-1.5 text-xs font-medium text-muted shadow-[0_10px_22px_rgba(17,17,17,0.04)]">
            {assignedUsers.length}
          </span>
        </div>

        <div className="space-y-2">
          {assignedUsers.length ? (
            assignedUsers.map((user) => {
              const isDeleted = !!deletedUserIds[user.id];
              return (
                <div
                  key={user.id}
                  className={`flex items-center justify-between rounded-[18px] border px-4 py-3.5 ${
                    isDeleted
                      ? "border-danger/15 bg-danger/5 opacity-70"
                      : "border-black/[0.05] bg-white/95 shadow-[0_10px_24px_rgba(17,17,17,0.03)]"
                  }`}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{isDeleted ? "Deleted" : user.name}</p>
                    <p className="mt-1 text-[11px] uppercase tracking-[0.14em] text-muted">
                      {isDeleted ? "Removing..." : user.role}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="rounded-full px-3 text-muted hover:bg-black/[0.04] hover:text-ink"
                    disabled={isDeleted}
                    onClick={() => setRemoveTarget(user)}
                  >
                    {isDeleted ? "Removed" : "Remove"}
                  </Button>
                </div>
              );
            })
          ) : (
            <div className="rounded-[20px] border border-dashed border-black/[0.08] bg-white/95 px-5 py-8 text-sm text-muted shadow-[0_10px_24px_rgba(17,17,17,0.03)]">
              No users assigned yet.
            </div>
          )}
        </div>
      </div>

      <div className="rounded-[26px] border border-black/[0.05] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(247,247,246,0.95))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.86)]">
        <div className="mb-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Add access</p>
          <p className="mt-2 text-lg font-semibold tracking-[-0.03em] text-ink">Assign user</p>
          <p className="mt-1 text-sm leading-6 text-muted">Search Maia users and grant access without leaving this screen.</p>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted/80" />
          <Input
            className="h-12 rounded-full border-black/[0.06] bg-white/95 pl-11 shadow-[0_10px_24px_rgba(17,17,17,0.03)]"
            placeholder="Search users..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="mt-4 max-h-72 space-y-2 overflow-y-auto pr-1 scrollbar-thin">
          {availableUsers.length ? (
            availableUsers.map((user) => (
              <button
                key={user.id}
                type="button"
                className="flex w-full items-center justify-between rounded-[18px] border border-black/[0.05] bg-white/95 px-4 py-3.5 text-left shadow-[0_10px_24px_rgba(17,17,17,0.03)] transition hover:border-black/[0.08] hover:bg-white"
                onClick={() => void assignUser(companyId, user.id)}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink">{user.name}</span>
                  <span className="mt-1 block text-[11px] uppercase tracking-[0.14em] text-muted">{user.role}</span>
                </span>
                <span className="rounded-full border border-black/[0.06] bg-black/[0.03] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink">
                  Assign
                </span>
              </button>
            ))
          ) : (
            <div className="rounded-[20px] border border-dashed border-black/[0.08] bg-white/95 px-5 py-8 text-center text-sm text-muted shadow-[0_10px_24px_rgba(17,17,17,0.03)]">
              No users available for assignment.
            </div>
          )}
        </div>
      </div>

      <DeleteConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveTarget(null);
          }
        }}
        title="Remove user"
        description={
          <>
            Type <span className="font-semibold text-ink">delete</span> to remove{" "}
            <span className="font-semibold text-ink">{removeTarget?.name ?? "this user"}</span> from the company.
          </>
        }
        confirmLabel="Remove user"
        isDeleting={isRemoving}
        onConfirm={async () => {
          if (!removeTarget) {
            return;
          }
          setIsRemoving(true);
          try {
            await removeUser(companyId, removeTarget.id);
            setRemoveTarget(null);
          } finally {
            setIsRemoving(false);
          }
        }}
      />
    </div>
  );
}

function CompanyDetailDialog({
  company,
  assignedCount,
  open,
  onOpenChange,
  onEditSources,
  onManageAccess,
  onDelete,
}: {
  company: Company | null;
  assignedCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEditSources: () => void;
  onManageAccess: () => void;
  onDelete: () => void;
}) {
  const {
    handleOpenChange,
    handlePointerDownOutside,
    handleEscapeKeyDown,
    handleFocusOutside,
    handleInteractOutside,
    requestClose,
  } = useDialogDismiss(() => onOpenChange(false));

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/18 backdrop-blur-[18px]" onDoubleClick={requestClose} />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[80] w-[min(840px,calc(100vw-2rem))] max-h-[min(820px,calc(100vh-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[30px] border border-black/[0.06] bg-white p-6 shadow-[0_24px_60px_rgba(17,17,17,0.12)] outline-none"
          onPointerDownOutside={handlePointerDownOutside}
          onEscapeKeyDown={handleEscapeKeyDown}
          onFocusOutside={handleFocusOutside}
          onInteractOutside={handleInteractOutside}
        >
          {company ? (
            <>
              <div className="flex items-start justify-between gap-4">
                <div className="max-w-2xl">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Company details</p>
                  <Dialog.Title className="mt-2 font-display text-[1.85rem] font-semibold tracking-[-0.05em] text-ink">
                    {company.name}
                  </Dialog.Title>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    Review the source IDs Maia uses for this company, then open a focused screen to edit sources or manage access.
                  </p>
                </div>
                <button
                  type="button"
                  className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
                  aria-label="Close company details"
                  onClick={requestClose}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                <span className="rounded-full bg-black px-3 py-1 text-xs font-semibold text-white">
                  {company.ga4_property_id ? "GA4 connected" : "GA4 missing"}
                </span>
                <span className="rounded-full bg-black/[0.06] px-3 py-1 text-xs font-semibold text-ink">
                  {company.google_ads_customer_id ? "Ads connected" : "Ads missing"}
                </span>
                <span className="rounded-full bg-black/[0.06] px-3 py-1 text-xs font-semibold text-ink">
                  {assignedCount} users assigned
                </span>
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <div className="rounded-[24px] border border-black/[0.06] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(246,246,245,0.94))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)]">
                  <div className="flex items-center gap-3">
                    <span className="rounded-full bg-black p-2.5 text-white">
                      <BarChart3 className="h-4 w-4" />
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-ink">Google Analytics</p>
                      <p className="text-xs text-muted">GA4 property Maia queries for this company</p>
                    </div>
                  </div>
                  <div className="mt-5 rounded-[20px] bg-black/[0.03] px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Property ID</p>
                    <p className="mt-2 break-all text-lg font-semibold tracking-[-0.03em] text-ink">
                      {company.ga4_property_id ?? "Not configured"}
                    </p>
                  </div>
                </div>

                <div className="rounded-[24px] border border-black/[0.06] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(246,246,245,0.94))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.82)]">
                  <div className="flex items-center gap-3">
                    <span className="rounded-full bg-black p-2.5 text-white">
                      <Building2 className="h-4 w-4" />
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-ink">Google Ads</p>
                      <p className="text-xs text-muted">Customer ID and optional manager login ID</p>
                    </div>
                  </div>
                  <div className="mt-5 rounded-[20px] bg-black/[0.03] px-4 py-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Customer ID</p>
                    <p className="mt-2 break-all text-lg font-semibold tracking-[-0.03em] text-ink">
                      {company.google_ads_customer_id ?? "Not configured"}
                    </p>
                    {company.google_ads_login_customer_id ? (
                      <p className="mt-3 text-xs leading-5 text-muted">
                        Login customer ID: {company.google_ads_login_customer_id}
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <button
                  type="button"
                  className="rounded-[24px] border border-black/[0.06] bg-white px-5 py-5 text-left shadow-[0_12px_28px_rgba(17,17,17,0.04)] transition hover:bg-black hover:text-white"
                  onClick={onEditSources}
                >
                  <p className="text-sm font-semibold">Edit sources</p>
                  <p className="mt-2 text-sm leading-6 opacity-70">
                    Update the GA4 property and Google Ads IDs Maia uses in chat.
                  </p>
                  <div className="mt-4 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em]">
                    Open editor
                    <ArrowRight className="h-3.5 w-3.5" />
                  </div>
                </button>

                <button
                  type="button"
                  className="rounded-[24px] border border-black/[0.06] bg-white px-5 py-5 text-left shadow-[0_12px_28px_rgba(17,17,17,0.04)] transition hover:bg-black hover:text-white"
                  onClick={onManageAccess}
                >
                  <p className="text-sm font-semibold">Manage access</p>
                  <p className="mt-2 text-sm leading-6 opacity-70">
                    Assign or remove Maia users who can select this company.
                  </p>
                  <div className="mt-4 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em]">
                    Open access
                    <ArrowRight className="h-3.5 w-3.5" />
                  </div>
                </button>
              </div>

              <div className="mt-6 flex justify-end">
                <Button type="button" variant="secondary" className="h-11 rounded-[18px] px-4" onClick={onDelete}>
                  <Trash2 className="h-4 w-4" />
                  Delete company
                </Button>
              </div>
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CompanyAccessDialog({
  company,
  open,
  onOpenChange,
}: {
  company: Company | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const companyUsers = useCompanyStore((state) => state.companyUsers);
  const assignedCount = company ? (companyUsers[company.id] ?? []).length : 0;
  const {
    handleOpenChange,
    handlePointerDownOutside,
    handleEscapeKeyDown,
    handleFocusOutside,
    handleInteractOutside,
    requestClose,
  } = useDialogDismiss(() => onOpenChange(false));

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/18 backdrop-blur-[18px]" onDoubleClick={requestClose} />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[100] w-[min(900px,calc(100vw-2rem))] max-h-[min(860px,calc(100vh-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[30px] border border-black/[0.06] bg-white p-6 shadow-[0_24px_60px_rgba(17,17,17,0.12)] outline-none"
          onPointerDownOutside={handlePointerDownOutside}
          onEscapeKeyDown={handleEscapeKeyDown}
          onFocusOutside={handleFocusOutside}
          onInteractOutside={handleInteractOutside}
        >
          {company ? (
            <>
              <div className="rounded-[28px] border border-black/[0.06] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(247,247,246,0.95))] p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.84)]">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-4">
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-black text-lg font-semibold text-white shadow-[0_14px_30px_rgba(17,17,17,0.12)]">
                      {company.name.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="max-w-2xl">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Company access</p>
                      <Dialog.Title className="mt-2 font-display text-[1.95rem] font-semibold tracking-[-0.05em] text-ink">
                        {company.name}
                      </Dialog.Title>
                      <p className="mt-2 text-sm leading-6 text-muted">
                        Manage which Maia users can access this company in Google Analytics and Google Ads mode.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="hidden rounded-[20px] border border-black/[0.06] bg-white/92 px-4 py-3 shadow-[0_10px_24px_rgba(17,17,17,0.04)] sm:block">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Access</p>
                      <p className="mt-1 text-lg font-semibold tracking-[-0.03em] text-ink">{assignedCount}</p>
                    </div>
                    <button
                      type="button"
                      className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
                      aria-label="Close company access"
                      onClick={requestClose}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <div className="mt-5 flex flex-wrap gap-2">
                  <span className="rounded-full bg-black px-3 py-1 text-xs font-semibold text-white">
                    {company.ga4_property_id ? "GA4 connected" : "GA4 missing"}
                  </span>
                  <span className="rounded-full bg-black/[0.06] px-3 py-1 text-xs font-semibold text-ink">
                    {company.google_ads_customer_id ? "Ads connected" : "Ads missing"}
                  </span>
                  <span className="rounded-full bg-black/[0.06] px-3 py-1 text-xs font-semibold text-ink">
                    {assignedCount} users assigned
                  </span>
                </div>
              </div>

              <div className="mt-6">
                <CompanyUserPanel companyId={company.id} />
              </div>
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function CompanyManager() {
  const companies = useCompanyStore((state) => state.companies);
  const companyUsers = useCompanyStore((state) => state.companyUsers);
  const deletedCompanyIds = useCompanyStore((state) => state.deletedCompanyIds);
  const fetchCompanies = useCompanyStore((state) => state.fetchCompanies);
  const createCompany = useCompanyStore((state) => state.createCompany);
  const updateCompany = useCompanyStore((state) => state.updateCompany);
  const deleteCompany = useCompanyStore((state) => state.deleteCompany);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [detailCompanyId, setDetailCompanyId] = useState<string | null>(null);
  const [accessCompanyId, setAccessCompanyId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CompanyDraft>({
    name: "",
    ga4_property_id: "",
    google_ads_customer_id: "",
    google_ads_login_customer_id: "",
  });
  const [editing, setEditing] = useState<Company | null>(null);
  const [companyDialogOpen, setCompanyDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Company | null>(null);
  const [deletingCompany, setDeletingCompany] = useState(false);

  useEffect(() => {
    if (!companies.length) {
      void fetchCompanies();
    }
  }, [companies.length, fetchCompanies]);

  const filteredCompanies = useMemo(() => {
    const needle = catalogQuery.trim().toLowerCase();
    if (!needle) {
      return companies;
    }

    return companies.filter((company) => {
      return (
        company.name.toLowerCase().includes(needle) ||
        (company.ga4_property_id ?? "").toLowerCase().includes(needle) ||
        (company.google_ads_customer_id ?? "").toLowerCase().includes(needle)
      );
    });
  }, [catalogQuery, companies]);
  const ga4LinkedCount = useMemo(
    () => companies.filter((company) => !!company.ga4_property_id).length,
    [companies],
  );
  const adsLinkedCount = useMemo(
    () => companies.filter((company) => !!company.google_ads_customer_id).length,
    [companies],
  );
  const configuredCount = useMemo(
    () => companies.filter((company) => !!company.ga4_property_id || !!company.google_ads_customer_id).length,
    [companies],
  );
  const detailCompany = useMemo(
    () => companies.find((company) => company.id === detailCompanyId) ?? null,
    [companies, detailCompanyId],
  );
  const accessCompany = useMemo(
    () => companies.find((company) => company.id === accessCompanyId) ?? null,
    [companies, accessCompanyId],
  );
  const detailAssignedCount = detailCompany ? (companyUsers[detailCompany.id] ?? []).length : 0;

  function resetDraft() {
    setDraft({
      name: "",
      ga4_property_id: "",
      google_ads_customer_id: "",
      google_ads_login_customer_id: "",
    });
    setEditing(null);
  }

  function closeCompanyDialog() {
    setCompanyDialogOpen(false);
    resetDraft();
  }

  function openCreateDialog() {
    resetDraft();
    setCompanyDialogOpen(true);
  }

  function openEditDialog(company: Company) {
    setEditing(company);
    setDraft({
      name: company.name,
      ga4_property_id: company.ga4_property_id ?? "",
      google_ads_customer_id: company.google_ads_customer_id ?? "",
      google_ads_login_customer_id: company.google_ads_login_customer_id ?? "",
    });
    setCompanyDialogOpen(true);
  }

  const {
    handleOpenChange,
    handlePointerDownOutside,
    handleEscapeKeyDown,
    handleFocusOutside,
    handleInteractOutside,
    requestClose,
  } = useDialogDismiss(closeCompanyDialog);

  async function handleSubmit() {
    if (!draft.name.trim()) {
      return;
    }

    const payload = {
      name: draft.name.trim(),
      ga4_property_id: draft.ga4_property_id.trim() || null,
      google_ads_customer_id: draft.google_ads_customer_id.trim() || null,
      google_ads_login_customer_id: draft.google_ads_login_customer_id.trim() || null,
    };

    if (editing) {
      await updateCompany(editing.id, payload);
      setDetailCompanyId(editing.id);
    } else {
      const company = await createCompany(payload);
      setDetailCompanyId(company.id);
    }

    closeCompanyDialog();
  }

  return (
    <>
      <div className="space-y-5">
        <div className="rounded-[28px] border border-black/[0.06] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(247,247,246,0.96))] p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div className="max-w-2xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Company sources</p>
              <p className="mt-2 font-display text-[1.6rem] font-semibold tracking-[-0.04em] text-ink">
                One calm catalog for Google source ownership
              </p>
              <p className="mt-2 text-sm leading-6 text-muted">
                Keep the main view focused on discovery. Open a company to review sources, then use dedicated popups for edits and access management.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              {[
                { label: "Companies", value: companies.length },
                { label: "Configured", value: configuredCount },
                { label: "GA4 linked", value: ga4LinkedCount },
                { label: "Ads linked", value: adsLinkedCount },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="min-w-[120px] rounded-[20px] bg-black/[0.03] px-4 py-3"
                >
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">{stat.label}</p>
                  <p className="mt-2 text-[1.35rem] font-semibold tracking-[-0.04em] text-ink">{stat.value}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-[28px] border border-black/[0.06] bg-white/84 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-ink">Catalog</p>
              <p className="mt-1 text-xs leading-5 text-muted">
                Pick a company to open its dedicated detail popup, or create a new one.
              </p>
            </div>
            <Button type="button" className="h-10 rounded-[16px] px-4" onClick={openCreateDialog}>
              <Plus className="h-4 w-4" />
              Create company
            </Button>
          </div>

          <div className="relative mt-4">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <Input
              className="pl-11"
              placeholder="Search companies..."
              value={catalogQuery}
              onChange={(event) => setCatalogQuery(event.target.value)}
            />
          </div>

          <div className="mt-5 grid gap-3 xl:grid-cols-2">
            {filteredCompanies.length ? (
              filteredCompanies.map((company) => {
                const isDeleted = !!deletedCompanyIds[company.id];
                const assignedCount = companyUsers[company.id]?.length ?? 0;

                return (
                  <div
                    key={company.id}
                    className={`rounded-[22px] border px-5 py-5 ${
                      isDeleted
                        ? "border-danger/20 bg-danger/5 opacity-70"
                        : "border-black/[0.06] bg-[linear-gradient(180deg,rgba(255,255,255,0.98),rgba(247,247,246,0.94))] shadow-[0_12px_28px_rgba(17,17,17,0.04)]"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-base font-semibold text-ink">{isDeleted ? "Deleted" : company.name}</p>
                        <p className="mt-2 text-sm text-muted">
                          {isDeleted
                            ? "Deleting..."
                            : "Review sources and open a focused popup for edits or access."}
                        </p>
                      </div>

                      {!isDeleted ? (
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() => openEditDialog(company)}
                          >
                            <PencilLine className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() => setDeleteTarget(company)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ) : null}
                    </div>

                    {!isDeleted ? (
                      <>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <span className="rounded-full bg-black px-3 py-1 text-xs font-semibold text-white">
                            {company.ga4_property_id ? "GA4 connected" : "GA4 missing"}
                          </span>
                          <span className="rounded-full bg-black/[0.06] px-3 py-1 text-xs font-semibold text-ink">
                            {company.google_ads_customer_id ? "Ads connected" : "Ads missing"}
                          </span>
                          <span className="rounded-full bg-black/[0.06] px-3 py-1 text-xs font-semibold text-ink">
                            {assignedCount} users
                          </span>
                        </div>

                        <div className="mt-5 flex justify-end">
                          <Button
                            type="button"
                            variant="secondary"
                            className="h-10 rounded-[16px] px-4"
                            onClick={() => setDetailCompanyId(company.id)}
                          >
                            Open details
                            <ArrowRight className="h-4 w-4" />
                          </Button>
                        </div>
                      </>
                    ) : null}
                  </div>
                );
              })
            ) : (
              <div className="col-span-full rounded-[22px] border border-dashed border-black/[0.08] bg-black/[0.02] px-5 py-10 text-center text-sm text-muted">
                {companies.length ? "No companies match this search." : "No companies yet."}
              </div>
            )}
          </div>
        </div>
      </div>

      <CompanyDetailDialog
        company={detailCompany}
        assignedCount={detailAssignedCount}
        open={detailCompany !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDetailCompanyId(null);
          }
        }}
        onEditSources={() => {
          if (!detailCompany) {
            return;
          }
          openEditDialog(detailCompany);
        }}
        onManageAccess={() => {
          if (!detailCompany) {
            return;
          }
          setAccessCompanyId(detailCompany.id);
        }}
        onDelete={() => {
          if (!detailCompany) {
            return;
          }
          setDeleteTarget(detailCompany);
        }}
      />

      <CompanyAccessDialog
        company={accessCompany}
        open={accessCompany !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAccessCompanyId(null);
          }
        }}
      />

      <Dialog.Root open={companyDialogOpen} onOpenChange={handleOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/18 backdrop-blur-[18px]" onDoubleClick={requestClose} />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-[80] w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[30px] border border-black/[0.06] bg-white p-6 shadow-[0_24px_60px_rgba(17,17,17,0.12)] outline-none"
            onPointerDownOutside={handlePointerDownOutside}
            onEscapeKeyDown={handleEscapeKeyDown}
            onFocusOutside={handleFocusOutside}
            onInteractOutside={handleInteractOutside}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="font-display text-[1.5rem] font-semibold tracking-[-0.04em] text-ink">
                  {editing ? "Edit company" : "Create company"}
                </Dialog.Title>
                <p className="mt-2 text-sm leading-6 text-muted">
                  Add the company name and the Google Analytics / Google Ads IDs Maia will use later in chat.
                </p>
              </div>
              <button
                type="button"
                className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
                aria-label="Close company dialog"
                onClick={requestClose}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-5 space-y-3">
              <Input
                placeholder="Company name"
                value={draft.name}
                onChange={(event) => setDraft((state) => ({ ...state, name: event.target.value }))}
              />
              <Input
                placeholder="GA4 property ID"
                value={draft.ga4_property_id}
                onChange={(event) => setDraft((state) => ({ ...state, ga4_property_id: event.target.value }))}
              />
              <Input
                placeholder="Google Ads customer ID"
                value={draft.google_ads_customer_id}
                onChange={(event) =>
                  setDraft((state) => ({ ...state, google_ads_customer_id: event.target.value }))
                }
              />
              <Input
                placeholder="Google Ads login customer ID (optional)"
                value={draft.google_ads_login_customer_id}
                onChange={(event) =>
                  setDraft((state) => ({
                    ...state,
                    google_ads_login_customer_id: event.target.value,
                  }))
                }
              />
              <Button type="button" className="w-full" onClick={() => void handleSubmit()}>
                <Plus className="h-4 w-4" />
                {editing ? "Save company" : "Create company"}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <DeleteConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
        title="Delete company"
        description={
          <>
            Type <span className="font-semibold text-ink">delete</span> to remove{" "}
            <span className="font-semibold text-ink">{deleteTarget?.name ?? "this company"}</span>.
          </>
        }
        confirmLabel="Delete company"
        isDeleting={deletingCompany}
        onConfirm={async () => {
          if (!deleteTarget) {
            return;
          }
          setDeletingCompany(true);
          try {
            await deleteCompany(deleteTarget.id);
            if (detailCompanyId === deleteTarget.id) {
              setDetailCompanyId(null);
            }
            if (accessCompanyId === deleteTarget.id) {
              setAccessCompanyId(null);
            }
            setDeleteTarget(null);
          } finally {
            setDeletingCompany(false);
          }
        }}
      />
    </>
  );
}
