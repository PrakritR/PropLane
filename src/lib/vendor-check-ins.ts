/**
 * Automated vendor check-ins — "Did you clean today?" every two weeks.
 *
 * Pure: the shape stored on the vendor row, cadence math in Pacific wall time,
 * the reply verdict, and the rule that turns a "no" or silence into a task.
 * Sending rides the reminder spine (`reminders/subjects/vendor-check-ins.server.ts`);
 * this file is browser-safe so the Vendors page can preview the next send.
 *
 * Wall time matters: "Monday 9:00 AM" has to mean 9:00 in Seattle across a DST
 * change, which is why the next occurrence is computed with `zonedWallTimeMs`
 * rather than `Date` arithmetic on the server's clock.
 */

import { pacificCalendarDateYmd } from "@/lib/pacific-time";
import { zonedWallTimeMs } from "@/lib/tour-slot-math";
import type { VendorChannel } from "@/lib/vendor-messaging";

export type VendorCheckInCadence =
  | "weekly"
  | "biweekly"
  | "monthly"
  | { everyDays: number };

export type VendorCheckInOnNoOrSilent = "log" | "inbox" | "task";

export type VendorCheckInReplyVerdict = "yes" | "no" | "unclear";

export type VendorCheckInLogEntry = {
  sentAt: string;
  /** Reminder queue row that carried it, for dedupe on re-sweeps. */
  reminderId?: string;
  channel?: VendorChannel;
  reply?: { at: string; text: string; verdict: VendorCheckInReplyVerdict };
  /** Task created by the "no / no reply" rule, when one was. */
  taskId?: string;
  /** Set once the rule has been evaluated for this send, so it never fires twice. */
  ruleRanAt?: string;
};

export type VendorCheckIn = {
  id: string;
  question: string;
  cadence: VendorCheckInCadence;
  /** 0 = Sunday … 6 = Saturday. Ignored for `everyDays`. */
  weekday: number;
  /** Pacific wall-clock hour, 0–23. */
  hour: number;
  minute: number;
  channel?: VendorChannel;
  /** Scope the question to one property (fills `{property}`); null = the vendor's whole book. */
  propertyId?: string | null;
  enabled: boolean;
  onNoOrSilent: VendorCheckInOnNoOrSilent;
  /** Anchor for `biweekly` / `everyDays`: the first send counts from here (ISO date, Pacific). */
  anchorDate: string;
  createdAt: string;
  /** Bounded: the last {@link VENDOR_CHECK_IN_LOG_LIMIT} sends, newest last. */
  log: VendorCheckInLogEntry[];
};

export const VENDOR_CHECK_IN_LOG_LIMIT = 26;

export const VENDOR_CHECK_IN_CADENCE_OPTIONS: readonly { id: string; label: string; cadence: VendorCheckInCadence }[] = [
  { id: "weekly", label: "Every week", cadence: "weekly" },
  { id: "biweekly", label: "Every 2 weeks", cadence: "biweekly" },
  { id: "monthly", label: "Every month", cadence: "monthly" },
  { id: "every3days", label: "Every 3 days", cadence: { everyDays: 3 } },
  { id: "every10days", label: "Every 10 days", cadence: { everyDays: 10 } },
];

export const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function cadenceId(cadence: VendorCheckInCadence): string {
  if (typeof cadence === "string") return cadence;
  return `every${cadence.everyDays}days`;
}

export function cadenceLabel(cadence: VendorCheckInCadence): string {
  const known = VENDOR_CHECK_IN_CADENCE_OPTIONS.find((o) => cadenceId(o.cadence) === cadenceId(cadence));
  if (known) return known.label;
  return typeof cadence === "string" ? cadence : `Every ${cadence.everyDays} days`;
}

export function normalizeVendorCheckIn(raw: unknown): VendorCheckIn | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  const question = typeof r.question === "string" ? r.question : "";
  if (!id) return null;
  let cadence: VendorCheckInCadence = "biweekly";
  if (r.cadence === "weekly" || r.cadence === "biweekly" || r.cadence === "monthly") cadence = r.cadence;
  else if (r.cadence && typeof r.cadence === "object") {
    const n = Math.round(Number((r.cadence as Record<string, unknown>).everyDays));
    if (Number.isFinite(n) && n >= 1 && n <= 365) cadence = { everyDays: n };
  }
  const weekday = Number.isInteger(r.weekday) && Number(r.weekday) >= 0 && Number(r.weekday) <= 6 ? Number(r.weekday) : 1;
  const hour = Number.isInteger(r.hour) && Number(r.hour) >= 0 && Number(r.hour) <= 23 ? Number(r.hour) : 9;
  const minute = Number.isInteger(r.minute) && Number(r.minute) >= 0 && Number(r.minute) <= 59 ? Number(r.minute) : 0;
  const channel = r.channel === "sms" || r.channel === "email" || r.channel === "inapp" ? r.channel : undefined;
  const onNoOrSilent: VendorCheckInOnNoOrSilent =
    r.onNoOrSilent === "log" || r.onNoOrSilent === "inbox" || r.onNoOrSilent === "task" ? r.onNoOrSilent : "task";
  const anchorDate = typeof r.anchorDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.anchorDate) ? r.anchorDate : pacificCalendarDateYmd();
  const log = Array.isArray(r.log)
    ? r.log
        .map((e): VendorCheckInLogEntry | null => {
          if (!e || typeof e !== "object") return null;
          const row = e as Record<string, unknown>;
          if (typeof row.sentAt !== "string") return null;
          const reply =
            row.reply && typeof row.reply === "object"
              ? (() => {
                  const rr = row.reply as Record<string, unknown>;
                  return {
                    at: typeof rr.at === "string" ? rr.at : "",
                    text: typeof rr.text === "string" ? rr.text : "",
                    verdict: (rr.verdict === "yes" || rr.verdict === "no" ? rr.verdict : "unclear") as VendorCheckInReplyVerdict,
                  };
                })()
              : undefined;
          return {
            sentAt: row.sentAt,
            reminderId: typeof row.reminderId === "string" ? row.reminderId : undefined,
            channel: row.channel === "sms" || row.channel === "email" || row.channel === "inapp" ? row.channel : undefined,
            reply,
            taskId: typeof row.taskId === "string" ? row.taskId : undefined,
            ruleRanAt: typeof row.ruleRanAt === "string" ? row.ruleRanAt : undefined,
          };
        })
        .filter((e): e is VendorCheckInLogEntry => e !== null)
        .slice(-VENDOR_CHECK_IN_LOG_LIMIT)
    : [];
  return {
    id,
    question,
    cadence,
    weekday,
    hour,
    minute,
    channel,
    propertyId: typeof r.propertyId === "string" && r.propertyId.trim() ? r.propertyId.trim() : null,
    enabled: r.enabled !== false,
    onNoOrSilent,
    anchorDate,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString(),
    log,
  };
}

export function normalizeVendorCheckIns(raw: unknown): VendorCheckIn[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeVendorCheckIn).filter((c): c is VendorCheckIn => c !== null);
}

function ymdParts(ymd: string): { y: number; m: number; d: number } {
  const [y, m, d] = ymd.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

function ymdFromUtcDays(days: number): string {
  const d = new Date(days * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function utcDaysFromYmd(ymd: string): number {
  const { y, m, d } = ymdParts(ymd);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** Weekday (0–6) of a calendar date, independent of zone. */
function weekdayOfYmd(ymd: string): number {
  const { y, m, d } = ymdParts(ymd);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Every Pacific calendar date this check-in fires on, from `fromYmd` (inclusive)
 * for `horizonDays` days. Weekly / biweekly land on the chosen weekday; biweekly
 * counts fortnights from the anchor's week; monthly is the first chosen weekday
 * of each month; everyDays counts from the anchor.
 */
export function checkInSendDates(checkIn: VendorCheckIn, fromYmd: string, horizonDays: number): string[] {
  const out: string[] = [];
  const start = utcDaysFromYmd(fromYmd);
  const anchorDays = utcDaysFromYmd(checkIn.anchorDate);
  for (let i = 0; i < horizonDays; i++) {
    const days = start + i;
    const ymd = ymdFromUtcDays(days);
    const wd = weekdayOfYmd(ymd);
    const c = checkIn.cadence;
    if (c === "weekly") {
      if (wd === checkIn.weekday) out.push(ymd);
    } else if (c === "biweekly") {
      if (wd !== checkIn.weekday) continue;
      // Fortnight parity from the anchor's own occurrence of that weekday.
      const anchorWd = weekdayOfYmd(checkIn.anchorDate);
      const firstOccurrence = anchorDays + ((checkIn.weekday - anchorWd + 7) % 7);
      if (days < firstOccurrence) continue;
      if (Math.floor((days - firstOccurrence) / 7) % 2 === 0) out.push(ymd);
    } else if (c === "monthly") {
      if (wd !== checkIn.weekday) continue;
      const { d } = ymdParts(ymd);
      if (d <= 7) out.push(ymd);
    } else {
      if (days < anchorDays) continue;
      if ((days - anchorDays) % c.everyDays === 0) out.push(ymd);
    }
  }
  return out;
}

/** The instant a check-in fires on a given Pacific date. */
export function checkInSendAtMs(checkIn: VendorCheckIn, ymd: string): number {
  const { y, m, d } = ymdParts(ymd);
  return zonedWallTimeMs(y, m, d, checkIn.hour * 60 + checkIn.minute);
}

/** Next send strictly after `now`, as an instant, or null when disabled. */
export function nextCheckInAt(checkIn: VendorCheckIn, now: number = Date.now()): number | null {
  if (!checkIn.enabled) return null;
  const today = pacificCalendarDateYmd(now);
  for (const ymd of checkInSendDates(checkIn, today, 400)) {
    const at = checkInSendAtMs(checkIn, ymd);
    if (at > now) return at;
  }
  return null;
}

/** Stable key for the reminder queue: one send per (vendor, check-in, Pacific date). */
export function checkInDedupeKey(vendorId: string, checkInId: string, ymd: string): string {
  return `vendor_checkin:${vendorId}:${checkInId}:${ymd}`;
}

const YES_WORDS = [
  "yes", "yep", "yeah", "ya", "yup", "done", "did", "completed", "complete", "finished", "all good", "all clean",
  "clean", "cleaned", "ok", "okay", "👍", "✅", "sí", "si", "listo", "hecho", "limpio", "limpié", "limpie", "claro", "terminado",
];
const NO_WORDS = [
  "no", "nope", "not yet", "didn't", "didnt", "did not", "couldn't", "couldnt", "could not", "haven't", "havent",
  "not done", "not finished", "not today", "tomorrow", "later", "next week", "sick", "cancel", "❌", "👎",
  "no pude", "todavía no", "todavia no", "mañana", "manana", "aún no", "aun no",
];

/**
 * Yes / no / unclear from a short reply, both languages. Deterministic on
 * purpose — no model reads the vendor's text. "no" beats "yes" when both appear
 * ("yes but not the kitchen" is not a clean yes).
 */
export function classifyCheckInReply(text: string): VendorCheckInReplyVerdict {
  const t = ` ${text.toLowerCase().replace(/[.!?,;:]/g, " ").replace(/\s+/g, " ").trim()} `;
  if (!t.trim()) return "unclear";
  const hasNo = NO_WORDS.some((w) => t.includes(` ${w} `) || (w.length > 3 && t.includes(w)));
  const hasYes = YES_WORDS.some((w) => t.includes(` ${w} `) || (w.length > 3 && t.includes(w)));
  if (hasNo) return "no";
  if (hasYes) return "yes";
  return "unclear";
}

/** Hours after a send before silence counts as "no reply". */
export const CHECK_IN_REPLY_WINDOW_HOURS = 24;

/**
 * Does the "no / no reply" rule fire for this send right now?
 *
 * A "no" fires as soon as it arrives; silence fires once the window closes.
 * `ruleRanAt` guards against a second evaluation on the next tick.
 */
export function checkInRuleOutcome(
  entry: VendorCheckInLogEntry,
  now: number = Date.now(),
): "no" | "silent" | null {
  if (entry.ruleRanAt) return null;
  if (entry.reply?.verdict === "no") return "no";
  if (entry.reply) return null;
  const sent = Date.parse(entry.sentAt);
  if (!Number.isFinite(sent)) return null;
  return now - sent >= CHECK_IN_REPLY_WINDOW_HOURS * 3_600_000 ? "silent" : null;
}

/** Attach an inbound reply to the most recent unanswered send within the window. */
export function attachCheckInReply(
  checkIn: VendorCheckIn,
  reply: { at: string; text: string },
): { checkIn: VendorCheckIn; attached: boolean } {
  const at = Date.parse(reply.at);
  const windowMs = 36 * 3_600_000;
  for (let i = checkIn.log.length - 1; i >= 0; i--) {
    const entry = checkIn.log[i]!;
    if (entry.reply) continue;
    const sent = Date.parse(entry.sentAt);
    if (!Number.isFinite(sent) || at < sent || at - sent > windowMs) continue;
    const log = checkIn.log.slice();
    log[i] = { ...entry, reply: { at: reply.at, text: reply.text, verdict: classifyCheckInReply(reply.text) } };
    return { checkIn: { ...checkIn, log }, attached: true };
  }
  return { checkIn, attached: false };
}

export function appendCheckInSend(checkIn: VendorCheckIn, entry: VendorCheckInLogEntry): VendorCheckIn {
  const log = [...checkIn.log, entry].slice(-VENDOR_CHECK_IN_LOG_LIMIT);
  return { ...checkIn, log };
}

export function makeVendorCheckInId(): string {
  return `ci_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
