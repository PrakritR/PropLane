"use client";

import { useEffect, useState } from "react";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalDialog } from "@/components/portal/portal-dialog";
import type { WorkAssignee } from "@/lib/work-assignment";

export type ServiceAssignMode = "bids" | "vendor" | "team" | "me";

/** A service can be sent to at most this many vendors in one request (server-enforced too). */
export const MAX_BID_VENDORS = 10;

/**
 * The Assign popup, opened from the UserPlus icon at the top right of a service's band, in the
 * standard popup frame: request bids from several vendors (maintenance only) · a vendor
 * (maintenance only) · a teammate · myself. An add-on service stays with the manager team
 * (`assignableKindsFor`), so it passes `allowVendors={false}` and sees only the last two.
 */
export function ServiceAssignDialog({
  open,
  onClose,
  allowVendors,
  vendors,
  teamMembers,
  meUserId,
  onRequestBids,
  onAssign,
}: {
  open: boolean;
  onClose: () => void;
  allowVendors: boolean;
  vendors: ReadonlyArray<{ id: string; name: string; trade?: string | null }>;
  teamMembers: ReadonlyArray<{ userId: string; name?: string | null }>;
  meUserId: string | null;
  /** Sends the service to these vendors for bids. May be async; the dialog closes when it settles. */
  onRequestBids: (vendorIds: string[]) => void | Promise<void>;
  onAssign: (assignee: WorkAssignee) => void | Promise<void>;
}) {
  const firstMode: ServiceAssignMode = allowVendors ? "bids" : meUserId ? "me" : "team";
  const [mode, setMode] = useState<ServiceAssignMode>(firstMode);
  const [vendorIds, setVendorIds] = useState<string[]>([]);
  const [vendorId, setVendorId] = useState("");
  const [memberId, setMemberId] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode(firstMode);
    setVendorIds([]);
    setVendorId("");
    setMemberId("");
  }, [open, firstMode]);

  const others = teamMembers.filter((m) => m.userId !== meUserId);
  const modeOptions = [
    ...(allowVendors ? [{ value: "bids", label: "Request bids from vendors" }, { value: "vendor", label: "A vendor" }] : []),
    ...(others.length > 0 ? [{ value: "team", label: "A teammate" }] : []),
    ...(meUserId ? [{ value: "me", label: "Myself" }] : []),
  ];
  const vendorOptions = vendors.map((v) => ({ value: v.id, label: v.trade?.trim() ? `${v.name} · ${v.trade}` : v.name }));
  const ready =
    mode === "bids" ? vendorIds.length > 0 : mode === "vendor" ? Boolean(vendorId) : mode === "team" ? Boolean(memberId) : Boolean(meUserId);
  const primaryLabel = mode === "bids" ? `Request bids${vendorIds.length > 0 ? ` from ${vendorIds.length}` : ""}` : mode === "vendor" ? "Assign vendor" : mode === "team" ? "Assign teammate" : "Assign to me";

  const submit = async () => {
    setBusy(true);
    try {
      if (mode === "bids") await onRequestBids(vendorIds.slice(0, MAX_BID_VENDORS));
      else if (mode === "vendor") {
        const vendor = vendors.find((v) => v.id === vendorId);
        if (vendor) await onAssign({ type: "vendor", id: vendor.id, name: vendor.name });
      } else if (mode === "team") {
        const member = teamMembers.find((m) => m.userId === memberId);
        if (member) await onAssign({ type: "team", id: member.userId, name: member.name?.trim() || "Teammate" });
      } else if (meUserId) {
        await onAssign({ type: "team", id: meUserId, name: "You" });
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <PortalDialog
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      dismissBlocked={busy}
      title="Assign"
      primaryAction={{ label: primaryLabel, onClick: () => void submit(), disabled: !ready || busy, loading: busy, dataAttr: "service-assign-submit" }}
    >
      <div className="space-y-4" data-attr="service-assign-dialog">
        <FieldSingleSelect label="Assign to" value={mode} options={modeOptions} onChange={(next) => setMode(next as ServiceAssignMode)} dataAttr="service-assign-mode" />
        {mode === "bids" ? (
          <CheckboxMultiSelect
            label="Vendors"
            options={vendorOptions}
            selected={vendorIds}
            onChange={(next) => setVendorIds(next.slice(0, MAX_BID_VENDORS))}
            disabled={busy}
            dataAttr="service-assign-vendors"
          />
        ) : null}
        {mode === "vendor" ? (
          <FieldSingleSelect label="Vendor" value={vendorId} options={vendorOptions} onChange={setVendorId} dataAttr="service-assign-vendor" />
        ) : null}
        {mode === "team" ? (
          <FieldSingleSelect
            label="Teammate"
            value={memberId}
            options={others.map((m) => ({ value: m.userId, label: m.name?.trim() || "Teammate" }))}
            onChange={setMemberId}
            dataAttr="service-assign-teammate"
          />
        ) : null}
      </div>
    </PortalDialog>
  );
}
