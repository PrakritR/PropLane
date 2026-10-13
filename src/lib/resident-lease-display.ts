import { formatPacificDate } from "@/lib/pacific-time";

/**
 * A lease date as a person reads it: "Oct 20, 2026". Accepts a plain
 * `YYYY-MM-DD` day or a full ISO timestamp; anything else (already a label, a
 * range, empty) comes back as it was, never as "Invalid Date".
 */
export function formatLeaseDateLabel(value: string | null | undefined): string | undefined {
  const raw = (value ?? "").trim();
  if (!raw) return undefined;
  const isDay = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const isStamp = /^\d{4}-\d{2}-\d{2}T/.test(raw);
  if (!isDay && !isStamp) return raw;
  const label = formatPacificDate(raw, { month: "short", day: "numeric", year: "numeric" });
  return label === "—" ? raw : label;
}

/**
 * The monthly rent a lease stored ("$1800.00 / month", "$1,050.00/mo") as one
 * short figure: whole dollars when there are no cents, "$1,800 / mo".
 */
export function formatLeaseRentLabel(label: string | null | undefined): string | undefined {
  const raw = (label ?? "").trim();
  if (!raw) return undefined;
  const match = raw.match(/\d[\d,]*(?:\.\d+)?/);
  if (!match) return raw;
  const amount = Number.parseFloat(match[0].replace(/,/g, ""));
  if (!Number.isFinite(amount)) return raw;
  const hasCents = Math.round(amount * 100) % 100 !== 0;
  const money = amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  });
  const perMonth = /month|\/\s*mo\b|monthly/i.test(raw) || !/week|day|night|year/i.test(raw);
  return perMonth ? `${money} / mo` : money;
}
