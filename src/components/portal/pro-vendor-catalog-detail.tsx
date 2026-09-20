"use client";

import { Button } from "@/components/ui/button";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { axisCatalogVendorById, formatVendorCatalogUsd, type AxisCatalogVendor } from "@/lib/axis-vendor-catalog";

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
  alreadyOwned,
  backHref,
  onAdd,
}: {
  catalogId?: string;
  vendor?: AxisCatalogVendor | null;
  alreadyOwned?: boolean;
  backHref: string;
  onAdd: (row: AxisCatalogVendor) => void;
}) {
  const row = vendor ?? axisCatalogVendorById(catalogId ?? "");
  if (!row) {
    return (
      <PortalRecordDetailPage
        title="PropLane vendor"
        backHref={backHref}
        backLabel="PropLane vendors"
        hideBackText
        dataAttrBack="vendor-catalog-back"
      >
        <div className="space-y-3" data-attr="vendor-catalog-missing">
          <p className="text-sm font-semibold">Couldn’t find that PropLane vendor.</p>
        </div>
      </PortalRecordDetailPage>
    );
  }
  return (
    <PortalRecordDetailPage
      title={row.name}
      subtitle={[row.trade, row.city].filter(Boolean).join(" · ") || undefined}
      backHref={backHref}
      backLabel="PropLane vendors"
      hideBackText
      dataAttrBack="vendor-catalog-back"
      actions={
        <Button type="button" disabled={alreadyOwned} onClick={() => onAdd(row)} data-attr="vendor-catalog-add">
          {alreadyOwned ? "Added" : "Add"}
        </Button>
      }
    >
      <div className="space-y-4" data-attr="vendor-catalog-detail">
        <div className="rounded-2xl border border-border bg-card p-4 shadow-[0_1px_2px_rgba(8,9,11,.04)]">
          <h3 className="mb-2 text-[15px] font-semibold">About</h3>
          <p className="text-[13.5px] text-foreground">{row.description}</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4 shadow-[0_1px_2px_rgba(8,9,11,.04)]">
          <Field label="Trade" value={row.trade} />
          {row.city ? <Field label="Area" value={row.city} /> : null}
          <Field label="Phone" value={row.phone} />
          <Field label="Email" value={row.email} />
          <Field label="Hourly" value={`${formatVendorCatalogUsd(row.hourlyCents)} / hr`} />
          <Field label="Typical service" value={formatVendorCatalogUsd(row.serviceCents)} />
        </div>
      </div>
    </PortalRecordDetailPage>
  );
}
