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
import { listingBathroomCountForDisplay, listingSubmissionStreetLine } from "@/lib/manager-listing-submission";
import { parseMoneyAmount } from "@/lib/parse-money";

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** The street address with the ZIP once, never twice. */
export function propertyRowAddress(row: Pick<AdminPropertyRow, "address" | "zip">): string {
  const address = dedupeAddressSegments((row.address ?? "").trim());
  const zip = (row.zip ?? "").trim();
  if (!zip) return address;
  // The stored address frequently already ends in the ZIP ("…, WA 98166").
  if (address.endsWith(zip)) return address;
  return `${address}, ${zip}`;
}

/**
 * "41932 Paseo Padre Pkwy, 41932 Paseo Padre Pkwy" → "41932 Paseo Padre Pkwy".
 *
 * A geocoder suggestion can hand the wizard the street twice (its label and
 * its street line joined), and the row repeated it verbatim. Consecutive
 * duplicate comma segments are one segment; nothing else is touched.
 */
export function dedupeAddressSegments(address: string): string {
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  const kept: string[] = [];
  for (const part of parts) {
    if (kept.length > 0 && kept[kept.length - 1]!.toLowerCase() === part.toLowerCase()) continue;
    kept.push(part);
  }
  return kept.join(", ");
}

/**
 * The row's headline. A real name ("Jain Home") stays; a blank name, a bare
 * number ("2" — the draft the captain named by its room count) or the
 * placeholder falls back to the street, which is what a manager recognises.
 */
export function propertyRowTitle(row: Pick<AdminPropertyRow, "buildingName" | "address">): string {
  const name = (row.buildingName ?? "").trim();
  const street = propertyRowStreet(row);
  if (name && !/^[\d\s#.-]+$/.test(name)) return name;
  return street || name || "Untitled property";
}

/** True when the row's title is its street, so the address line must not repeat it. */
export function propertyRowTitleIsStreet(row: Pick<AdminPropertyRow, "buildingName" | "address">): boolean {
  return propertyRowTitle(row) === propertyRowStreet(row);
}

/**
 * The street line alone — the stored address minus a trailing ", City, ST ZIP".
 * With a submission the city/state/ZIP fields say what to strip; without one
 * the first comma segment is the street and the rest is the locality.
 */
export function propertyRowStreet(row: Pick<AdminPropertyRow, "address" | "submission">): string {
  const sub = row.submission;
  const address = dedupeAddressSegments((row.address ?? "").trim());
  if (sub) {
    const stripped = listingSubmissionStreetLine({ ...sub, address });
    if (stripped) return stripped;
  }
  return address.split(",")[0]?.trim() ?? address;
}

/**
 * "Fremont, CA 94539" — city, state and ZIP for the row's second line. Read
 * from the submission when it has them, otherwise from the address tail; the
 * ZIP appears once. Empty when nothing but the street is known.
 */
export function propertyRowLocality(row: Pick<AdminPropertyRow, "address" | "zip" | "submission">): string {
  const sub = row.submission;
  const zip = (sub?.zip ?? row.zip ?? "").trim();
  const city = (sub?.city ?? "").trim();
  const state = (sub?.state ?? "").trim();
  if (city || state) {
    const cityState = [city, state].filter(Boolean).join(", ");
    return zip && !cityState.endsWith(zip) ? `${cityState} ${zip}` : cityState;
  }
  // No structured city/state: whatever follows the street in the stored address.
  const parts = dedupeAddressSegments((row.address ?? "").trim()).split(",").map((p) => p.trim()).filter(Boolean);
  const tail = parts.slice(1).join(", ");
  if (!tail) return zip;
  return zip && !tail.endsWith(zip) ? `${tail} ${zip}` : tail;
}

/**
 * What the second line says: the locality alone when the title is the street,
 * "street · locality" when the title is a name — never the street twice.
 */
export function propertyRowAddressLine(
  row: Pick<AdminPropertyRow, "buildingName" | "address" | "zip" | "submission" | "neighborhood">,
): string {
  const locality = propertyRowLocality(row);
  const neighborhood = (row.neighborhood ?? "").trim();
  const place = [locality, neighborhood && neighborhood !== locality ? neighborhood : ""].filter(Boolean).join(" · ");
  if (propertyRowTitleIsStreet(row)) return place || propertyRowAddress(row);
  const street = propertyRowStreet(row);
  return [street, place].filter(Boolean).join(" · ") || propertyRowAddress(row);
}

/** Bed / bath / room counts for the row's glyph line. */
export function propertyRowMeta(
  row: Pick<AdminPropertyRow, "submission" | "beds" | "baths">,
): { beds: number; baths: number; rooms: number | null } {
  const rooms = row.submission?.rooms?.length ?? 0;
  const byRoom = row.submission?.listingPlaceCategoryId !== "entire_home";
  return {
    beds: row.beds ?? 0,
    baths: listingBathroomCountForDisplay(row.submission, row.baths ?? 0),
    rooms: byRoom && rooms > 0 ? rooms : null,
  };
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
  const baths = listingBathroomCountForDisplay(row.submission, row.baths ?? 0);
  return [
    byRoom && rooms > 0 ? `${rooms} ${rooms === 1 ? "room" : "rooms"}` : "",
    row.beds || baths ? `${row.beds} bd / ${baths} ba` : "",
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
  const baths = listingBathroomCountForDisplay(row.submission, row.baths ?? 0);
  return [
    propertyRowRentLabel(row),
    byRoom && rooms > 0 ? `${rooms} ${rooms === 1 ? "room" : "rooms"}` : "",
    row.beds || baths ? `${row.beds} bd / ${baths} ba` : "",
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
