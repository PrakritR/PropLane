/**
 * Vendor Money group routes (vendor-portal-ia-1007): Incoming payments · Outgoing payments ·
 * Finances · Documents, each its own sidebar row. Pure helpers, no React, so the renderer, the
 * links and the redirect tests all read one table.
 */

export const VENDOR_INCOMING_SEGMENTS = ["pending", "paid", "overdue"] as const;
export type VendorIncomingSegment = (typeof VENDOR_INCOMING_SEGMENTS)[number];
export const DEFAULT_VENDOR_INCOMING_SEGMENT: VendorIncomingSegment = "pending";

export const VENDOR_OUTGOING_SEGMENTS = ["this-month", "last-month", "earlier"] as const;
export type VendorOutgoingSegment = (typeof VENDOR_OUTGOING_SEGMENTS)[number];
export const DEFAULT_VENDOR_OUTGOING_SEGMENT: VendorOutgoingSegment = "this-month";

export const VENDOR_DOCUMENT_ROUTE_TABS = ["tax", "license", "insurance", "statements", "from-managers"] as const;
export type VendorDocumentRouteTab = (typeof VENDOR_DOCUMENT_ROUTE_TABS)[number];
export const DEFAULT_VENDOR_DOCUMENT_TAB: VendorDocumentRouteTab = "tax";

export function isVendorIncomingSegment(raw: string | undefined | null): raw is VendorIncomingSegment {
  return Boolean(raw) && (VENDOR_INCOMING_SEGMENTS as readonly string[]).includes(raw as string);
}

export function isVendorOutgoingSegment(raw: string | undefined | null): raw is VendorOutgoingSegment {
  return Boolean(raw) && (VENDOR_OUTGOING_SEGMENTS as readonly string[]).includes(raw as string);
}

export function isVendorDocumentRouteTab(raw: string | undefined | null): raw is VendorDocumentRouteTab {
  return Boolean(raw) && (VENDOR_DOCUMENT_ROUTE_TABS as readonly string[]).includes(raw as string);
}

export function vendorIncomingHref(basePath: string, segment: VendorIncomingSegment = DEFAULT_VENDOR_INCOMING_SEGMENT): string {
  return `${basePath}/payments/${segment}`;
}

export function vendorOutgoingHref(basePath: string, segment: VendorOutgoingSegment = DEFAULT_VENDOR_OUTGOING_SEGMENT): string {
  return `${basePath}/outgoing/${segment}`;
}

export function vendorDocumentsHref(basePath: string, tab: VendorDocumentRouteTab = DEFAULT_VENDOR_DOCUMENT_TAB): string {
  return `${basePath}/documents/${tab}`;
}

/** Documents checklist section (`VENDOR_DOCUMENT_SECTIONS` id) shown on each uploads tab. */
export const VENDOR_DOCUMENT_TAB_SECTION: Partial<Record<VendorDocumentRouteTab, string>> = {
  tax: "tax",
  license: "licensing",
  insurance: "insurance",
};

/**
 * Where an old vendor money URL lands now, or null when the URL is not a moved one. `section` is
 * the first path segment after `/vendor`, `tabParts` the rest, `tab` the `?tab=` query value.
 *
 *  - `/financials/income[/...]`            -> Incoming payments
 *  - `/financials/statements`, `/tax`      -> Documents tabs
 *  - `/financials/invoices` (bare)         -> Incoming payments
 *  - `/payments/incoming|outgoing/<x>`     -> Incoming / Outgoing payments (the manager-shaped URL)
 *  - `/profile?tab=licenses`, `/settings/licenses` -> Documents > Business license
 */
export function vendorMovedMoneyPath(
  basePath: string,
  section: string,
  tabParts: string[] | undefined,
  tab?: string | null,
): string | null {
  const first = tabParts?.[0];
  if (section === "financials") {
    if (first === "income") return vendorIncomingHref(basePath);
    if (first === "statements") return vendorDocumentsHref(basePath, "statements");
    if (first === "tax") return vendorDocumentsHref(basePath, "tax");
    if (first === "invoices" && (tabParts?.length ?? 0) === 1) return vendorIncomingHref(basePath);
    return null;
  }
  if (section === "payments") {
    if (first === "outgoing") {
      const next = tabParts?.[1];
      return vendorOutgoingHref(basePath, isVendorOutgoingSegment(next) ? next : DEFAULT_VENDOR_OUTGOING_SEGMENT);
    }
    if (first === "incoming") {
      const next = tabParts?.[1];
      return vendorIncomingHref(basePath, isVendorIncomingSegment(next) ? next : DEFAULT_VENDOR_INCOMING_SEGMENT);
    }
    return null;
  }
  if (section === "profile" && tab === "licenses") return vendorDocumentsHref(basePath, "license");
  if (section === "settings" && (first === "licenses" || (!first && tab === "licenses"))) {
    return vendorDocumentsHref(basePath, "license");
  }
  return null;
}
