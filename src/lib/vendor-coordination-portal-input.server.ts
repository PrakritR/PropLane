import "server-only";
import { blockInstantMs } from "@/lib/tour-slot-math";
const zone = "America/Los_Angeles";
function wall(instant: number) { const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(instant); const get = (name: string) => parts.find((p) => p.type === name)?.value; return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`; }
export function pacificVisitInstant(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error("Enter a Pacific date and time.");
  const instant = blockInstantMs(value);
  if (!Number.isFinite(instant) || wall(instant) !== value) throw new Error("That Pacific time does not exist. Choose another time.");
  if (wall(instant - 3600000) === value || wall(instant + 3600000) === value) throw new Error("That Pacific time occurs twice. Choose a time outside the daylight-saving change.");
  return new Date(instant).toISOString();
}
export function dollarsToVisitCents(value: unknown): number {
  const raw = String(value ?? ""); if (!/^\d{1,7}(\.\d{1,2})?$/.test(raw)) throw new Error("Enter a dollar amount with up to two decimal places.");
  const [whole, fraction = ""] = raw.split("."); return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}
export function normalizePortalCoordinationInput(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request.");
  const input = { ...value } as Record<string, unknown>;
  if (input.time_zone !== undefined) {
    if (input.time_zone !== zone) throw new Error("Visit scheduling uses Pacific time.");
    delete input.time_zone;
    if (typeof input.selected_start_iso === "string") input.selected_start_iso = pacificVisitInstant(input.selected_start_iso);
    if (Array.isArray(input.windows)) input.windows = input.windows.map((w) => { if (!w || typeof w !== "object") throw new Error("Invalid window."); const window = w as Record<string, unknown>; return { startIso: pacificVisitInstant(String(window.startIso)), endIso: pacificVisitInstant(String(window.endIso)) }; });
  }
  if (input.quoteUsd !== undefined) {
    const quote = input.quoteUsd as Record<string, unknown>; if (!quote || typeof quote !== "object" || input.quote !== undefined) throw new Error("Invalid quote.");
    input.quote = { laborCents: dollarsToVisitCents(quote.labor), materialsCents: dollarsToVisitCents(quote.materials), consultationFeeCents: dollarsToVisitCents(quote.fee), scope: quote.scope, exclusions: quote.exclusions }; delete input.quoteUsd;
  }
  return input;
}
