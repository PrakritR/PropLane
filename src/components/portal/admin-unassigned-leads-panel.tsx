"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, Clock, Wallet } from "lucide-react";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalEntryRow, type PortalEntryRowFact } from "@/components/portal/portal-entry-row";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { AdminListPager } from "@/components/portal/admin-money-ui";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { fetchWithTimeout, FetchTimeoutError } from "@/lib/auth/fetch-with-timeout";
import { formatPacificDate } from "@/lib/pacific-time";

const FETCH_TIMEOUT_MS = 25_000;
const PAGE_SIZE = 50;

export type UnassignedLeadRow = {
  id: string;
  phoneMasked: string;
  budgetMax: number | null;
  moveInDate: string | null;
  lastMessageAt: string | null;
  stage: string;
};

type House = { id: string; label: string };

type State =
  | { status: "loading" }
  | { status: "ready"; items: UnassignedLeadRow[]; total: number; houses: House[] }
  | { status: "error"; message: string };

const STAGE_LABEL: Record<string, string> = {
  qualifying: "Answering questions",
  offered: "Shown rooms",
  no_match: "No match yet",
};

/** The (at most three) glyph facts on a lead row. */
export function leadFacts(row: UnassignedLeadRow): PortalEntryRowFact[] {
  const facts: PortalEntryRowFact[] = [];
  if (row.budgetMax) facts.push({ icon: Wallet, label: `$${row.budgetMax.toLocaleString("en-US")}/mo`, srLabel: "Budget" });
  if (row.moveInDate) facts.push({ icon: CalendarDays, label: `Move-in ${formatPacificDate(row.moveInDate, { month: "short", day: "numeric" })}`, srLabel: "Move-in" });
  if (row.lastMessageAt) facts.push({ icon: Clock, label: formatPacificDate(row.lastMessageAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }), srLabel: "Last message" });
  return facts;
}

/** Admin > Accounts > Unassigned leads: strangers qualified on the shared line who have not picked a house yet. Never in a manager portal. */
export function AdminUnassignedLeadsPanel() {
  const [page, setPage] = useState(1);
  const [reloadTick, setReloadTick] = useState(0);
  const [state, setState] = useState<State>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [houseId, setHouseId] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithTimeout(`/api/admin/unassigned-leads?page=${page}&pageSize=${PAGE_SIZE}&houses=1`, {}, FETCH_TIMEOUT_MS);
        const json = (await res.json().catch(() => ({}))) as { items?: UnassignedLeadRow[]; total?: number; houses?: House[]; error?: string };
        if (cancelled) return;
        if (!res.ok || !json.items) {
          setState({ status: "error", message: "Could not load leads." });
          return;
        }
        setState({ status: "ready", items: json.items, total: json.total ?? json.items.length, houses: json.houses ?? [] });
      } catch (error) {
        if (cancelled) return;
        setState({ status: "error", message: error instanceof FetchTimeoutError ? "That took too long to load." : "Could not load leads." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [page, reloadTick]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setReloadTick((n) => n + 1);
  }, []);

  const data = state.status === "ready" ? state : null;
  const rows = useMemo(() => data?.items ?? [], [data]);
  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const houseOptions = useMemo(() => (data?.houses ?? []).map((h) => ({ value: h.id, label: h.label })), [data]);

  const patch = async (body: Record<string, unknown>) => {
    if (!selected) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetchWithTimeout(`/api/admin/unassigned-leads/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }, FETCH_TIMEOUT_MS);
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setActionError(json.error ?? "Could not update this lead.");
        return;
      }
      setAssignOpen(false);
      setHouseId("");
      setSelectedId(null);
      reload();
    } catch {
      setActionError("Could not update this lead.");
    } finally {
      setBusy(false);
    }
  };

  const bulkActions = selected ? (
    <>
      <Button type="button" variant="outline" className={PORTAL_BULK_BAR_BTN} data-attr="admin-unassigned-lead-assign" onClick={() => { setActionError(null); setAssignOpen(true); }}>
        Assign to house
      </Button>
      <Button type="button" variant="danger" className={PORTAL_BULK_BAR_BTN} data-attr="admin-unassigned-lead-close" disabled={busy} onClick={() => patch({ action: "close" })}>
        Close
      </Button>
    </>
  ) : null;

  return (
    <ManagerPortalPageShell title="Unassigned leads" hideTitleOnMobileNav navigationProvidesTitle titleInlineFilter={null} compactFilterRow>
      <PortalListControlStack className="mb-2" variant="command" stickyDestinations={false} destinations={[]} activeDestinationId="" destinationAriaLabel="Unassigned leads" />
      <PortalRecordListSurface
        loading={state.status === "loading"}
        loadError={state.status === "error" ? state.message : undefined}
        onRetry={reload}
        isEmpty={rows.length === 0}
        empty={<PortalDataTableEmpty icon="data" message="No unassigned leads" />}
        bulkCount={selected ? 1 : 0}
        bulkActions={bulkActions}
        onBulkClear={() => setSelectedId(null)}
        dataAttr="admin-unassigned-leads-list"
      >
        {rows.map((row) => (
          <PortalEntryRow
            key={row.id}
            tile={{ kind: "initials", label: row.phoneMasked.replace(/\D/g, "").slice(-2) || "L" }}
            title={`Lead ${row.phoneMasked}`}
            place={STAGE_LABEL[row.stage] ?? "Answering questions"}
            facts={leadFacts(row)}
            checked={selectedId === row.id}
            onSelectedChange={(on) => setSelectedId(on ? row.id : null)}
            dataAttr="admin-unassigned-lead-row"
          />
        ))}
        {data ? <AdminListPager page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} dataAttr="admin-unassigned-leads-pager" /> : null}
      </PortalRecordListSurface>

      <Modal
        open={assignOpen}
        title="Assign to house"
        onClose={() => setAssignOpen(false)}
        dataAttr="admin-unassigned-lead-assign-modal"
        footer={
          <ModalFooter>
            <Button type="button" disabled={!houseId || busy} data-attr="admin-unassigned-lead-assign-save" onClick={() => patch({ action: "assign", propertyId: houseId })}>
              Assign
            </Button>
          </ModalFooter>
        }
      >
        <FieldSingleSelect label="House" options={houseOptions} value={houseId} onChange={setHouseId} placeholder="Choose a house" searchPlaceholder="Search houses" dataAttr="admin-unassigned-lead-house" />
        {actionError ? <p className="mt-2 text-[13px] text-[var(--status-overdue-fg)]" role="alert">{actionError}</p> : null}
      </Modal>
    </ManagerPortalPageShell>
  );
}
