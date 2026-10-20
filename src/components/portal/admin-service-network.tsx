"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, Home, Mail, MapPin, Phone, Wrench } from "lucide-react";
import { PortalEntryRow, type PortalEntryRowFact } from "@/components/portal/portal-entry-row";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { serviceVendorFacts } from "@/components/portal/admin-service-vendors-list";
import { Button } from "@/components/ui/button";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { fetchWithTimeout, FetchTimeoutError } from "@/lib/auth/fetch-with-timeout";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { joinedLabel, tradesFromLeadText, type NetworkFreeManager } from "@/lib/service/service-network";
import { cleanServiceVendorInput, serviceVendorTradeLabels, type ServiceVendorView } from "@/lib/service/service-vendors";
import { VENDOR_TRADE_OPTIONS_DISPATCH } from "@/lib/vendor-dispatch/vendor-roles";

const FETCH_TIMEOUT_MS = 25_000;

export type NetworkBucket = "leads" | "managers" | "roster";
export const NETWORK_BUCKETS: readonly { id: NetworkBucket; label: string }[] = [
  { id: "leads", label: "Vendor leads" },
  { id: "managers", label: "Free managers" },
  { id: "roster", label: "Roster" },
];

export function networkBucketFromParam(raw: string | null | undefined): NetworkBucket {
  return raw === "managers" || raw === "roster" ? raw : "leads";
}

type Lead = { id: string; phoneMasked: string; trade: string | null; area: string | null; createdAt: string };
type Workspace = { id: string; name: string };
type LoadState<T> = { status: "loading" } | { status: "ready"; items: T[] } | { status: "error"; message: string };

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
}

/** Facts on a vendor lead row: masked phone, trade, when they texted. */
export function leadFacts(lead: Lead): PortalEntryRowFact[] {
  const facts: PortalEntryRowFact[] = [{ icon: Phone, label: lead.phoneMasked, srLabel: "Phone" }];
  if (lead.trade) facts.push({ icon: Wrench, label: capitalize(lead.trade), srLabel: "Trade" });
  const when = shortDate(lead.createdAt);
  if (when) facts.push({ icon: CalendarDays, label: `Texted ${when}`, srLabel: "Texted" });
  return facts;
}

/** Facts on a free manager row: houses, city when known, joined date. */
export function freeManagerFacts(manager: NetworkFreeManager): PortalEntryRowFact[] {
  const facts: PortalEntryRowFact[] = [
    { icon: Home, label: `${manager.houseCount} ${manager.houseCount === 1 ? "house" : "houses"}`, srLabel: "Houses" },
  ];
  if (manager.city) facts.push({ icon: MapPin, label: manager.city, srLabel: "City" });
  const joined = joinedLabel(manager.joinedAt);
  if (joined) facts.push({ icon: CalendarDays, label: joined, srLabel: "Joined" });
  return facts;
}

async function load<T>(url: string, pick: (json: Record<string, unknown>) => T[] | null, failure: string): Promise<LoadState<T>> {
  try {
    const res = await fetchWithTimeout(url, { credentials: "include" }, FETCH_TIMEOUT_MS);
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const items = res.ok ? pick(json) : null;
    return items ? { status: "ready", items } : { status: "error", message: failure };
  } catch (error) {
    return { status: "error", message: error instanceof FetchTimeoutError ? "That took too long to load." : failure };
  }
}

/**
 * Admin > Service > Network: everyone who might work with PropLane, in three buckets. Vendor leads are vendors who texted the
 * PropLane line and finished intake; Add to roster creates the service roster vendor (the roster rules, intro text included)
 * and marks the lead converted. Free managers are free-tier accounts; Invite as helper sends the usual service workspace
 * invite. Roster is a read view of the vendors already on the list.
 */
export function AdminServiceNetwork({ bucket }: { bucket: NetworkBucket }) {
  const { showToast } = useAppUi();
  const navigate = usePortalNavigate();
  const [tick, setTick] = useState(0);
  const [leads, setLeads] = useState<LoadState<Lead>>({ status: "loading" });
  const [managers, setManagers] = useState<LoadState<NetworkFreeManager>>({ status: "loading" });
  const [roster, setRoster] = useState<LoadState<ServiceVendorView>>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [convert, setConvert] = useState<Lead | null>(null);
  const [name, setName] = useState("");
  const [trades, setTrades] = useState<string[]>([]);
  const [area, setArea] = useState("");
  const [inviting, setInviting] = useState<NetworkFreeManager | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");

  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (bucket === "leads") {
        const next = await load<Lead>("/api/admin/vendor-leads", (j) => (Array.isArray(j.items) ? (j.items as Lead[]) : null), "Could not load the vendor leads.");
        if (!cancelled) setLeads(next);
      } else if (bucket === "managers") {
        const next = await load<NetworkFreeManager>("/api/admin/service-network", (j) => (Array.isArray(j.managers) ? (j.managers as NetworkFreeManager[]) : null), "Could not load the free managers.");
        if (!cancelled) setManagers(next);
      } else {
        const next = await load<ServiceVendorView>("/api/admin/service-vendors", (j) => (Array.isArray(j.vendors) ? (j.vendors as ServiceVendorView[]) : null), "Could not load the roster.");
        if (!cancelled) setRoster(next);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [bucket, tick]);

  const patchLead = async (id: string, body: Record<string, unknown>) => {
    const res = await fetchWithTimeout(`/api/admin/vendor-leads/${encodeURIComponent(id)}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, FETCH_TIMEOUT_MS);
    const json = (await res.json().catch(() => ({}))) as { error?: string; intro?: string };
    return { ok: res.ok, json };
  };

  const dismiss = async (lead: Lead) => {
    setBusy(true);
    try {
      const { ok, json } = await patchLead(lead.id, { action: "decline" });
      if (!ok) showToast(json.error ?? "Could not dismiss the lead.");
      else showToast("Lead dismissed.");
      reload();
    } catch {
      showToast("Could not dismiss the lead.");
    } finally {
      setBusy(false);
    }
  };

  const openConvert = (lead: Lead) => {
    setFormError(null);
    setName("");
    setTrades(tradesFromLeadText(lead.trade));
    setArea(lead.area ?? "");
    setConvert(lead);
  };

  const parsed = cleanServiceVendorInput({ name, phone: "+12065550100", trades, area });

  const saveConvert = async () => {
    if (!convert || !parsed.ok || busy) return;
    setBusy(true);
    setFormError(null);
    try {
      const { ok, json } = await patchLead(convert.id, { action: "convert", name, trades, area });
      if (!ok) {
        setFormError(json.error ?? "Could not add the vendor.");
        return;
      }
      setConvert(null);
      showToast(json.intro === "opted_out" ? "Added. That number opted out, so no text was sent." : json.intro === "sent" ? "Added. We texted them an intro." : "Added.");
      reload();
    } catch {
      setFormError("Could not add the vendor.");
    } finally {
      setBusy(false);
    }
  };

  const openInvite = async (manager: NetworkFreeManager) => {
    setFormError(null);
    setWorkspaceId("");
    setInviting(manager);
    try {
      const res = await fetchWithTimeout("/api/admin/service-workspaces", { credentials: "include" }, FETCH_TIMEOUT_MS);
      const json = (await res.json().catch(() => ({}))) as { workspaces?: (Workspace & { canManage?: boolean })[] };
      setWorkspaces((json.workspaces ?? []).filter((w) => w.canManage !== false).map((w) => ({ id: w.id, name: w.name })));
    } catch {
      setFormError("Could not load the service workspaces.");
    }
  };

  const sendInvite = async () => {
    if (!inviting || !workspaceId || busy) return;
    setBusy(true);
    setFormError(null);
    try {
      const res = await fetchWithTimeout("/api/admin/service-workspaces", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "team-invite", id: workspaceId, proplaneId: inviting.proplaneId }),
      }, FETCH_TIMEOUT_MS);
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setFormError(json.error ?? "Could not send the invite.");
        return;
      }
      setInviting(null);
      showToast("Invite sent.");
    } catch {
      setFormError("Could not send the invite.");
    } finally {
      setBusy(false);
    }
  };

  const leadItems = useMemo(() => (leads.status === "ready" ? leads.items : []), [leads]);
  const managerItems = useMemo(() => (managers.status === "ready" ? managers.items : []), [managers]);
  const rosterItems = useMemo(() => (roster.status === "ready" ? roster.items : []), [roster]);
  const selectedLead = leadItems.find((l) => l.id === selectedId) ?? null;
  const selectedManager = managerItems.find((m) => m.id === selectedId) ?? null;

  const bucketTabs = (
    <PortalListControlStack
      className="mb-2"
      destinationNavSize="toolbar"
      stickyDestinations={false}
      destinations={NETWORK_BUCKETS.map((b) => ({ id: b.id, label: b.label, href: `/admin/service?tab=network&bucket=${b.id}`, dataAttr: `admin-service-network-${b.id}` }))}
      activeDestinationId={bucket}
      destinationAriaLabel="Network"
    />
  );

  const state = bucket === "leads" ? leads : bucket === "managers" ? managers : roster;
  const count = bucket === "leads" ? leadItems.length : bucket === "managers" ? managerItems.length : rosterItems.length;
  const emptyMessage = bucket === "leads" ? "No vendor leads waiting" : bucket === "managers" ? "No free managers yet" : "No vendors on the roster yet";

  const bulkActions =
    bucket === "leads" && selectedLead ? (
      <>
        <Button type="button" variant="outline" className={PORTAL_BULK_BAR_BTN} data-attr="admin-network-lead-add" disabled={busy} onClick={() => openConvert(selectedLead)}>
          Add to roster
        </Button>
        <Button type="button" variant="danger" className={PORTAL_BULK_BAR_BTN} data-attr="admin-network-lead-dismiss" disabled={busy} onClick={() => void dismiss(selectedLead)}>
          Dismiss
        </Button>
      </>
    ) : bucket === "managers" && selectedManager ? (
      <>
        <Button type="button" variant="outline" className={PORTAL_BULK_BAR_BTN} data-attr="admin-network-manager-message" onClick={() => navigate(`/admin/axis-users/${encodeURIComponent(selectedManager.accountKey)}`)}>
          Message
        </Button>
        <Button type="button" variant="outline" className={PORTAL_BULK_BAR_BTN} data-attr="admin-network-manager-invite" disabled={busy || !selectedManager.proplaneId} onClick={() => void openInvite(selectedManager)}>
          Invite as helper
        </Button>
      </>
    ) : null;

  return (
    <>
      {bucketTabs}
      <PortalRecordListSurface
        loading={state.status === "loading"}
        loadError={state.status === "error" ? state.message : undefined}
        onRetry={reload}
        isEmpty={count === 0}
        empty={<PortalDataTableEmpty icon="data" message={emptyMessage} />}
        bulkCount={bucket !== "roster" && selectedId ? 1 : 0}
        bulkActions={bulkActions}
        onBulkClear={bucket === "roster" ? undefined : () => setSelectedId(null)}
        dataAttr={`admin-service-network-list-${bucket}`}
      >
        {bucket === "leads"
          ? leadItems.map((lead) => (
              <PortalEntryRow
                key={lead.id}
                tile={{ kind: "initials", label: lead.trade ?? "Vendor" }}
                title={lead.trade ? `${capitalize(lead.trade)} vendor` : "New vendor"}
                place={lead.area || undefined}
                facts={leadFacts(lead)}
                checked={selectedId === lead.id}
                onSelectedChange={(on) => setSelectedId(on ? lead.id : null)}
                omitActionView
                dataAttr="admin-network-lead-row"
              />
            ))
          : bucket === "managers"
            ? managerItems.map((manager) => (
                <PortalEntryRow
                  key={manager.id}
                  tile={{ kind: "initials", label: manager.name }}
                  title={manager.name}
                  place={manager.email}
                  facts={freeManagerFacts(manager)}
                  checked={selectedId === manager.id}
                  onSelectedChange={(on) => setSelectedId(on ? manager.id : null)}
                  omitActionView
                  dataAttr="admin-network-manager-row"
                />
              ))
            : rosterItems.map((vendor) => (
                <PortalEntryRow
                  key={vendor.id}
                  tile={{ kind: "initials", label: vendor.name }}
                  title={vendor.name}
                  place={vendor.area || serviceVendorTradeLabels(vendor.trades).join(", ") || undefined}
                  facts={serviceVendorFacts(vendor)}
                  onOpen={() => navigate("/admin/service?tab=vendors")}
                  omitActionView
                  dataAttr="admin-network-roster-row"
                />
              ))}
      </PortalRecordListSurface>

      <Modal
        open={convert !== null}
        title="Add to roster"
        onClose={() => setConvert(null)}
        contextPanel={null}
        preview={null}
        dataAttr="admin-network-lead-modal"
        footer={
          <ModalFooter>
            <Button type="button" disabled={busy || !parsed.ok} data-attr="admin-network-lead-save" onClick={() => void saveConvert()}>
              Add
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-3">
          <label className="block text-[13px] font-semibold text-foreground">
            <span className="mb-1 block">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} data-attr="admin-network-lead-name" />
          </label>
          <CheckboxMultiSelect
            label="Trades"
            options={VENDOR_TRADE_OPTIONS_DISPATCH.map((t) => ({ value: t.value, label: t.label }))}
            selected={trades}
            onChange={setTrades}
            emptyLabel="Choose trades"
            searchPlaceholder="Search trades"
            dataAttr="admin-network-lead-trades"
          />
          <label className="block text-[13px] font-semibold text-foreground">
            <span className="mb-1 block">Area</span>
            <Input value={area} onChange={(e) => setArea(e.target.value)} maxLength={120} data-attr="admin-network-lead-area" />
          </label>
        </div>
        {formError ? <p className="mt-2 text-[13px] text-[var(--status-overdue-fg)]" role="alert">{formError}</p> : null}
      </Modal>

      <Modal
        open={inviting !== null}
        title="Invite as helper"
        onClose={() => setInviting(null)}
        contextPanel={null}
        preview={null}
        dataAttr="admin-network-invite-modal"
        footer={
          <ModalFooter>
            <Button type="button" disabled={busy || !workspaceId} data-attr="admin-network-invite-send" onClick={() => void sendInvite()}>
              Invite
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[14px] text-foreground">
            <Mail className="size-4 text-muted" aria-hidden />
            <span>{inviting?.name}</span>
          </div>
          <FieldSingleSelect
            label="Service workspace"
            options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
            value={workspaceId}
            onChange={setWorkspaceId}
            placeholder="Choose a workspace"
            dataAttr="admin-network-invite-workspace"
          />
        </div>
        {formError ? <p className="mt-2 text-[13px] text-[var(--status-overdue-fg)]" role="alert">{formError}</p> : null}
      </Modal>
    </>
  );
}
