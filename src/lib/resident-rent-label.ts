/**
 * A stored rent label ("$1800.00 / month", "1800") read the way the studio draws
 * it: thousands separator, two decimals, "/mo" ("$1,800.00/mo"). Anything that
 * carries no number (a lease range, "—") comes back untouched.
 */
export function formatResidentRentLabel(label: string | null | undefined): string | null {
  const raw = (label ?? "").trim();
  if (!raw) return null;
  const match = raw.match(/\d[\d,]*(?:\.\d+)?/);
  if (!match) return raw;
  const amount = Number.parseFloat(match[0].replace(/,/g, ""));
  if (!Number.isFinite(amount)) return raw;
  const money = amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return /month|\/\s*mo\b|monthly/i.test(raw) || !/week|day|night|year/i.test(raw) ? `${money}/mo` : money;
}
