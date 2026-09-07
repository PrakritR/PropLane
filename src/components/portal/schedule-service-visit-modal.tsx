"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import {
  MANAGER_VENDORS_EVENT,
  readActiveManagerVendorRows,
  syncManagerVendorsFromServer,
} from "@/lib/manager-vendors-storage";
import {
  scheduleServiceVisit,
  type ScheduleVisitAssigneeChoice,
} from "@/lib/schedule-service-visit";

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function toDatetimeLocalValue(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fromDatetimeLocalValue(s: string): string | null {
  if (!s.trim()) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function defaultAssigneeChoice(row: DemoManagerWorkOrderRow): string {
  if (row.selfAssigned) return "self";
  if (row.vendorId?.trim()) return row.vendorId.trim();
  return "self";
}

export function ScheduleServiceVisitModal({
  open,
  row,
  onClose,
  onScheduled,
}: {
  open: boolean;
  row: DemoManagerWorkOrderRow | null;
  onClose: () => void;
  onScheduled?: () => void;
}) {
  const { showToast } = useAppUi();
  const { userId: managerUserId, email, ready: authReady } = useManagerUserId();
  const [vendorTick, setVendorTick] = useState(0);
  const [assigneeKey, setAssigneeKey] = useState("self");
  const [visitLocal, setVisitLocal] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    void syncManagerVendorsFromServer().catch(() => undefined);
  }, [open]);

  useEffect(() => {
    const onVendors = () => setVendorTick((n) => n + 1);
    window.addEventListener(MANAGER_VENDORS_EVENT, onVendors);
    return () => window.removeEventListener(MANAGER_VENDORS_EVENT, onVendors);
  }, []);

  useEffect(() => {
    if (!open || !row) return;
    setAssigneeKey(defaultAssigneeChoice(row));
    setVisitLocal(toDatetimeLocalValue(row.scheduledAtIso) || toDatetimeLocalValue(row.preferredArrival));
    setBusy(false);
  }, [open, row]);

  const vendors = useMemo(() => {
    void vendorTick;
    return readActiveManagerVendorRows();
  }, [vendorTick]);

  const propertyLine = useMemo(() => {
    if (!row) return "";
    const unit = row.unit?.trim();
    return unit ? `${row.propertyName} · ${unit}` : row.propertyName;
  }, [row]);

  const onConfirm = async () => {
    if (!row || !managerUserId || !authReady) return;
    const iso = fromDatetimeLocalValue(visitLocal);
    if (!iso) {
      showToast("Choose a visit date and time to schedule.");
      return;
    }
    let assignee: ScheduleVisitAssigneeChoice;
    if (assigneeKey === "self") {
      assignee = { kind: "self" };
    } else {
      assignee = { kind: "vendor", vendorId: assigneeKey };
    }
    setBusy(true);
    try {
      const result = await scheduleServiceVisit({
        managerUserId,
        managerName: email,
        row,
        visitAtIso: iso,
        assignee,
      });
      if (!result.ok) {
        showToast(result.error ?? "Could not schedule visit.");
        return;
      }
      showToast(
        `Service scheduled.${result.vendorEmailed ? " Vendor emailed with the visit details." : ""}`,
      );
      onScheduled?.();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open && Boolean(row)}
      title="Schedule visit"
      dense
      fullPage={false}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <ModalFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy || !row}
            onClick={() => onConfirm()}
            data-attr="schedule-service-visit-confirm"
          >
            {busy ? "Scheduling…" : "Schedule visit"}
          </Button>
        </ModalFooter>
      }
    >
      {row ? (
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium text-foreground">{row.title}</p>
            {propertyLine ? <p className="mt-0.5 text-xs text-muted">{propertyLine}</p> : null}
            {row.residentName?.trim() ? (
              <p className="mt-0.5 text-xs text-muted">Resident: {row.residentName.trim()}</p>
            ) : null}
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted">Assign to</span>
            <Select
              value={assigneeKey}
              onChange={(e) => setAssigneeKey(e.target.value)}
              disabled={busy}
              data-attr="schedule-service-visit-assignee"
            >
              <option value="self">You (manager)</option>
              {vendors.map((vendor) => (
                <option key={vendor.id} value={vendor.id}>
                  {vendor.name}
                  {vendor.trade?.trim() ? ` · ${vendor.trade.trim()}` : ""}
                </option>
              ))}
            </Select>
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted">Visit arrival</span>
            <Input
              type="datetime-local"
              value={visitLocal}
              onChange={(e) => setVisitLocal(e.target.value)}
              disabled={busy}
              data-attr="schedule-service-visit-datetime"
            />
          </label>

          <p className="text-xs text-muted">
            On confirm we create a task for the assignee, notify the resident, email the vendor when
            one is assigned, and leave a note in your inbox.
          </p>
        </div>
      ) : null}
    </Modal>
  );
}
