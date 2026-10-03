"use client";

import { useMemo, useState } from "react";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PreviewPanel } from "@/components/portal/add-workspace/parts";
import { MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import { parseWorkOrderCategoryFromDescription } from "@/lib/reports/formal-documents/spec";
import { workOrderGeneralArea } from "@/lib/work-order-vendor-privacy";
import { sendWorkOrderToVendors } from "@/lib/work-order-vendor-offers";
import { useAppUi } from "@/components/providers/app-ui-provider";

const RADIUS_OPTIONS = [3, 5, 10, 15];

function tradeForRow(row: DemoManagerWorkOrderRow): string {
  const fromCategory = row.category?.trim();
  if (fromCategory) return fromCategory;
  return parseWorkOrderCategoryFromDescription(row.description ?? "") ?? "Maintenance";
}

export function PublishServiceBidsModal({
  open,
  row,
  vendors,
  onClose,
  onSent,
}: {
  open: boolean;
  row: DemoManagerWorkOrderRow | null;
  vendors: ManagerVendorRow[];
  onClose: () => void;
  onSent: () => void;
}) {
  const { showToast } = useAppUi();
  const [radiusMi, setRadiusMi] = useState(5);
  const [budget, setBudget] = useState("");
  const [notes, setNotes] = useState("");
  const [sharePhotos, setSharePhotos] = useState(true);
  const [rosterIds, setRosterIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const trade = row ? tradeForRow(row) : "";
  const roster = useMemo(() => {
    const t = trade.toLowerCase();
    return [...vendors]
      .filter((v) => v.active !== false)
      .sort((a, b) => {
        const aMatch = (a.trade ?? "").toLowerCase().includes(t) ? 1 : 0;
        const bMatch = (b.trade ?? "").toLowerCase().includes(t) ? 1 : 0;
        return bMatch - aMatch || a.name.localeCompare(b.name);
      });
  }, [vendors, trade]);

  const vendorCount = rosterIds.length;
  const area = row ? workOrderGeneralArea(row) : "General area";
  const photoCount = row?.photoDataUrls?.filter((u) => u.trim()).length ?? 0;

  const submit = async () => {
    if (!row || rosterIds.length === 0) {
      showToast("Pick at least one vendor.");
      return;
    }
    setBusy(true);
    try {
      const result = await sendWorkOrderToVendors(row.id, rosterIds);
      if (!result.ok) throw new Error(result.error ?? "Could not send for bids.");
      showToast(`Sent to ${rosterIds.length} vendor${rosterIds.length === 1 ? "" : "s"}.`);
      onSent();
      onClose();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not send for bids.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <PortalDialog
      open={open}
      onClose={() => {
        if (busy) return;
        onClose();
      }}
      dismissBlocked={busy}
      title="Send for bids"
      primaryAction={{
        label: busy ? "Sending…" : "Send for bids",
        onClick: () => void submit(),
        disabled: busy || !row || rosterIds.length === 0,
        loading: busy,
      }}
    >
      {row ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,280px)]">
          <div className="space-y-4">
            <CheckboxMultiSelect
              label="Your vendors"
              options={roster.map((v) => ({
                value: v.id,
                label: v.trade?.trim() ? `${v.name} · ${v.trade}` : v.name,
              }))}
              selected={rosterIds}
              onChange={setRosterIds}
              dataAttr="publish-bids-roster"
            />
            <label className="block">
              <span className={MODAL_FIELD_LABEL_CLASS}>Local marketplace · within</span>
              <select
                className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
                value={String(radiusMi)}
                onChange={(e) => setRadiusMi(Number(e.target.value))}
                data-attr="publish-bids-radius"
              >
                {RADIUS_OPTIONS.map((m) => (
                  <option key={m} value={m}>{m} miles</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={MODAL_FIELD_LABEL_CLASS}>Budget (optional)</span>
              <Input
                inputMode="decimal"
                placeholder="No budget"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                data-attr="publish-bids-budget"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={sharePhotos}
                onChange={(e) => setSharePhotos(e.target.checked)}
                data-attr="publish-bids-share-photos"
              />
              Share resident photos ({photoCount})
            </label>
            <label className="block">
              <span className={MODAL_FIELD_LABEL_CLASS}>Note for vendors</span>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} data-attr="publish-bids-notes" />
            </label>
            <p className="text-xs text-muted">
              Reaching {vendorCount || "no"} vendor{vendorCount === 1 ? "" : "s"} on your roster. Local marketplace
              matching uses trade and radius server-side.
            </p>
          </div>
          <PreviewPanel
            title="What vendors see"
            name={row.title}
            sub={area}
            facts={[
              { label: "Trade", value: trade },
              { label: "Vendors asked", value: String(vendorCount || "—") },
              { label: "Budget", value: budget.trim() ? `$${budget.trim()}` : "Open" },
              { label: "Photos", value: sharePhotos && photoCount > 0 ? String(photoCount) : "None" },
            ]}
            creates={[
              { tone: "yes", text: "General area and distance only — no street address" },
              { tone: "yes", text: "Resident name and entry notes stay hidden until hire" },
              { tone: "no", text: "Nothing is approved until you hire a quote" },
            ]}
          />
        </div>
      ) : null}
    </PortalDialog>
  );
}
