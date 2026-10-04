/**
 * The one set of short date/time labels every service surface prints, in Pacific like every
 * other PropLane stamp.
 *
 * The manager row facts (`service-lifecycle.ts`) and the vendor row facts
 * (`vendor-work-order-tabs.ts`) describe the SAME visit, so they cannot each read the
 * runtime's local zone: one viewer in UTC saw "Wed, Oct 8 · 2am" on the manager list and
 * "Tue, Oct 7 · 7pm" on the vendor list for one timestamp — a different day.
 */

const PACIFIC = "America/Los_Angeles";

/** "Oct 8" */
export function serviceShortDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: PACIFIC });
}

/** "Wed, Oct 8" */
export function serviceWeekdayDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: PACIFIC });
}

/** "9am" / "9:30am" — minutes only when there are some. */
export function serviceClock(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: PACIFIC }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const minute = get("minute");
  return `${get("hour")}${minute && minute !== "00" ? `:${minute}` : ""}${get("dayPeriod").toLowerCase()}`;
}

/** "Wed, Oct 8 · 9am" */
export function serviceShortWhen(iso: string | null | undefined): string {
  const day = serviceWeekdayDay(iso);
  if (!day) return "";
  return `${day} · ${serviceClock(iso)}`;
}
