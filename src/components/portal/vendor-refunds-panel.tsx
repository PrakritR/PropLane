"use client";

/**
 * PLACEHOLDER (vendor-banking-1006 part A). Part B owns this file: its version
 * (the refunds list — pending · succeeded · failed — and the Refund a payment
 * pop-up) replaces this one on merge. The export name and props are the contract
 * the Finances Refunds tab imports.
 */
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";

export function VendorRefundsPanel(props: { basePath: string }) {
  void props.basePath;
  return (
    <ManagerPortalPageShell title="Refunds" hideTitleOnMobileNav compactFilterRow>
      <PortalRecordListSurface
        isEmpty
        emptyCard={{ title: "No refunds", section: "financials", tone: "muted" }}
        dataAttr="vendor-refunds-list"
      />
    </ManagerPortalPageShell>
  );
}
