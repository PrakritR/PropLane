import type { ManagerVendorRow, ManagerVendorTypicalRate } from "@/lib/manager-vendors-storage";

function asFiniteCents(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value);
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  return null;
}

export function normalizeTypicalRates(raw: unknown): ManagerVendorTypicalRate[] {
  if (!Array.isArray(raw)) return [];
  const out: ManagerVendorTypicalRate[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const propertyId = typeof row.propertyId === "string" ? row.propertyId.trim() : "";
    const trade = typeof row.trade === "string" ? row.trade.trim() : "";
    const hourlyCents = asFiniteCents(row.hourlyCents);
    const serviceCents = asFiniteCents(row.serviceCents);
    if (!propertyId || !trade || hourlyCents == null || serviceCents == null) continue;
    const key = `${propertyId}::${trade.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ propertyId, trade, hourlyCents, serviceCents });
  }
  return out;
}

export function dollarsInputFromCents(cents: number): string {
  if (!Number.isFinite(cents) || cents <= 0) return "";
  const dollars = cents / 100;
  return cents % 100 === 0 ? String(dollars) : dollars.toFixed(2);
}

export function centsFromDollarsInput(raw: string): number {
  const n = Number(String(raw).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

function digits(phone: string | undefined): string {
  return (phone ?? "").replace(/\D/g, "");
}

/** First saved rate for a trade fills houses that do not have their own row yet. */
export function typicalRateForCell(
  rates: readonly ManagerVendorTypicalRate[],
  propertyId: string,
  trade: string,
  fallback?: { hourlyCents: number; serviceCents: number },
): ManagerVendorTypicalRate {
  const needle = trade.trim().toLowerCase();
  const exact = rates.find((row) => row.propertyId === propertyId && row.trade.trim().toLowerCase() === needle);
  if (exact) return exact;
  const sameTrade = rates.find((row) => row.trade.trim().toLowerCase() === needle);
  if (sameTrade) {
    return { propertyId, trade, hourlyCents: sameTrade.hourlyCents, serviceCents: sameTrade.serviceCents };
  }
  return {
    propertyId,
    trade,
    hourlyCents: fallback?.hourlyCents ?? 0,
    serviceCents: fallback?.serviceCents ?? 0,
  };
}

export function expandTypicalRateCells(input: {
  propertyIds: readonly string[];
  trades: readonly string[];
  existing?: readonly ManagerVendorTypicalRate[];
  fallback?: { hourlyCents: number; serviceCents: number };
}): ManagerVendorTypicalRate[] {
  const trades = input.trades.map((trade) => trade.trim()).filter(Boolean);
  const existing = input.existing ?? [];
  const cells: ManagerVendorTypicalRate[] = [];
  for (const propertyId of input.propertyIds) {
    if (!propertyId.trim()) continue;
    for (const trade of trades) {
      cells.push(typicalRateForCell(existing, propertyId, trade, input.fallback));
    }
  }
  return cells;
}

export function findRosterCatalogMatch(
  rows: readonly ManagerVendorRow[],
  hit: { catalogId?: string | null; phone?: string; name: string; trade: string },
): ManagerVendorRow | undefined {
  const catalogId = hit.catalogId?.trim();
  if (catalogId) {
    const byCatalog = rows.find((row) => row.catalogId === catalogId);
    if (byCatalog) return byCatalog;
  }
  const phone = digits(hit.phone);
  if (phone.length >= 7) {
    const byPhone = rows.find((row) => digits(row.phone) === phone);
    if (byPhone) return byPhone;
  }
  const name = hit.name.trim().toLowerCase();
  const trade = hit.trade.trim().toLowerCase();
  return rows.find(
    (row) => row.name.trim().toLowerCase() === name && row.trade.trim().toLowerCase() === trade,
  );
}
