"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { CalendarDays, CheckCircle2, Circle, FilePen, Flag, Landmark, Percent, UserRound, XCircle, type LucideIcon } from "lucide-react";
import { PortalStatStrip } from "@/components/portal/portal-stat-strip";
import { formatManagedUsd, managedMonthLabel } from "@/lib/managed-finance/format";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalEntryRow, type PortalEntryRowFact } from "@/components/portal/portal-entry-row";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { DateField } from "@/components/ui/date-field";
import { Input, Textarea } from "@/components/ui/input";
import { MODAL_FIELD_LABEL_CLASS, Modal, ModalFooter, PORTAL_MODAL_FORM_FIELD_CLASS } from "@/components/ui/modal";
import { fetchWithTimeout, FetchTimeoutError } from "@/lib/auth/fetch-with-timeout";
import { bpsToPercentInput, centsToDollarsInput, parseDollarsToCents, parsePercentToBps } from "@/lib/dollar-input";
import type { ManagedFeeTerms } from "@/lib/owner-management/fee-math";
import type { PlatformFinancesView } from "@/lib/managed-finance/finances.server";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";

const FETCH_TIMEOUT_MS = 25_000;

export type ManagedPolicyState = {
  id: string;
  status: "draft" | "active" | "ended";
  ownerUserId: string;
  ownerName: string;
  feeLine: string;
  terms: ManagedFeeTerms;
  effectiveFrom: string;
  sentAt: string | null;
  signedAt: string | null;
  acceptedVia: string | null;
};

export type ManagedWorkspaceRow = { id: string; name: string; managed: boolean; policy: ManagedPolicyState | null };
type Person = { userId: string; name: string; email: string };

type Loaded<T> = { status: "ready"; data: T } | { status: "error"; message: string };
type Load<T> = { status: "loading" } | Loaded<T>;

/** The state of a workspace's fee policy, as a glyph and a few words (never a pill). */
export function managedStateFact(policy: ManagedPolicyState | null): { icon: LucideIcon; label: string } {
  if (!policy) return { icon: Circle, label: "Not managed" };
  if (policy.status === "active") return { icon: CheckCircle2, label: "Active" };
  if (policy.status === "ended") return { icon: XCircle, label: "Ended" };
  return { icon: FilePen, label: "Draft" };
}

async function request<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; data: T & { error?: string } }> {
  const res = await fetchWithTimeout(url, { credentials: "include", ...init }, FETCH_TIMEOUT_MS);
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  return { ok: res.ok, data };
}

async function load<T>(url: string, failure: string): Promise<Loaded<T>> {
  try {
    const r = await request<T>(url);
    if (!r.ok) return { status: "error", message: r.data.error ?? failure };
    return { status: "ready", data: r.data };
  } catch (e) {
    return { status: "error", message: e instanceof FetchTimeoutError ? "That took too long to load." : failure };
  }
}

function ModalError({ children }: { children: ReactNode }) {
  return (
    <p className="mt-2 text-[13px] text-[var(--status-overdue-fg)]" role="alert">
      {children}
    </p>
  );
}

const APPLIES_TO_OPTIONS = [
  { value: "rent", label: "Rent only" },
  { value: "all", label: "All charges" },
];

type PolicyForm = {
  ownerUserId: string;
  sharePercent: string;
  appliesTo: "rent" | "all";
  leasingPercent: string;
  minimumDollars: string;
  effectiveFrom: string;
};

function emptyForm(): PolicyForm {
  return { ownerUserId: "", sharePercent: "90", appliesTo: "rent", leasingPercent: "0", minimumDollars: "0", effectiveFrom: pacificCalendarDateYmd() };
}

function formFromPolicy(policy: ManagedPolicyState): PolicyForm {
  return {
    ownerUserId: policy.ownerUserId,
    sharePercent: bpsToPercentInput(policy.terms.ownerShareBps),
    appliesTo: policy.terms.appliesTo,
    leasingPercent: bpsToPercentInput(policy.terms.leasingFeeBps),
    minimumDollars: centsToDollarsInput(policy.terms.minFeeCents),
    effectiveFrom: policy.effectiveFrom,
  };
}

/** Admin > Money > Managed funds: what PropLane holds for owners and vendors, and the fee policy behind each managed workspace. */
export function AdminManagedFinancePanel() {
  const [tick, setTick] = useState(0);
  const [platform, setPlatform] = useState<Load<PlatformFinancesView>>({ status: "loading" });
  const [workspaces, setWorkspaces] = useState<Load<{ workspaces: ManagedWorkspaceRow[] }>>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [p, w] = await Promise.all([
        load<PlatformFinancesView>("/api/admin/managed-finance", "Could not load the platform view."),
        load<{ workspaces: ManagedWorkspaceRow[] }>("/api/admin/managed-workspaces", "Could not load workspaces."),
      ]);
      if (cancelled) return;
      setPlatform(p);
      setWorkspaces(w);
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const reload = useCallback(() => {
    setPlatform({ status: "loading" });
    setWorkspaces({ status: "loading" });
    setTick((n) => n + 1);
  }, []);

  const rows = useMemo(() => (workspaces.status === "ready" ? workspaces.data.workspaces : []), [workspaces]);
  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const policy = selected?.policy ?? null;

  // Fee policy form (create a draft, or edit a draft).
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<PolicyForm>(emptyForm);
  const [people, setPeople] = useState<Person[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const editingDraft = policy?.status === "draft";

  const openForm = async () => {
    if (!selected) return;
    setFormError(null);
    setForm(editingDraft && policy ? formFromPolicy(policy) : emptyForm());
    setFormOpen(true);
    const r = await load<{ people: Person[] }>(`/api/admin/managed-workspaces/${encodeURIComponent(selected.id)}/policies`, "Could not load the team.");
    if (r.status === "ready") setPeople(r.data.people ?? []);
    else setFormError(r.message);
  };

  const saveForm = async () => {
    if (!selected) return;
    const ownerShareBps = parsePercentToBps(form.sharePercent, false);
    const leasingFeeBps = parsePercentToBps(form.leasingPercent);
    const minFeeCents = parseDollarsToCents(form.minimumDollars, true);
    if (!form.ownerUserId) return void setFormError("Choose the owner.");
    if (ownerShareBps === null || leasingFeeBps === null || minFeeCents === null) return void setFormError("Check the fee amounts.");
    if (!form.effectiveFrom) return void setFormError("Choose the effective date.");
    setFormError(null);
    try {
      const terms = { ownerShareBps, appliesTo: form.appliesTo, leasingFeeBps, minFeeCents };
      const r =
        editingDraft && policy
          ? await request(`/api/admin/managed-policies/${encodeURIComponent(policy.id)}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "update", ownerUserId: form.ownerUserId, effectiveFrom: form.effectiveFrom, ...terms }),
            })
          : await request(`/api/admin/managed-workspaces/${encodeURIComponent(selected.id)}/policies`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                ownerUserId: form.ownerUserId,
                effectiveFrom: form.effectiveFrom,
                ...terms,
                reserveTargetCents: 0,
                repairApprovalThresholdCents: 25_000,
              }),
            });
      if (!r.ok) return void setFormError(r.data.error ?? "Could not save the fee policy.");
      setFormOpen(false);
      setSelectedId(null);
      reload();
    } catch {
      setFormError("Could not save the fee policy.");
    }
  };

  // Attest / end.
  const patchPolicy = async (body: Record<string, unknown>): Promise<string | null> => {
    if (!policy) return "Nothing selected.";
    try {
      const r = await request<{ emailed?: boolean; texted?: boolean }>(`/api/admin/managed-policies/${encodeURIComponent(policy.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) return r.data.error ?? "Could not update the fee policy.";
      return null;
    } catch {
      return "Could not update the fee policy.";
    }
  };

  const [attestOpen, setAttestOpen] = useState(false);
  const [attestNote, setAttestNote] = useState("");
  const [attestError, setAttestError] = useState<string | null>(null);
  const attest = async () => {
    const note = attestNote.trim();
    if (note.length < 8) return void setAttestError("Write at least 8 characters.");
    setAttestError(null);
    const error = await patchPolicy({ action: "attest", note });
    if (error) return void setAttestError(error);
    setAttestOpen(false);
    setAttestNote("");
    setSelectedId(null);
    setNotice("Fee policy recorded");
    reload();
  };

  const [endOpen, setEndOpen] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const endPolicy = async () => {
    setEndError(null);
    const error = await patchPolicy({ action: "end" });
    if (error) return void setEndError(error);
    setEndOpen(false);
    setSelectedId(null);
    setNotice("Fee policy ended");
    reload();
  };

  const bulkActions = selected ? (
    <>
      {!policy || policy.status !== "draft" ? (
        <Button type="button" variant="outline" className={PORTAL_BULK_BAR_BTN} data-attr="admin-managed-setup" onClick={() => openForm()}>
          Set up fee policy
        </Button>
      ) : (
        <Button type="button" variant="outline" className={PORTAL_BULK_BAR_BTN} data-attr="admin-managed-edit" onClick={() => openForm()}>
          Edit fee policy
        </Button>
      )}
      {policy?.status === "draft" ? (
        <Button type="button" variant="outline" className={PORTAL_BULK_BAR_BTN} data-attr="admin-managed-attest" onClick={() => { setAttestError(null); setAttestOpen(true); }}>
          Record signed contract
        </Button>
      ) : null}
      {policy?.status === "active" ? (
        <Button type="button" variant="danger" className={PORTAL_BULK_BAR_BTN} data-attr="admin-managed-end" onClick={() => { setEndError(null); setEndOpen(true); }}>
          End
        </Button>
      ) : null}
    </>
  ) : null;

  const rowFacts = (row: ManagedWorkspaceRow): PortalEntryRowFact[] => {
    const state = managedStateFact(row.policy);
    const facts: PortalEntryRowFact[] = [];
    if (row.policy) facts.push({ icon: Percent, label: row.policy.feeLine, srLabel: "Fee" });
    facts.push({ icon: state.icon, label: state.label, srLabel: "State" });
    return facts;
  };

  const people_options = people.map((p) => ({ value: p.userId, label: p.email ? `${p.name} · ${p.email}` : p.name }));
  const view = platform.status === "ready" ? platform.data : null;

  return (
    <ManagerPortalPageShell title="Managed funds" hideTitleOnMobileNav navigationProvidesTitle titleInlineFilter={null} compactFilterRow>
      {platform.status === "error" ? (
        <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <span>{platform.message}</span>
          <Button variant="outline" onClick={reload} data-attr="admin-managed-retry">
            Try again
          </Button>
        </div>
      ) : null}
      {view ? (
        <PortalStatStrip
          dataAttr="admin-managed-finance-strip"
          items={[
            { id: "platform-cash", label: "Platform cash", value: formatManagedUsd(view.platformCashCents) },
            { id: "owed-owners", label: "Owed to owners", value: formatManagedUsd(view.owedToOwnersCents) },
            { id: "owed-vendors", label: "Owed to vendors", value: formatManagedUsd(view.owedToVendorsCents) },
            { id: "fee-revenue", label: "Fee revenue", value: formatManagedUsd(view.feeRevenueCents), tone: "ok" },
            { id: "stripe-available", label: "Stripe available", value: view.stripeAvailableCents === null ? "Unknown" : formatManagedUsd(view.stripeAvailableCents) },
            { id: "reconciliation", label: "Reconciliation", value: view.balanced ? "Balanced" : "Out of balance", tone: view.balanced ? "ok" : "danger" },
          ]}
        />
      ) : null}
      {notice ? (
        <p role="status" className="mb-3 text-sm font-medium text-foreground" data-attr="admin-managed-notice">
          {notice}
        </p>
      ) : null}

      <PortalListControlStack className="mb-2" variant="command" stickyDestinations={false} destinations={[]} activeDestinationId="" destinationAriaLabel="Managed workspaces" />
      <PortalRecordListSurface
        loading={workspaces.status === "loading"}
        loadError={workspaces.status === "error" ? workspaces.message : undefined}
        onRetry={reload}
        isEmpty={rows.length === 0}
        empty={<PortalDataTableEmpty icon="data" message="No workspaces" />}
        bulkCount={selected ? 1 : 0}
        bulkActions={bulkActions}
        onBulkClear={() => setSelectedId(null)}
        dataAttr="admin-managed-workspaces-list"
      >
        {rows.map((row) => (
          <PortalEntryRow
            key={row.id}
            tile={{ kind: "glyph", icon: Landmark }}
            title={row.name}
            place={row.policy?.ownerName || undefined}
            facts={rowFacts(row)}
            checked={selectedId === row.id}
            onSelectedChange={(on) => setSelectedId(on ? row.id : null)}
            dataAttr="admin-managed-workspace-row"
          />
        ))}
      </PortalRecordListSurface>

      {view && view.revenueByMonth.length > 0 ? (
        <div className="mt-5" data-attr="admin-managed-revenue">
          <p className="mb-2 border-b border-border/60 pb-1.5 text-sm font-semibold text-foreground">Fee revenue</p>
          <PortalRecordListSurface dataAttr="admin-managed-revenue-list">
            {view.revenueByMonth.map((r) => (
              <PortalEntryRow
                key={`${r.workspaceId ?? "none"}:${r.month}`}
                tile={{ kind: "glyph", icon: CalendarDays }}
                title={r.workspaceName}
                place={managedMonthLabel(r.month)}
                figure={{ value: formatManagedUsd(r.revenueCents) }}
                dataAttr="admin-managed-revenue-row"
              />
            ))}
          </PortalRecordListSurface>
        </div>
      ) : null}

      {view && view.flags.length > 0 ? (
        <div className="mt-5" data-attr="admin-managed-flags">
          <p className="mb-2 border-b border-border/60 pb-1.5 text-sm font-semibold text-foreground">Flags</p>
          <PortalRecordListSurface dataAttr="admin-managed-flags-list">
            {view.flags.map((f, i) => (
              <PortalEntryRow
                key={`${f.check}:${f.subject}:${f.day}:${i}`}
                tile={{ kind: "glyph", icon: Flag }}
                title={f.message ?? f.check}
                place={f.message ? undefined : f.subject}
                facts={[{ icon: CalendarDays, label: f.day, srLabel: "Day" }]}
                dataAttr="admin-managed-flag-row"
              />
            ))}
          </PortalRecordListSurface>
        </div>
      ) : null}

      <Modal
        open={formOpen}
        title="Fee policy"
        onClose={() => setFormOpen(false)}
        dataAttr="admin-managed-policy-modal"
        footer={
          <ModalFooter>
            <Button type="button" data-attr="admin-managed-policy-save" onClick={() => saveForm()}>
              Save
            </Button>
          </ModalFooter>
        }
      >
        <div className="flex flex-col gap-3">
          <FieldSingleSelect
            label="Owner"
            options={people_options}
            value={form.ownerUserId}
            onChange={(v) => setForm((f) => ({ ...f, ownerUserId: v }))}
            placeholder="Choose the owner"
            searchPlaceholder="Search people"
            dataAttr="admin-managed-owner"
          />
          <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
            <span className={MODAL_FIELD_LABEL_CLASS}>Owner share (%)</span>
            <Input inputMode="decimal" value={form.sharePercent} onChange={(e) => setForm((f) => ({ ...f, sharePercent: e.target.value }))} data-attr="admin-managed-share" />
          </label>
          <FieldSingleSelect
            label="Applies to"
            options={APPLIES_TO_OPTIONS}
            value={form.appliesTo}
            onChange={(v) => setForm((f) => ({ ...f, appliesTo: v === "all" ? "all" : "rent" }))}
            dataAttr="admin-managed-applies-to"
          />
          <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
            <span className={MODAL_FIELD_LABEL_CLASS}>Leasing fee (%)</span>
            <Input inputMode="decimal" value={form.leasingPercent} onChange={(e) => setForm((f) => ({ ...f, leasingPercent: e.target.value }))} data-attr="admin-managed-leasing" />
          </label>
          <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
            <span className={MODAL_FIELD_LABEL_CLASS}>Monthly minimum ($)</span>
            <Input inputMode="decimal" value={form.minimumDollars} onChange={(e) => setForm((f) => ({ ...f, minimumDollars: e.target.value }))} data-attr="admin-managed-minimum" />
          </label>
          <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
            <span className={MODAL_FIELD_LABEL_CLASS}>Effective date</span>
            <DateField value={form.effectiveFrom} max={pacificCalendarDateYmd()} onChange={(v) => setForm((f) => ({ ...f, effectiveFrom: v }))} data-attr="admin-managed-effective" />
          </div>
        </div>
        {formError ? <ModalError>{formError}</ModalError> : null}
      </Modal>

      <Modal
        open={attestOpen}
        title="Record signed contract"
        onClose={() => setAttestOpen(false)}
        dataAttr="admin-managed-attest-modal"
        footer={
          <ModalFooter>
            <Button type="button" data-attr="admin-managed-attest-save" onClick={() => attest()}>
              Record
            </Button>
          </ModalFooter>
        }
      >
        <label className={PORTAL_MODAL_FORM_FIELD_CLASS}>
          <span className={MODAL_FIELD_LABEL_CLASS}>Note</span>
          <Textarea value={attestNote} onChange={(e) => setAttestNote(e.target.value)} data-attr="admin-managed-attest-note" />
        </label>
        {attestError ? <ModalError>{attestError}</ModalError> : null}
      </Modal>

      <Modal
        open={endOpen}
        title="End fee policy"
        onClose={() => setEndOpen(false)}
        dataAttr="admin-managed-end-modal"
        footer={
          <ModalFooter>
            <Button type="button" variant="danger" data-attr="admin-managed-end-confirm" onClick={() => endPolicy()}>
              End fee policy
            </Button>
          </ModalFooter>
        }
      >
        <p className="flex items-start gap-2 text-sm text-foreground">
          <UserRound className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          <span>Rent will no longer be held for the owner of {selected?.name ?? "this workspace"}.</span>
        </p>
        {endError ? <ModalError>{endError}</ModalError> : null}
      </Modal>
    </ManagerPortalPageShell>
  );
}
