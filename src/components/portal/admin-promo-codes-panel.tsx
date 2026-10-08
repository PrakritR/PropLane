"use client";

import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";

/**
 * Money > Promo codes. PLACEHOLDER owned by the nav/payments builder so the admin nav compiles:
 * the promo-code builder's real file replaces this one at merge and keeps this export name and
 * prop (`detailId`: the promo record page's URL segment, `/admin/promo-codes/<detailId>`).
 */
export function AdminPromoCodesPanel({ detailId }: { detailId?: string } = {}) {
  return (
    <ManagerPortalPageShell title="Promo codes" hideTitleOnMobileNav navigationProvidesTitle titleInlineFilter={null} compactFilterRow>
      <PortalRecordListSurface
        isEmpty
        empty={<PortalDataTableEmpty icon="data" message={detailId ? "That promo code was not found" : "No promo codes yet"} />}
        dataAttr="admin-promo-codes-list"
      />
    </ManagerPortalPageShell>
  );
}
