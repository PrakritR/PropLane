"use client";

import { useMemo } from "react";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { PortalServiceRecordRow } from "@/components/portal/portal-record-row";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import {
  readActiveManagerVendorRows,
  type ManagerVendorRow,
} from "@/lib/manager-vendors-storage";
import { formatServiceMoney } from "@/lib/manager-service-workflow";
import { parseMoneyAmount } from "@/lib/household-charges";

function vendorIncomingCents(rows: readonly DemoManagerWorkOrderRow[], vendorId: string): number {
  let total = 0;
  for (const row of rows) {
    if (row.vendorId !== vendorId) continue;
    const resident = row.residentChargeCents;
    if (resident != null) total += resident;
    else {
      const parsed = parseMoneyAmount(row.cost ?? "");
      if (Number.isFinite(parsed)) total += Math.round(parsed * 100);
    }
  }
  return total;
}

function vendorOutgoingCents(rows: readonly DemoManagerWorkOrderRow[], vendorId: string): { paid: number; owed: number } {
  let paid = 0;
  let owed = 0;
  for (const row of rows) {
    if (row.vendorId !== vendorId) continue;
    const labor = row.vendorCostCents ?? 0;
    const materials = row.materialsCostCents ?? 0;
    const total = labor + materials;
    if (row.automationStatus === "paid") paid += total;
    else if (row.automationStatus === "vendor_marked_done" || row.bucket === "completed") owed += total;
  }
  return { paid, owed };
}

export function ManagerServicesVendorsTab({
  workOrders,
  onOpenVendor,
}: {
  workOrders: readonly DemoManagerWorkOrderRow[];
  basePath?: string;
  onOpenVendor: (vendorId: string) => void;
}) {
  const vendors = useMemo(() => readActiveManagerVendorRows(), []);

  const usedVendors = useMemo(() => {
    const ids = new Set<string>();
    for (const row of workOrders) {
      if (row.vendorId) ids.add(row.vendorId);
    }
    return vendors.filter((v) => ids.has(v.id));
  }, [workOrders, vendors]);

  if (usedVendors.length === 0) {
    return (
      <PortalListEmptyCard
        title="No vendors on services yet"
        workspaceAware={false}
        dataAttr="services-vendors-empty"
      />
    );
  }

  return (
    <div className="svc30 space-y-0" data-svc-page="vendors">
      {usedVendors.map((vendor: ManagerVendorRow) => {
        const openJobs = workOrders.filter(
          (r) => r.vendorId === vendor.id && r.bucket !== "completed",
        ).length;
        const incoming = vendorIncomingCents(workOrders, vendor.id);
        const outgoing = vendorOutgoingCents(workOrders, vendor.id);
        const subtitle = [
          vendor.trade || "Vendor",
          `${openJobs} open ${openJobs === 1 ? "job" : "jobs"}`,
          `Incoming ${formatServiceMoney(incoming)}`,
          `Outgoing ${formatServiceMoney(outgoing.paid)}${outgoing.owed ? ` · ${formatServiceMoney(outgoing.owed)} to pay` : ""}`,
        ]
          .filter(Boolean)
          .join(" · ");

        return (
          <PortalServiceRecordRow
            key={vendor.id}
            title={vendor.name}
            subtitle={subtitle}
            figure={formatServiceMoney(incoming)}
            onOpen={() => onOpenVendor(vendor.id)}
            dataAttr="services-vendor-row"
            rowId={`svc-vendor-${vendor.id}`}
          />
        );
      })}
    </div>
  );
}
