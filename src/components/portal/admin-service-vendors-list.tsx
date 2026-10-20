"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MapPin, Phone, Wrench, BellOff } from "lucide-react";
import { PortalEntryRow, type PortalEntryRowFact } from "@/components/portal/portal-entry-row";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { Button } from "@/components/ui/button";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { fetchWithTimeout, FetchTimeoutError } from "@/lib/auth/fetch-with-timeout";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { cleanServiceVendorInput, serviceVendorTradeLabels, type ServiceVendorView } from "@/lib/service/service-vendors";
import { VENDOR_TRADE_OPTIONS_DISPATCH } from "@/lib/vendor-dispatch/vendor-roles";

const FETCH_TIMEOUT_MS = 25_000;
const API = "/api/admin/service-vendors";

type State =
  | { status: "loading" }
  | { status: "ready"; configured: boolean; vendors: ServiceVendorView[] }
  | { status: "error"; message: string };

export function formatUsPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "").slice(-10);
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : e164;
}

/** The glyph facts on a roster row: phone, trades, and the one status that matters (paused or opted out). */
export function serviceVendorFacts(vendor: ServiceVendorView): PortalEntryRowFact[] {
  const facts: PortalEntryRowFact[] = [
    { icon: Phone, label: formatUsPhone(vendor.phone), srLabel: "Phone" },
    { icon: Wrench, label: serviceVendorTradeLabels(vendor.trades).join(", ") || "No trade", srLabel: "Trades" },
  ];
  if (vendor.optedOut) facts.push({ icon: BellOff, label: "Opted out", srLabel: "Texts" });
  else if (vendor.paused) facts.push({ icon: BellOff, label: "Paused", srLabel: "Texts" });
  return facts;
}

/**
 * Admin > Service > Vendors: the people an admin knows who are willing to do work, one list for every PropLane Service
 * workspace. A job in any service workspace is texted to the roster vendors of its trade from the PropLane line.
 * The round + (in the page band) adds one; the selected row's bar edits, pauses or removes.
 */
export function AdminServiceVendorsList({ addOpen, onAddClose }: { addOpen: boolean; onAddClose: () => void }) {
  const { showToast } = useAppUi();
  const [state, setState] = useState<State>({ status: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ServiceVendorView | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [trades, setTrades] = useState<string[]>([]);
  const [area, setArea] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const formOpen = addOpen || editing !== null;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithTimeout(API, { credentials: "include" }, FETCH_TIMEOUT_MS);
        const json = (await res.json().catch(() => ({}))) as { configured?: boolean; vendors?: ServiceVendorView[] };
        if (cancelled) return;
        if (!res.ok || !json.vendors) {
          setState({ status: "error", message: "Could not load the vendors." });
          return;
        }
        setState({ status: "ready", configured: json.configured !== false, vendors: json.vendors });
      } catch (error) {
        if (!cancelled) setState({ status: "error", message: error instanceof FetchTimeoutError ? "That took too long to load." : "Could not load the vendors." });
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

  useEffect(() => {
    if (!addOpen) return;
    setName("");
    setPhone("");
    setTrades([]);
    setArea("");
    setFormError(null);
  }, [addOpen]);

  const vendors = useMemo(() => (state.status === "ready" ? state.vendors : []), [state]);
  const selected = vendors.find((v) => v.id === selectedId) ?? null;
  const parsed = cleanServiceVendorInput({ name, phone, trades, area });

  const closeForm = () => {
    setEditing(null);
    onAddClose();
  };

  const call = async (method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown>) => {
    const res = await fetchWithTimeout(API, { method, credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, FETCH_TIMEOUT_MS);
    const json = (await res.json().catch(() => ({}))) as { error?: string; intro?: string };
    return { ok: res.ok, json };
  };

  const save = async () => {
    if (!parsed.ok || busy) return;
    setBusy(true);
    setFormError(null);
    try {
      const { ok, json } = editing
        ? await call("PATCH", { id: editing.id, name, phone, trades, area })
        : await call("POST", { name, phone, trades, area });
      if (!ok) {
        setFormError(json.error ?? "Could not save the vendor.");
        return;
      }
      closeForm();
      showToast(
        editing
          ? "Vendor saved."
          : json.intro === "opted_out"
            ? "Added. That number opted out, so no text was sent."
            : json.intro === "sent"
              ? "Added. We texted them an intro."
              : "Added.",
      );
      reload();
    } catch {
      setFormError("Could not save the vendor.");
    } finally {
      setBusy(false);
    }
  };

  const togglePause = async (vendor: ServiceVendorView) => {
    setBusy(true);
    try {
      const { ok, json } = await call("PATCH", { id: vendor.id, paused: !vendor.paused });
      if (!ok) showToast(json.error ?? "Could not update the vendor.");
      reload();
    } catch {
      showToast("Could not update the vendor.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (vendor: ServiceVendorView) => {
    setBusy(true);
    try {
      const { ok, json } = await call("DELETE", { id: vendor.id });
      if (!ok) {
        showToast(json.error ?? "Could not remove the vendor.");
        return;
      }
      setSelectedId(null);
      showToast("Vendor removed.");
      reload();
    } catch {
      showToast("Could not remove the vendor.");
    } finally {
      setBusy(false);
    }
  };

  const bulkActions = selected ? (
    <>
      <Button
        type="button"
        variant="outline"
        className={PORTAL_BULK_BAR_BTN}
        data-attr="admin-service-vendor-edit"
        onClick={() => {
          setFormError(null);
          setName(selected.name);
          setPhone(selected.phone);
          setTrades(selected.trades);
          setArea(selected.area);
          setEditing(selected);
        }}
      >
        Edit
      </Button>
      <Button type="button" variant="outline" className={PORTAL_BULK_BAR_BTN} data-attr="admin-service-vendor-pause" disabled={busy} onClick={() => void togglePause(selected)}>
        {selected.paused ? "Resume" : "Pause"}
      </Button>
      <Button type="button" variant="danger" className={PORTAL_BULK_BAR_BTN} data-attr="admin-service-vendor-remove" disabled={busy} onClick={() => void remove(selected)}>
        Remove
      </Button>
    </>
  ) : null;

  const notConfigured = state.status === "ready" && !state.configured;

  return (
    <>
      <PortalRecordListSurface
        loading={state.status === "loading"}
        loadError={state.status === "error" ? state.message : undefined}
        onRetry={reload}
        isEmpty={vendors.length === 0}
        empty={<PortalDataTableEmpty icon="data" message={notConfigured ? "The service owner is not set up" : "No vendors yet"} />}
        bulkCount={selected ? 1 : 0}
        bulkActions={bulkActions}
        onBulkClear={() => setSelectedId(null)}
        dataAttr="admin-service-vendor-list"
      >
        {vendors.map((vendor) => (
          <PortalEntryRow
            key={vendor.id}
            tile={{ kind: "initials", label: vendor.name }}
            title={vendor.name}
            place={vendor.area || undefined}
            facts={serviceVendorFacts(vendor)}
            checked={selectedId === vendor.id}
            onSelectedChange={(on) => setSelectedId(on ? vendor.id : null)}
            omitActionView
            dataAttr="admin-service-vendor-row"
          />
        ))}
      </PortalRecordListSurface>

      <Modal
        open={formOpen}
        title={editing ? "Edit vendor" : "Add vendor"}
        onClose={closeForm}
        contextPanel={null}
        preview={null}
        dataAttr="admin-service-vendor-modal"
        footer={
          <ModalFooter>
            <Button type="button" disabled={busy || !parsed.ok} data-attr="admin-service-vendor-save" onClick={() => void save()}>
              {editing ? "Save" : "Add"}
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-3">
          <label className="block text-[13px] font-semibold text-foreground">
            <span className="mb-1 block">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} data-attr="admin-service-vendor-name" />
          </label>
          <label className="block text-[13px] font-semibold text-foreground">
            <span className="mb-1 block">Phone</span>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" maxLength={24} data-attr="admin-service-vendor-phone" />
          </label>
          <CheckboxMultiSelect
            label="Trades"
            options={VENDOR_TRADE_OPTIONS_DISPATCH.map((t) => ({ value: t.value, label: t.label }))}
            selected={trades}
            onChange={setTrades}
            emptyLabel="Choose trades"
            searchPlaceholder="Search trades"
            dataAttr="admin-service-vendor-trades"
          />
          <label className="block text-[13px] font-semibold text-foreground">
            <span className="mb-1 block">Area</span>
            <span className="relative block">
              <MapPin className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <Input value={area} onChange={(e) => setArea(e.target.value)} maxLength={120} className="pl-8" data-attr="admin-service-vendor-area" />
            </span>
          </label>
        </div>
        {formError ? <p className="mt-2 text-[13px] text-[var(--status-overdue-fg)]" role="alert">{formError}</p> : null}
      </Modal>
    </>
  );
}
