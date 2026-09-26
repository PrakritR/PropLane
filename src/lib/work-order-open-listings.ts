/** Client-side shapes for the C152 Open marketplace tab, shared by the manager
 * (own-listing) and vendor (browse) work-order panels. */

export const OPEN_LISTING_TIMEFRAMES = ["ASAP", "This week", "This month", "Flexible"] as const;
export type OpenListingTimeframe = (typeof OPEN_LISTING_TIMEFRAMES)[number];

export type OpenJobListing = {
  id: string;
  workOrderId: string;
  trade: string;
  area: string;
  description: string;
  timeframe: string | null;
  budgetMinCents: number | null;
  budgetMaxCents: number | null;
  openedAt: string;
};

export type OwnOpenListing = {
  id: string;
  workOrderId: string;
  trade: string;
  area: string;
  description: string;
  timeframe: string | null;
  budgetMinCents: number | null;
  budgetMaxCents: number | null;
  status: "open" | "closed";
  openedAt: string;
  closedAt: string | null;
};

/** Vendor browse of every open listing across every workspace, paginated + filterable. */
export async function fetchOpenJobListings(opts: {
  trade?: string;
  area?: string;
  offset?: number;
  limit?: number;
}): Promise<{ ok: boolean; listings: OpenJobListing[]; hasMore: boolean }> {
  try {
    const params = new URLSearchParams();
    if (opts.trade) params.set("trade", opts.trade);
    if (opts.area) params.set("area", opts.area);
    params.set("offset", String(opts.offset ?? 0));
    params.set("limit", String(opts.limit ?? 20));
    const res = await fetch(`/api/portal/work-order-open-listings?${params.toString()}`, { credentials: "include" });
    if (!res.ok) return { ok: false, listings: [], hasMore: false };
    const data = (await res.json()) as { listings?: OpenJobListing[]; hasMore?: boolean };
    return { ok: true, listings: Array.isArray(data.listings) ? data.listings : [], hasMore: Boolean(data.hasMore) };
  } catch {
    return { ok: false, listings: [], hasMore: false };
  }
}

/** Manager's own listing for one service, any status (null = never opened). */
export async function fetchOwnOpenListing(workOrderId: string): Promise<OwnOpenListing | null> {
  try {
    const res = await fetch(`/api/portal/work-order-open-listings?workOrderId=${encodeURIComponent(workOrderId)}`, {
      credentials: "include",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { listing?: OwnOpenListing | null };
    return data.listing ?? null;
  } catch {
    return null;
  }
}

export type OpenListingDraft = {
  workOrderId: string;
  trade: string;
  area: string;
  description: string;
  timeframe?: string;
  budgetMinCents?: number | null;
  budgetMaxCents?: number | null;
};

export async function publishOpenListing(draft: OpenListingDraft): Promise<{ ok: boolean; error?: string; listing?: OwnOpenListing }> {
  try {
    const res = await fetch("/api/portal/work-order-open-listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ action: "open", ...draft }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error ?? "Could not publish listing." };
    return { ok: true, listing: data.listing };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not publish listing." };
  }
}

export async function closeOpenListing(workOrderId: string): Promise<{ ok: boolean; error?: string; listing?: OwnOpenListing | null }> {
  try {
    const res = await fetch("/api/portal/work-order-open-listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ action: "close", workOrderId }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error ?? "Could not close bidding." };
    return { ok: true, listing: data.listing };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not close bidding." };
  }
}

/** `$150` / `$100–$250` / `$150+` — never renders anything for an all-null range. */
export function formatBudgetRange(minCents: number | null, maxCents: number | null): string | null {
  const fmt = (cents: number) => `$${Math.round(cents / 100).toLocaleString()}`;
  if (minCents != null && maxCents != null) {
    return minCents === maxCents ? fmt(minCents) : `${fmt(minCents)}–${fmt(maxCents)}`;
  }
  if (minCents != null) return `${fmt(minCents)}+`;
  if (maxCents != null) return `Up to ${fmt(maxCents)}`;
  return null;
}
