"use client";

import { axisCatalogVendorById, formatVendorCatalogUsd, type AxisCatalogVendor } from "@/lib/axis-vendor-catalog";
import type { VendorDetailTabId } from "@/lib/portal-detail-routes";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-12 border-b border-border py-2.5 text-[13.5px] last:border-b-0">
      <span className="font-semibold">{label}</span>
      <strong className="text-right font-semibold">{value}</strong>
    </div>
  );
}

export function ManagerVendorCatalogDetail({
  catalogId,
  vendor,
  tab,
}: {
  catalogId?: string;
  vendor?: AxisCatalogVendor | null;
  tab: VendorDetailTabId;
}) {
  const row = vendor ?? axisCatalogVendorById(catalogId ?? "");
  if (!row) {
    return <div className="px-3 py-8 text-sm font-semibold" data-attr="vendor-catalog-missing">Couldn’t find that PropLane vendor.</div>;
  }
  return (
    <div className="space-y-4 px-3 pb-4 pt-3 sm:px-4" data-attr="vendor-catalog-detail">
      {tab === "overview" ? (
        <div className="rounded-2xl border border-border bg-card p-4 shadow-[0_1px_2px_rgba(8,9,11,.04)]">
          <h2 className="text-[15px] font-semibold">About</h2>
          <div className="pt-3 text-[13.5px] text-foreground">{row.description}</div>
        </div>
      ) : null}
      {tab === "overview" || tab === "profile" ? (
        <div className="rounded-2xl border border-border bg-card p-4 shadow-[0_1px_2px_rgba(8,9,11,.04)]" data-attr="vendor-catalog-profile">
          <Field label="Trade" value={row.trade} />
          {row.city ? <Field label="Area" value={row.city} /> : null}
          <Field label="Phone" value={row.phone} />
          <Field label="Email" value={row.email} />
        </div>
      ) : null}
      {tab === "pricing" ? (
        <div className="rounded-2xl border border-border bg-card p-4 shadow-[0_1px_2px_rgba(8,9,11,.04)]" data-attr="vendor-catalog-pricing">
          <Field label="Hourly" value={row.hourlyCents == null ? "—" : `${formatVendorCatalogUsd(row.hourlyCents)} / hr`} />
          <Field label="Typical service" value={formatVendorCatalogUsd(row.serviceCents)} />
        </div>
      ) : null}
      {(["jobs", "reviews", "check-ins", "communication"] as VendorDetailTabId[]).includes(tab) ? (
        <div className="rounded-2xl border border-border bg-card px-4 py-8 text-center text-sm" data-attr={`vendor-catalog-empty-${tab}`}>
          No {tab === "jobs" ? "services" : tab} are available for this catalog entry.
        </div>
      ) : null}
    </div>
  );
}
