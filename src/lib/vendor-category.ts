/**
 * A vendor's category is the trade they do (Plumbing, HVAC, Electrical, …). The
 * Vendors lists group by it and the Filter popover's Category field narrows by
 * it, on both tabs: the manager's own roster and the PropLane directory.
 *
 * Trades are free text on the manager's Add vendor form and a fixed pick list on
 * the vendor's own onboarding, so "plumbing", "Plumbing " and "PLUMBING" are one
 * category, shown in the pick list's spelling.
 */
import { VENDOR_TRADE_OPTIONS } from "@/lib/work-order-taxonomy";

/** The catch-all category: a vendor with no trade, or one who picked "Other". */
export const VENDOR_OTHER_CATEGORY = "Other";

const CANONICAL_BY_LOWER = new Map<string, string>(VENDOR_TRADE_OPTIONS.map((trade) => [trade.toLowerCase(), trade]));

/** One trade string as its category: the pick list's spelling, or the typed text with a capital first letter. */
export function canonicalVendorCategory(raw: string | null | undefined): string {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const known = CANONICAL_BY_LOWER.get(text.toLowerCase());
  if (known) return known;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Every category a vendor works in, the primary trade first. A vendor with no
 * trade at all is `["Other"]` so it still lands in a group.
 */
export function vendorCategories(row: { trade?: string | null; trades?: readonly string[] | null }): string[] {
  const source = row.trades?.length ? row.trades : [row.trade];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of source) {
    const category = canonicalVendorCategory(raw);
    const key = category.toLowerCase();
    if (!category || seen.has(key)) continue;
    seen.add(key);
    out.push(category);
  }
  return out.length ? out : [VENDOR_OTHER_CATEGORY];
}

/** True when no category is selected, or the vendor works in any selected one. */
export function vendorMatchesCategories(
  row: { trade?: string | null; trades?: readonly string[] | null },
  selected: readonly string[],
): boolean {
  if (selected.length === 0) return true;
  const wanted = new Set(selected.map((category) => category.toLowerCase()));
  return vendorCategories(row).some((category) => wanted.has(category.toLowerCase()));
}

/**
 * The group a vendor is listed under: with a category filter on, the first
 * selected category they work in (so filtering HVAC never files an HVAC vendor
 * under Plumbing); otherwise their primary trade.
 */
export function vendorGroupCategory(
  row: { trade?: string | null; trades?: readonly string[] | null },
  selected: readonly string[] = [],
): string {
  const categories = vendorCategories(row);
  if (selected.length > 0) {
    const wanted = new Set(selected.map((category) => category.toLowerCase()));
    const hit = categories.find((category) => wanted.has(category.toLowerCase()));
    if (hit) return hit;
  }
  return categories[0] ?? VENDOR_OTHER_CATEGORY;
}

/** The Category dropdown's options: the categories present in the list, A to Z, plus any already selected. */
export function vendorCategoryOptions(
  rows: ReadonlyArray<{ trade?: string | null; trades?: readonly string[] | null }>,
  selected: readonly string[] = [],
): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const row of rows) {
    for (const category of vendorCategories(row)) seen.set(category.toLowerCase(), category);
  }
  for (const category of selected) seen.set(category.toLowerCase(), canonicalVendorCategory(category));
  const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
  return [...seen.values()]
    .sort((a, b) => {
      // "Other" is the catch-all, so it sorts last, as it does among the groups.
      if (a === VENDOR_OTHER_CATEGORY) return 1;
      if (b === VENDOR_OTHER_CATEGORY) return -1;
      return collator.compare(a, b);
    })
    .map((category) => ({ value: category, label: category }));
}
