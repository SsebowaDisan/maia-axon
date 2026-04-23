"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState } from "react";
import { BarChart3, Building2, PencilLine, Plus, Trash2, Users, X } from "lucide-react";

import { DeleteConfirmDialog } from "@/components/shared/DeleteConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="rounded-[24px] border border-line bg-white/55 p-4">
        <p className="mb-3 text-sm font-semibold text-ink">Assigned users</p>
        <div className="space-y-3">
          {assignedUsers.length ? (
            assignedUsers.map((user) => {
              const isDeleted = !!deletedUserIds[user.id];
              return (
                <div
                  key={user.id}
                  className={`flex items-center justify-between rounded-[24px] border px-4 py-3 ${
                    isDeleted ? "border-danger/20 bg-danger/5 opacity-70" : "border-line bg-panel/80"
                  }`}
                >
                  <div>
                    <p className="text-sm font-semibold text-ink">{isDeleted ? "Deleted" : user.name}</p>
                    <p className="text-xs uppercase tracking-[0.14em] text-muted">
                      {isDeleted ? "Removing..." : user.role}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={isDeleted}
                    onClick={() => setRemoveTarget(user)}
                  >
                    {isDeleted ? "Removed" : "Remove"}
                  </Button>
                </div>
              );
            })
          ) : (
            <div className="rounded-[22px] bg-black/[0.02] px-5 py-5 text-sm text-muted">
              No users assigned yet.
            </div>
          )}
        </div>
      </div>

      <div className="rounded-[24px] border border-line bg-white/55 p-4">
        <p className="mb-3 text-sm font-semibold text-ink">Assign user</p>
        <Input
          placeholder="Search users..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="mt-3 max-h-56 space-y-2 overflow-y-auto scrollbar-thin">
          {availableUsers.length ? (
            availableUsers.map((user) => (
              <button
                key={user.id}
                type="button"
                className="flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left transition hover:bg-black/5"
                onClick={() => void assignUser(companyId, user.id)}
              >
                <span>
                  <span className="block text-sm font-medium">{user.name}</span>
                  <span className="text-xs uppercase tracking-[0.14em] text-muted">{user.role}</span>
                </span>
                <span className="text-xs text-accent">Assign</span>
              </button>
            ))
          ) : (
            <p className="text-center text-sm text-muted">No users available for assignment.</p>
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

export function CompanyManager() {
  const companies = useCompanyStore((state) => state.companies);
  const deletedCompanyIds = useCompanyStore((state) => state.deletedCompanyIds);
  const fetchCompanies = useCompanyStore((state) => state.fetchCompanies);
  const createCompany = useCompanyStore((state) => state.createCompany);
  const updateCompany = useCompanyStore((state) => state.updateCompany);
  const deleteCompany = useCompanyStore((state) => state.deleteCompany);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
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

  useEffect(() => {
    if (!selectedCompanyId && companies[0]?.id) {
      setSelectedCompanyId(companies[0].id);
    }
  }, [companies, selectedCompanyId]);

  const selectedCompany = useMemo(
    () => companies.find((company) => company.id === selectedCompanyId) ?? null,
    [companies, selectedCompanyId],
  );

  function resetDraft() {
    setDraft({
      name: "",
      ga4_property_id: "",
      google_ads_customer_id: "",
      google_ads_login_customer_id: "",
    });
    setEditing(null);
  }

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
    } else {
      const company = await createCompany(payload);
      setSelectedCompanyId(company.id);
    }

    resetDraft();
    setCompanyDialogOpen(false);
  }

  return (
    <>
      <div className="grid min-h-0 gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col overflow-hidden">
          <button
            type="button"
            className="mb-4 flex w-full items-center gap-4 rounded-[26px] border border-dashed border-line bg-white/60 px-5 py-5 text-left transition hover:bg-white/80"
            onClick={() => {
              resetDraft();
              setCompanyDialogOpen(true);
            }}
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black text-white">
              <Plus className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-semibold text-ink">Create company</p>
              <p className="mt-1 text-xs text-muted">Add a company and its Google source IDs.</p>
            </div>
          </button>

          <div className="min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-thin">
            <div className="space-y-3">
              {companies.map((company) => {
                const isDeleted = !!deletedCompanyIds[company.id];

                return (
                  <div
                    key={company.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (!isDeleted) {
                        setSelectedCompanyId(company.id);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (!isDeleted && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault();
                        setSelectedCompanyId(company.id);
                      }
                    }}
                    className={`group block w-full cursor-pointer rounded-[26px] border px-4 py-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/15 ${
                      isDeleted
                        ? "border-danger/20 bg-danger/5 opacity-70"
                        : selectedCompanyId === company.id
                          ? "border-accent bg-accentSoft/50"
                          : "border-line bg-panel/80 hover:bg-white/70"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-ink">
                          {isDeleted ? "Deleted" : company.name}
                        </p>
                        <p className="mt-1 text-xs text-muted">
                          {isDeleted
                            ? "Deleting..."
                            : `${company.ga4_property_id ? "GA4" : "No GA4"} · ${
                                company.google_ads_customer_id ? "Ads" : "No Ads"
                              }`}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          disabled={isDeleted}
                          onClick={(event) => {
                            event.stopPropagation();
                            setEditing(company);
                            setDraft({
                              name: company.name,
                              ga4_property_id: company.ga4_property_id ?? "",
                              google_ads_customer_id: company.google_ads_customer_id ?? "",
                              google_ads_login_customer_id: company.google_ads_login_customer_id ?? "",
                            });
                            setCompanyDialogOpen(true);
                          }}
                        >
                          <PencilLine className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          disabled={isDeleted}
                          onClick={(event) => {
                            event.stopPropagation();
                            setDeleteTarget(company);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}

              {!companies.length ? (
                <div className="rounded-[22px] bg-black/[0.02] px-5 py-5 text-sm text-muted">
                  No companies yet.
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex min-h-0 flex-col overflow-hidden">
          <div className="rounded-[28px] bg-black/[0.03] p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">
                  Company profile
                </p>
                <p className="mt-2 text-[1.625rem] font-semibold tracking-[-0.04em] text-ink">
                  {selectedCompany?.name ?? "Choose a company"}
                </p>
                <p className="mt-2 max-w-xl text-sm leading-6 text-muted">
                  {selectedCompany
                    ? "Manage source IDs and company-level user access here. These companies will later appear in Google mode pickers."
                    : "Select a company first or create one to begin configuring Google Analytics and Google Ads sources."}
                </p>
              </div>
              {selectedCompany ? (
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full bg-black px-3 py-1 text-xs font-semibold text-white">
                    {selectedCompany.ga4_property_id ? "GA4 connected" : "GA4 missing"}
                  </span>
                  <span className="rounded-full bg-black/[0.06] px-3 py-1 text-xs font-semibold text-ink">
                    {selectedCompany.google_ads_customer_id ? "Ads connected" : "Ads missing"}
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          <div className="mt-4 min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            {selectedCompany ? (
              <div className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-[24px] border border-line bg-white/55 p-4">
                    <div className="mb-3 flex items-center gap-3">
                      <span className="rounded-full bg-black p-2 text-white">
                        <BarChart3 className="h-4 w-4" />
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-ink">Google Analytics</p>
                        <p className="text-xs text-muted">GA4 property for this company</p>
                      </div>
                    </div>
                    <p className="text-sm text-ink">
                      {selectedCompany.ga4_property_id ?? "No property ID configured yet."}
                    </p>
                  </div>
                  <div className="rounded-[24px] border border-line bg-white/55 p-4">
                    <div className="mb-3 flex items-center gap-3">
                      <span className="rounded-full bg-black p-2 text-white">
                        <Building2 className="h-4 w-4" />
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-ink">Google Ads</p>
                        <p className="text-xs text-muted">Customer and optional manager ID</p>
                      </div>
                    </div>
                    <p className="text-sm text-ink">
                      {selectedCompany.google_ads_customer_id ?? "No customer ID configured yet."}
                    </p>
                    {selectedCompany.google_ads_login_customer_id ? (
                      <p className="mt-2 text-xs text-muted">
                        Login customer ID: {selectedCompany.google_ads_login_customer_id}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="rounded-[28px] bg-black/[0.03] p-5">
                  <div className="mb-4 flex items-center gap-3">
                    <span className="rounded-full bg-black p-2 text-white">
                      <Users className="h-4 w-4" />
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-ink">Access</p>
                      <p className="text-xs text-muted">Choose which Maia users can access this company later in Google mode pickers.</p>
                    </div>
                  </div>
                  <CompanyUserPanel companyId={selectedCompany.id} />
                </div>
              </div>
            ) : (
              <div className="rounded-[26px] border border-dashed border-line p-8 text-center text-sm text-muted">
                Create a company first, then configure source IDs and access.
              </div>
            )}
          </div>
        </div>
      </div>

      <Dialog.Root
        open={companyDialogOpen}
        onOpenChange={(open) => {
          setCompanyDialogOpen(open);
          if (!open) {
            resetDraft();
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/18 backdrop-blur-[18px]" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-[80] w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-[30px] border border-black/[0.06] bg-white p-6 shadow-[0_24px_60px_rgba(17,17,17,0.12)] outline-none"
            onPointerDownOutside={() => setCompanyDialogOpen(false)}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="font-display text-[1.5rem] font-semibold tracking-[-0.04em] text-ink">
                  {editing ? "Edit company" : "Create company"}
                </Dialog.Title>
                <p className="mt-2 text-sm leading-6 text-muted">
                  Add the company name and the Google Analytics / Google Ads source IDs Maia will use later in chat.
                </p>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-full p-2 text-muted transition hover:bg-black/[0.05] hover:text-ink"
                  aria-label="Close company dialog"
                >
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
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
                onChange={(event) =>
                  setDraft((state) => ({ ...state, ga4_property_id: event.target.value }))
                }
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
            if (selectedCompanyId === deleteTarget.id) {
              setSelectedCompanyId(null);
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
