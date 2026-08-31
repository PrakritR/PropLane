"use client";

import { DestinationNav } from "@/components/ui/destination-nav";
import {
  PROPERTY_DETAIL_SCOPE_LABELS,
  type PropertyDetailSectionTabId,
} from "@/lib/portal-detail-routes";

export function PropertyPreviewScopeNav({
  items,
  activeId,
}: {
  items: Array<{ id: PropertyDetailSectionTabId; href: string; dataAttr: string }>;
  activeId: PropertyDetailSectionTabId;
}) {
  if (items.length <= 1) return null;

  return (
    <DestinationNav
      items={items.map((item) => ({
        id: item.id,
        label: PROPERTY_DETAIL_SCOPE_LABELS[item.id],
        href: item.href,
        dataAttr: item.dataAttr,
      }))}
      activeId={activeId}
      ariaLabel="Listing scope"
      itemLayout="equal"
      centerEqualRow
      className="mb-3 rounded-2xl border border-border bg-card p-1 shadow-sm"
      data-attr="property-preview-scope-nav"
    />
  );
}
