"use client";

import { useEffect, useMemo, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { CheckboxMultiSelect } from "@/components/ui/checkbox-multi-select";
import { Input } from "@/components/ui/input";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PreviewPanel } from "@/components/portal/add-workspace/parts";
import { PopupSubjectCard } from "@/components/portal/popup-live-preview";
import { MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import { parseWorkOrderCategoryFromDescription } from "@/lib/reports/formal-documents/spec";
import { workOrderGeneralArea } from "@/lib/work-order-vendor-privacy";
import {
  previewMarketplaceVendorReach,
  sendWorkOrderToVendors,
} from "@/lib/work-order-vendor-offers";
import { useAppUi } from "@/components/providers/app-ui-provider";

const RADIUS_OPTIONS = [3, 5, 10, 15];

function tradeForRow(row: DemoManagerWorkOrderRow): string {
  const fromCategory = row.category?.trim();
  if (fromCategory) {
    const label = fromCategory.charAt(0).toUpperCase() + fromCategory.slice(1);
    if (fromCategory === "hvac") return "HVAC";
    return label;
  }
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
  const [includeRoster, setIncludeRoster] = useState(true);
  const [rosterIds, setRosterIds] = useState<string[]>([]);
  const [marketplaceCount, setMarketplaceCount] = useState(0);
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

  const reachCount = marketplaceCount + (includeRoster ? rosterIds.length : 0);
  const area = row ? workOrderGeneralArea(row) : "General area";
  const photoCount = row?.photoDataUrls?.filter((u) => u.trim()).length ?? 0;

  useEffect(() => {
    if (!open || !row) return;
    let cancelled = false;
    void previewMarketplaceVendorReach(row.id, trade, radiusMi).then((count) => {
      if (!cancelled) setMarketplaceCount(count);
    });
    return () => {
      cancelled = true;
    };
  }, [open, row, trade, radiusMi]);

  const stepRadius = (delta: number) => {
    const idx = RADIUS_OPTIONS.indexOf(radiusMi as (typeof RADIUS_OPTIONS)[number]);
    const next = RADIUS_OPTIONS[Math.min(RADIUS_OPTIONS.length - 1, Math.max(0, idx + delta))] ?? radiusMi;
    setRadiusMi(next);
  };

  const submit = async () => {
    if (!row) return;
    if (reachCount === 0) {
      showToast("No vendors in range — widen the radius or pick a roster vendor.");
      return;
    }
    setBusy(true);
    try {
      const result = await sendWorkOrderToVendors(row.id, includeRoster ? rosterIds : [], {
        enabled: true,
        trade,
        radiusMi,
        budget,
        sharePhotos,
        notes,
      });
      if (!result.ok) throw new Error(result.error ?? "Could not send for bids.");
      const sent = result.sent?.length ?? reachCount;
      showToast(`Sent to ${sent} vendor${sent === 1 ? "" : "s"}.`);
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
      title="Publish to local vendors"
      contextPanel={row ? <PopupSubjectCard title={row.title} lines={[area, trade]} /> : undefined}
      previewLabel="Vendors will see"
      preview={row ? (
        <PreviewPanel
          title="What vendors see"
          name={row.title}
          sub={area}
          facts={[
            { label: "Trade", value: trade },
            { label: "Area", value: area },
            { label: "Budget", value: budget.trim() ? `$${budget.trim()}` : "Open" },
            { label: "Photos", value: sharePhotos && photoCount > 0 ? String(photoCount) : "None" },
          ]}
          creates={[
            { tone: "yes", text: "General area and distance only — no street address" },
            { tone: "yes", text: "Resident name and entry notes stay hidden until hire" },
            { tone: "no", text: "Nothing is approved until you hire a quote" },
          ]}
        />
      ) : undefined}
      primaryAction={{
        label: busy ? "Sending…" : "Publish",
        onClick: () => void submit(),
        disabled: busy || !row || reachCount === 0,
        loading: busy,
      }}
    >
      {row ? (
        <div>
          <div className="space-y-4">
            <div>
              <span className={MODAL_FIELD_LABEL_CLASS}>Trade</span>
              <p className="mt-1 text-sm font-medium text-foreground" data-attr="publish-bids-trade">{trade}</p>
            </div>
            <div>
              <span className={MODAL_FIELD_LABEL_CLASS}>Within</span>
              <div className="mt-1 flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  aria-label="Decrease radius"
                  onClick={() => stepRadius(-1)}
                  data-attr="publish-bids-radius-down"
                >
                  <Minus className="size-4" aria-hidden />
                </Button>
                <span className="min-w-[5rem] text-center text-sm font-semibold tabular-nums" data-attr="publish-bids-radius">
                  {radiusMi} mi
                </span>
                <Button
                  type="button"
                  variant="outline"
                  aria-label="Increase radius"
                  onClick={() => stepRadius(1)}
                  data-attr="publish-bids-radius-up"
                >
                  <Plus className="size-4" aria-hidden />
                </Button>
              </div>
            </div>
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
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeRoster}
                onChange={(e) => setIncludeRoster(e.target.checked)}
                data-attr="publish-bids-include-roster"
              />
              Also send to my vendors
            </label>
            {includeRoster ? (
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
            ) : null}
            <label className="block">
              <span className={MODAL_FIELD_LABEL_CLASS}>Note for vendors</span>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} data-attr="publish-bids-notes" />
            </label>
            <p className="text-xs text-muted" data-attr="publish-bids-reach-count">
              Reaching {reachCount} vendor{reachCount === 1 ? "" : "s"} ({marketplaceCount} local marketplace
              {includeRoster && rosterIds.length ? ` · ${rosterIds.length} on your roster` : ""})
            </p>
          </div>
        </div>
      ) : null}
    </PortalDialog>
  );
}
