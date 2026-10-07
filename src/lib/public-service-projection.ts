import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { workOrderGeneralArea } from "@/lib/work-order-vendor-privacy";

/**
 * What an anonymous reader of a texted service link, and a signed-in vendor browsing the work
 * board, may see of a service (vendor-work-share-1006).
 *
 * This is an ALLOWLIST, the opposite of `projectWorkOrderForOfferedVendor`: that one deletes the
 * fields a vendor who holds an offer must not read and lets everything else through, so a field
 * added to `DemoManagerWorkOrderRow` tomorrow reaches the vendor by default. A stranger holding a
 * link, or any vendor browsing someone else's published job, gets only what is named below. A new
 * row field is private until it is added here on purpose — the same stance
 * `publicListingProjection` takes for a public listing (`src/lib/public-listings.server.ts`).
 *
 * Never in this payload: the street address, unit, property name beyond the general area, resident
 * name / email / phone, entry notes and permission, any cost or price, the manager's id, the work
 * order id, the offer / bid state. The address is revealed to a vendor only once they are hired.
 */

/** The row fields the projection READS. A key that is not here is never looked at. */
export const PUBLIC_SERVICE_SOURCE_KEYS = [
  "title",
  "category",
  "description",
  "preferredArrival",
  "photoDataUrls",
  "publishBudgetCents",
  "publishSharePhotos",
  // Read ONLY to derive the city-level general area (`workOrderGeneralArea`); never copied out.
  "propertyAddress",
  "propertyName",
] as const satisfies readonly (keyof DemoManagerWorkOrderRow)[];

/** What leaves the server. */
export type PublicServiceView = {
  title: string;
  /** The trade, e.g. "Plumbing". */
  trade: string;
  /** City / neighbourhood only; "Nearby" when nothing safe to show. */
  area: string;
  description: string;
  /** Preferred dates / arrival, free text from the service ("Anytime", "weekdays after 5pm"). */
  when: string;
  /** "Up to $250" when the manager set a budget, else empty. */
  budget: string;
  /** Photos only when the manager ticked "Share photos". */
  photos: string[];
  /** The manager's display name ("Alder Property Co"). */
  postedBy: string;
};

/** Every key the public payload may carry. A leak test fails when the projection grows past it. */
export const PUBLIC_SERVICE_FIELDS = [
  "title",
  "trade",
  "area",
  "description",
  "when",
  "budget",
  "photos",
  "postedBy",
] as const satisfies readonly (keyof PublicServiceView)[];

/** The board's row adds the opaque ref a signed-in vendor requests by. Still no internal id. */
export type PublicBoardServiceView = PublicServiceView & { ref: string };

export const PUBLIC_BOARD_SERVICE_FIELDS = [...PUBLIC_SERVICE_FIELDS, "ref"] as const satisfies readonly (keyof PublicBoardServiceView)[];

const MAX_PUBLIC_PHOTOS = 4;
/** https image URLs and inline image data URLs only; anything else (javascript:, file:, blob:) is dropped. */
const SAFE_PHOTO_RE = /^(https:\/\/|data:image\/(?:png|jpe?g|webp|gif);base64,)/i;

const TRADE_LABEL: Record<NonNullable<DemoManagerWorkOrderRow["category"]>, string> = {
  cleaning: "Cleaning",
  plumbing: "Plumbing",
  mold: "Mold",
  electrical: "Electrical",
  hvac: "HVAC",
  general: "General maintenance",
  appliance: "Appliance",
  access: "Locks and access",
};

export function publicServiceTradeLabel(category: DemoManagerWorkOrderRow["category"] | undefined): string {
  return (category && TRADE_LABEL[category]) || "Maintenance";
}

function budgetLabel(cents: number | null | undefined): string {
  if (typeof cents !== "number" || !Number.isFinite(cents) || cents <= 0) return "";
  const dollars = cents / 100;
  return `Up to $${dollars.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2 })}`;
}

function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) {
    if (key in source) out[key] = source[key];
  }
  return out;
}

/**
 * Collapse a stored service to the public view. `postedBy` is the manager's own display name,
 * resolved by the caller from the authenticated record owner, never from the row.
 */
export function publicServiceProjection(row: DemoManagerWorkOrderRow, postedBy: string): PublicServiceView {
  const source = pick(row, PUBLIC_SERVICE_SOURCE_KEYS);
  const photos =
    source.publishSharePhotos === true && Array.isArray(source.photoDataUrls)
      ? source.photoDataUrls
          .filter((src): src is string => typeof src === "string" && SAFE_PHOTO_RE.test(src.trim()))
          .slice(0, MAX_PUBLIC_PHOTOS)
      : [];
  return {
    title: String(source.title ?? "").trim() || "Service",
    trade: publicServiceTradeLabel(source.category),
    area: workOrderGeneralArea({ propertyAddress: source.propertyAddress, propertyName: source.propertyName ?? "" }),
    description: String(source.description ?? "").trim(),
    when: String(source.preferredArrival ?? "").trim() || "Anytime",
    budget: budgetLabel(source.publishBudgetCents),
    photos,
    postedBy: postedBy.trim() || "A property manager",
  };
}

/** The work board's row: the same view plus the opaque ref the vendor requests by. */
export function publicBoardServiceProjection(row: DemoManagerWorkOrderRow, postedBy: string): PublicBoardServiceView | null {
  const ref = row.publishRef?.trim();
  if (!ref) return null;
  return { ...publicServiceProjection(row, postedBy), ref };
}
