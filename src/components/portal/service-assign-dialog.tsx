"use client";

import { useEffect, useState } from "react";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { cn } from "@/lib/utils";
import type { PublishMarketplaceOptions } from "@/lib/work-order-vendor-offers";
import type { WorkAssignee } from "@/lib/work-assignment";

export type ServiceAssignMode = "bids" | "vendor" | "team" | "me";

/** A service can be sent to at most this many vendors in one request (server-enforced too). */
export const MAX_BID_VENDORS = 10;

/** How far PropLane's own vendors are reached from the property (the existing marketplace reach). */
export const MARKETPLACE_RADIUS_OPTIONS = [3, 5, 10, 15] as const;

export type RequestBidsOptions = {
  /** The existing marketplace reach, `sendWorkOrderVendorOffers` server-side; `enabled` is false when unchecked. */
  marketplace: PublishMarketplaceOptions;
};

/**
 * "Request bids or assign": one popup for both paths, opened from the UserPlus icon of a service's
 * header, the Vendors round + and the row menus. Who does it: Request bids (your vendors, up to ten,
 * and optionally PropLane vendors near the property) - A vendor - A teammate - Me. An add-on service
 * stays with the manager team (`assignableKindsFor`), so it passes `allowVendors={false}` and sees only
 * the last two.
 */
export function ServiceAssignDialog({
  open,
  onClose,
  allowVendors,
  vendors,
  teamMembers,
  meUserId,
  trade,
  photoCount = 0,
  initialMode,
  onRequestBids,
  onAssign,
}: {
  open: boolean;
  onClose: () => void;
  allowVendors: boolean;
  vendors: ReadonlyArray<{ id: string; name: string; trade?: string | null }>;
  teamMembers: ReadonlyArray<{ userId: string; name?: string | null }>;
  meUserId: string | null;
  /** The service's trade, sent with the marketplace reach. */
  trade?: string;
  /** Resident photos on the service; the Share photos box shows only when there are some. */
  photoCount?: number;
  initialMode?: ServiceAssignMode;
  /** Sends the service to these vendors for bids. May be async; the dialog closes when it settles. */
  onRequestBids: (vendorIds: string[], options: RequestBidsOptions) => void | Promise<void>;
  onAssign: (assignee: WorkAssignee) => void | Promise<void>;
}) {
  const others = teamMembers.filter((m) => m.userId !== meUserId);
  const modes: Array<{ value: ServiceAssignMode; label: string }> = [
    ...(allowVendors ? ([{ value: "bids", label: "Request bids" }, { value: "vendor", label: "A vendor" }] as const) : []),
    ...(others.length > 0 ? ([{ value: "team", label: "A teammate" }] as const) : []),
    ...(meUserId ? ([{ value: "me", label: "Me" }] as const) : []),
  ];
  const firstMode: ServiceAssignMode = modes.find((m) => m.value === initialMode)?.value ?? modes[0]?.value ?? "me";
  const [mode, setMode] = useState<ServiceAssignMode>(firstMode);
  const [vendorIds, setVendorIds] = useState<string[]>([]);
  const [vendorId, setVendorId] = useState("");
  const [memberId, setMemberId] = useState("");
  const [marketplace, setMarketplace] = useState(false);
  const [radiusMi, setRadiusMi] = useState<number>(5);
  const [note, setNote] = useState("");
  const [sharePhotos, setSharePhotos] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode(firstMode);
    setVendorIds([]);
    setVendorId("");
    setMemberId("");
    setMarketplace(false);
    setRadiusMi(5);
    setNote("");
    setSharePhotos(true);
  }, [open, firstMode]);

  const vendorOptions = vendors.map((v) => ({ value: v.id, label: v.trade?.trim() ? `${v.name} · ${v.trade}` : v.name }));
  const pickedVendor = vendors.find((v) => v.id === vendorId);
  const pickedMember = teamMembers.find((m) => m.userId === memberId);
  const ready =
    mode === "bids" ? vendorIds.length > 0 || marketplace : mode === "vendor" ? Boolean(vendorId) : mode === "team" ? Boolean(memberId) : Boolean(meUserId);
  const primaryLabel =
    mode === "bids"
      ? `Request bids${vendorIds.length > 0 ? ` from ${vendorIds.length}` : ""}`
      : mode === "vendor"
        ? pickedVendor ? `Assign ${pickedVendor.name}` : "Assign vendor"
        : mode === "team"
          ? pickedMember ? `Assign ${pickedMember.name?.trim() || "teammate"}` : "Assign teammate"
          : "Assign to me";

  const submit = async () => {
    setBusy(true);
    try {
      if (mode === "bids") {
        await onRequestBids(vendorIds.slice(0, MAX_BID_VENDORS), {
          marketplace: {
            enabled: marketplace,
            ...(trade ? { trade } : {}),
            radiusMi,
            sharePhotos: photoCount > 0 && sharePhotos,
            notes: note.trim(),
          },
        });
      } else if (mode === "vendor") {
        if (pickedVendor) await onAssign({ type: "vendor", id: pickedVendor.id, name: pickedVendor.name });
      } else if (mode === "team") {
        if (pickedMember) await onAssign({ type: "team", id: pickedMember.userId, name: pickedMember.name?.trim() || "Teammate" });
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
      title="Request bids or assign"
      primaryAction={{ label: primaryLabel, onClick: () => void submit(), disabled: !ready || busy, loading: busy, dataAttr: "service-assign-submit" }}
    >
      <div className="space-y-4" data-attr="service-assign-dialog">
        <div>
          <span className={MODAL_FIELD_LABEL_CLASS}>Who does it</span>
          <div role="radiogroup" aria-label="Who does it" className="mt-1 flex flex-wrap gap-1 rounded-full border border-border bg-card p-1" data-attr="service-assign-mode">
            {modes.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={mode === option.value}
                disabled={busy}
                data-attr={`service-assign-mode-${option.value}`}
                onClick={() => setMode(option.value)}
                className={cn(
                  "min-h-9 flex-1 rounded-full px-3 text-[13px] font-semibold transition-colors",
                  mode === option.value ? "bg-primary/10 text-primary" : "text-muted hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        {mode === "bids" ? (
          <>
            <CheckboxMultiSelect
              label="Vendors"
              options={vendorOptions}
              selected={vendorIds}
              onChange={(next) => setVendorIds(next.slice(0, MAX_BID_VENDORS))}
              disabled={busy}
              dataAttr="service-assign-vendors"
            />
            <label className="flex flex-wrap items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={marketplace}
                disabled={busy}
                onChange={(e) => setMarketplace(e.target.checked)}
                data-attr="service-assign-marketplace"
              />
              <span>Also send to PropLane vendors within</span>
              <select
                aria-label="Marketplace radius"
                value={radiusMi}
                disabled={busy || !marketplace}
                onChange={(e) => setRadiusMi(Number(e.target.value))}
                className="h-8 rounded-lg border border-border bg-card px-2 text-sm"
                data-attr="service-assign-marketplace-radius"
              >
                {MARKETPLACE_RADIUS_OPTIONS.map((mi) => (
                  <option key={mi} value={mi}>
                    {mi} mi
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={MODAL_FIELD_LABEL_CLASS}>Note to vendors</span>
              <Input value={note} placeholder="Optional" onChange={(e) => setNote(e.target.value)} disabled={busy} data-attr="service-assign-note" />
            </label>
            {photoCount > 0 ? (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={sharePhotos} disabled={busy} onChange={(e) => setSharePhotos(e.target.checked)} data-attr="service-assign-share-photos" />
                Share photos ({photoCount})
              </label>
            ) : null}
          </>
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
