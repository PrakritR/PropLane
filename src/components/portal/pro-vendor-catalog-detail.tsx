"use client";

import { Button } from "@/components/ui/button";
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
  onBack,
  onAdd,
  onOpen,
}: {
  catalogId?: string;
  vendor?: AxisCatalogVendor | null;
  alreadyOwned?: boolean;
  onBack: () => void;
  onAdd: (row: AxisCatalogVendor) => void;
  onOpen?: () => void;
}) {
  const row = vendor ?? axisCatalogVendorById(catalogId ?? "");
  if (!row) {
    return (
      <div className="space-y-3" data-attr="vendor-catalog-missing">
        <Button type="button" variant="outline" onClick={onBack} data-attr="vendor-catalog-back">
          Back
        </Button>
        <p className="text-sm font-semibold">Couldn’t find that PropLane vendor.</p>
      </div>
    );
  }
  return (
    <div className="space-y-4" data-attr="vendor-catalog-detail">
      <Button type="button" variant="outline" onClick={onBack} data-attr="vendor-catalog-back">
        Back
      </Button>
      <div className="rounded-2xl border border-border bg-card p-4 shadow-[0_1px_2px_rgba(8,9,11,.04)]">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <h2 className="text-lg font-bold tracking-tight">{row.name}</h2>
          {alreadyOwned ? (
            <Button type="button" onClick={onOpen} data-attr="vendor-catalog-open">
              Open
            </Button>
          ) : (
            <Button type="button" onClick={() => onAdd(row)} data-attr="vendor-catalog-add">
              Add
            </Button>
          )}
        </div>
        <Field label="Trade" value={row.trade} />
        <Field label="Area" value={row.city} />
        <Field label="Phone" value={row.phone} />
        <Field label="Email" value={row.email} />
        <Field label="Hourly" value={`${formatVendorCatalogUsd(row.hourlyCents)} / hr`} />
        <Field label="Typical service" value={formatVendorCatalogUsd(row.serviceCents)} />
        <p className="mt-3 text-[13.5px] text-foreground">{row.description}</p>
      </div>
    </div>
  );
}
