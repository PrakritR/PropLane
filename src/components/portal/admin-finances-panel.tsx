"use client";

import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";

/**
 * Money > Finances. PLACEHOLDER owned by the nav/payments builder so the admin nav compiles: the
 * finances builder's real file replaces this one at merge and keeps this export name.
 */
export function AdminFinancesPanel() {
  return (
    <ManagerPortalPageShell title="Finances" hideTitleOnMobileNav navigationProvidesTitle titleInlineFilter={null} compactFilterRow>
      <PortalRecordListSurface
        isEmpty
        empty={<PortalDataTableEmpty icon="data" message="No expenses yet" />}
        dataAttr="admin-finances-list"
      />
    </ManagerPortalPageShell>
  );
}
