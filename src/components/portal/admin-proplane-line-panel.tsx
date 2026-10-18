"use client";

import { useCallback, useEffect, useState } from "react";
import { Layers, MapPin, Phone } from "lucide-react";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalEntryRow, type PortalEntryRowFact } from "@/components/portal/portal-entry-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { fetchWithTimeout, FetchTimeoutError } from "@/lib/auth/fetch-with-timeout";
import { formatUsPhoneDisplay } from "@/lib/phone-e164";
import {
  PROPLANE_LINE_MODES,
  PROPLANE_LINE_MODE_LABEL,
  proplaneLineStatus,
  type ProplaneLineMode,
} from "@/lib/service/proplane-line-shared";

const FETCH_TIMEOUT_MS = 25_000;
const LINE_API = "/api/admin/proplane-line";
const SERVICE_API = "/api/admin/service-workspaces";

type Line = {
  configured: boolean;
  mode: ProplaneLineMode;
  sharedNumber: string | null;
  pilotWorkspaceIds: string[];
  lastChange: { at: string; reason: string; actorUserId: string } | null;
};
type ServiceOption = { id: string; name: string };

type State =
  | { status: "loading" }
  | { status: "ready"; line: Line; services: ServiceOption[] }
  | { status: "error"; message: string };

/** The glyph facts on the PropLane line row: mode, how many workspaces answer on it. */
export function proplaneLineFacts(line: Line): PortalEntryRowFact[] {
  return [
    { icon: Layers, label: `${PROPLANE_LINE_MODE_LABEL[line.mode]} · ${proplaneLineStatus(line.mode, line.sharedNumber)}`, srLabel: "Mode" },
    { icon: MapPin, label: line.pilotWorkspaceIds.length === 0 ? "All workspaces" : `${line.pilotWorkspaceIds.length} workspaces`, srLabel: "Workspaces" },
  ];
}

/**
 * Admin > Property management > PropLane line: the number on the website that answers all housing, its mode and the
 * workspaces on it. One row; Change opens a pop-up that needs a reason (the route audits it). Never touches Twilio.
 */
export function AdminProplaneLinePanel() {
  const { showToast } = useAppUi();
  const [state, setState] = useState<State>({ status: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [selected, setSelected] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ProplaneLineMode>("per_workspace");
  const [number, setNumber] = useState("");
  const [pilot, setPilot] = useState<string[]>([]);
  const [reason, setReason] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [lineRes, svcRes] = await Promise.all([
          fetchWithTimeout(LINE_API, { credentials: "include" }, FETCH_TIMEOUT_MS),
          fetchWithTimeout(SERVICE_API, { credentials: "include" }, FETCH_TIMEOUT_MS),
        ]);
        const line = (await lineRes.json().catch(() => ({}))) as Partial<Line>;
        const svc = (await svcRes.json().catch(() => ({}))) as { workspaces?: { id: string; name: string }[] };
        if (cancelled) return;
        if (!lineRes.ok || !line.mode) {
          setState({ status: "error", message: "Could not load the PropLane line." });
          return;
        }
        setState({
          status: "ready",
          line: {
            configured: line.configured !== false,
            mode: line.mode,
            sharedNumber: line.sharedNumber ?? null,
            pilotWorkspaceIds: line.pilotWorkspaceIds ?? [],
            lastChange: line.lastChange ?? null,
          },
          services: (svc.workspaces ?? []).map((w) => ({ id: w.id, name: w.name })),
        });
      } catch (e) {
        if (cancelled) return;
        setState({ status: "error", message: e instanceof FetchTimeoutError ? "That took too long to load." : "Could not load the PropLane line." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    setReloadTick((n) => n + 1);
  }, []);

  const line = state.status === "ready" ? state.line : null;
  const services = state.status === "ready" ? state.services : [];

  const startChange = () => {
    if (!line) return;
    setMode(line.mode);
    setNumber(line.sharedNumber ?? "");
    setPilot(line.pilotWorkspaceIds);
    setReason("");
    setError(null);
    setOpen(true);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithTimeout(LINE_API, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, sharedNumber: number.trim() || null, pilotWorkspaceIds: pilot, reason }),
      }, FETCH_TIMEOUT_MS);
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(json.error ?? "Could not save the PropLane line.");
        return;
      }
      setOpen(false);
      setSelected(false);
      showToast("PropLane line updated.");
      reload();
    } catch {
      setError("Could not save the PropLane line.");
    } finally {
      setBusy(false);
    }
  };

  // Workspaces already on the line that are not service ones stay as they are; the pop-up only edits the service ones.
  const serviceIds = new Set(services.map((s) => s.id));
  const otherPilot = pilot.filter((id) => !serviceIds.has(id));
  const needsNumber = mode === "shared" && !number.trim();

  return (
    <ManagerPortalPageShell title="PropLane line" hideTitleOnMobileNav navigationProvidesTitle titleInlineFilter={null} compactFilterRow>
      <PortalListControlStack className="mb-2" variant="command" stickyDestinations={false} destinations={[]} activeDestinationId="" destinationAriaLabel="PropLane line" />
      <PortalRecordListSurface
        loading={state.status === "loading"}
        loadError={state.status === "error" ? state.message : undefined}
        onRetry={reload}
        isEmpty={!line}
        bulkCount={selected ? 1 : 0}
        bulkActions={
          line?.configured ? (
            <Button type="button" variant="outline" className={PORTAL_BULK_BAR_BTN} data-attr="admin-proplane-line-change" onClick={startChange}>
              Change
            </Button>
          ) : null
        }
        onBulkClear={() => setSelected(false)}
        dataAttr="admin-proplane-line-list"
      >
        {line ? (
          <PortalEntryRow
            tile={{ kind: "glyph", icon: Phone, label: "PropLane line" }}
            title="PropLane line"
            place={line.sharedNumber ? formatUsPhoneDisplay(line.sharedNumber) : line.configured ? "No number set" : "Not set up yet"}
            facts={proplaneLineFacts(line)}
            checked={selected}
            onSelectedChange={setSelected}
            dataAttr="admin-proplane-line-row"
          />
        ) : null}
      </PortalRecordListSurface>

      <Modal
        open={open}
        title="Change PropLane line"
        onClose={() => setOpen(false)}
        dataAttr="admin-proplane-line-modal"
        footer={
          <ModalFooter>
            <Button type="button" disabled={busy || !reason.trim() || needsNumber} data-attr="admin-proplane-line-save" onClick={() => void save()}>
              Save
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-3">
          <FieldSingleSelect
            label="Mode"
            options={PROPLANE_LINE_MODES.map((m) => ({ value: m, label: PROPLANE_LINE_MODE_LABEL[m] }))}
            value={mode}
            onChange={(v) => setMode(v as ProplaneLineMode)}
            placeholder="Choose a mode"
            searchPlaceholder="Search modes"
            dataAttr="admin-proplane-line-mode"
          />
          <label className="block text-[13px] font-semibold text-foreground">
            <span className="mb-1 block">Number</span>
            <Input value={number} onChange={(e) => setNumber(e.target.value)} inputMode="tel" placeholder="+12065550100" data-attr="admin-proplane-line-number" />
          </label>
          <CheckboxMultiSelect
            label="Workspaces on the line"
            options={services.map((s) => ({ value: s.id, label: s.name }))}
            selected={pilot.filter((id) => serviceIds.has(id))}
            onChange={(next) => setPilot([...otherPilot, ...next])}
            emptyLabel="All workspaces"
            emptyMenuText="No service workspaces"
            searchPlaceholder="Search workspaces"
            dataAttr="admin-proplane-line-pilot"
          />
          <label className="block text-[13px] font-semibold text-foreground">
            <span className="mb-1 block">Reason</span>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={280} data-attr="admin-proplane-line-reason" />
          </label>
        </div>
        {error ? <p className="mt-2 text-[13px] text-[var(--status-overdue-fg)]" role="alert">{error}</p> : null}
      </Modal>
    </ManagerPortalPageShell>
  );
}
