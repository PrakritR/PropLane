/**
 * What one property says about itself in a list row.
 *
 * Twenty rows that all read "$1160.00–1210.00/mo · 2 bd / 1 ba" tell a manager
 * nothing about which one needs them. These helpers make each row carry the
 * things a manager actually scans for — a picture, a from-price in whole
 * dollars, how many rooms it has — and stop repeating the ZIP twice, which the
 * list did because the stored address already ends with it.
 */

import type { AdminPropertyRow } from "@/lib/demo-admin-property-inventory";
import { parseMoneyAmount } from "@/lib/parse-money";

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** The street address with the ZIP once, never twice. */
export function propertyRowAddress(row: Pick<AdminPropertyRow, "address" | "zip">): string {
  const address = (row.address ?? "").trim();
  const zip = (row.zip ?? "").trim();
  if (!zip) return address;
  // The stored address frequently already ends in the ZIP ("…, WA 98166").
  if (address.endsWith(zip)) return address;
  return `${address}, ${zip}`;
}

/**
 * "From $1,160/mo" — or the one rent, when every room charges the same.
 *
 * Read from the rooms when they exist, so a room repriced in the editor moves
 * the label; the pre-formatted `rentRangeLabel` (which carries cents) is only
 * the fallback for a row without a submission.
 */
export function propertyRowRentLabel(
  row: Pick<AdminPropertyRow, "monthlyRent" | "rentRangeLabel" | "submission">,
): string {
  const rents = (row.submission?.rooms ?? []).map((r) => r.monthlyRent).filter((n) => n > 0);
  if (rents.length > 0) {
    const min = Math.min(...rents);
    const max = Math.max(...rents);
    return min === max ? `${usd(min)}/mo` : `From ${usd(min)}/mo`;
  }
  if (row.rentRangeLabel) {
    const nums = row.rentRangeLabel.match(/[\d,]+(?:\.\d+)?/g)?.map((s) => parseMoneyAmount(s)) ?? [];
    const positive = nums.filter((n) => n > 0);
    if (positive.length > 0) {
      const min = Math.min(...positive);
      const max = Math.max(...positive);
      return min === max ? `${usd(min)}/mo` : `From ${usd(min)}/mo`;
    }
  }
  return row.monthlyRent > 0 ? `${usd(row.monthlyRent)}/mo` : "Rent not set";
}

/** "3 rooms · 2 bd / 1 ba · Green Lake" — the summary without the rent, which the row shows on the right. */
export function propertyRowDetail(
  row: Pick<AdminPropertyRow, "submission" | "beds" | "baths" | "neighborhood">,
): string {
  const rooms = row.submission?.rooms?.length ?? 0;
  const byRoom = row.submission?.listingPlaceCategoryId !== "entire_home";
  return [
    byRoom && rooms > 0 ? `${rooms} ${rooms === 1 ? "room" : "rooms"}` : "",
    row.beds || row.baths ? `${row.beds} bd / ${row.baths} ba` : "",
    (row.neighborhood ?? "").trim(),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "From $1,160/mo · 3 rooms · 2 bd / 1 ba · Green Lake" */
export function propertyRowSummary(
  row: Pick<AdminPropertyRow, "monthlyRent" | "rentRangeLabel" | "submission" | "beds" | "baths" | "neighborhood">,
): string {
  const rooms = row.submission?.rooms?.length ?? 0;
  const byRoom = row.submission?.listingPlaceCategoryId !== "entire_home";
  return [
    propertyRowRentLabel(row),
    byRoom && rooms > 0 ? `${rooms} ${rooms === 1 ? "room" : "rooms"}` : "",
    row.beds || row.baths ? `${row.beds} bd / ${row.baths} ba` : "",
    (row.neighborhood ?? "").trim(),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The first real photo, or nothing.
 *
 * Nothing means the row shows a placeholder — never a stock image, which is
 * the rule for every listing surface (AGENTS.md "Listing images").
 */
export function propertyRowThumbnail(row: Pick<AdminPropertyRow, "submission">): string | null {
  const sub = row.submission;
  if (!sub) return null;
  const candidates = [
    ...(sub.housePhotoDataUrls ?? []),
    ...(sub.rooms ?? []).flatMap((r) => r.photoDataUrls ?? []),
  ];
  const first = candidates.find((u) => typeof u === "string" && u.trim().length > 0);
  return first ?? null;
}
