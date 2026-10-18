import { isHostBlockRange } from "@/lib/channel-calendar/host-block";

/** What a manager types about an imported channel stay (the feed itself never carries the guest's name). */
export const CHANNEL_STAY_GUEST_NAME_MAX = 120;
export const CHANNEL_STAY_NOTES_MAX = 1000;

export type ChannelStayDetails = { guestName: string; notes: string };

/** Strip control characters, collapse whitespace, trim, cap. */
export function normalizeStayGuestName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, CHANNEL_STAY_GUEST_NAME_MAX);
}

export function normalizeStayNotes(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ").trim().slice(0, CHANNEL_STAY_NOTES_MAX);
}

/**
 * The `channel_stay_details.source_uid` one stay's typed details are stored under.
 *
 * A reservation has a unique feed UID, so it is the UID alone. A host block
 * ("Airbnb (Not available)") is not: Airbnb reuses ONE UID for every block a host has, across
 * dates and listings (`channelStayTombstoneKey` keys on the same composite for the same reason).
 * Keying a block's note on the UID alone would show one block's note on another and let the
 * second save overwrite the first, so a block's dates are part of its key.
 */
export function channelStayDetailsKey(input: {
  sourceUid: string;
  start?: string | null;
  end?: string | null;
  hostBlock?: boolean;
  summary?: string | null;
}): string {
  const uid = input.sourceUid.trim();
  if (!isHostBlockRange({ hostBlock: input.hostBlock, summary: input.summary })) return uid;
  const start = (input.start ?? "").trim();
  const end = (input.end ?? "").trim() || start;
  return [uid, start, end].join("|");
}

/** Money a manager types (or an Airbnb email supplies) for a channel stay. All optional; absent means unset. */
export type ChannelStayMoney = {
  guestPhone?: string;
  /** The manager's own note on the stay or host block. */
  notes?: string;
  nightlyCents?: number;
  payoutCents?: number;
  /** ISO timestamp the payout landed; unset while the payout is still due. */
  paidAt?: string;
  currency?: string;
  source?: string;
  /** The manager's override of the stay's times, as instants (`check_in_at` / `check_out_at`). Absent = the property's defaults. */
  checkInAt?: string;
  checkOutAt?: string;
  /** The same override as "HH:MM" on the property's wall clock (derived server-side). */
  checkInTime?: string;
  checkOutTime?: string;
};

export const CHANNEL_STAY_PHONE_MAX = 40;
export const CHANNEL_STAY_MAX_CENTS = 100_000_000;

export function normalizeStayPhone(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[^0-9+()\-.\s]/g, "").replace(/\s+/g, " ").trim().slice(0, CHANNEL_STAY_PHONE_MAX);
}

/** Whole cents from a number of cents; null for blank / negative / non-finite / absurd input. */
export function normalizeStayCents(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > CHANNEL_STAY_MAX_CENTS) return null;
  return Math.round(n);
}

/** Dollars typed in a field ("412", "$1,240.50") -> cents; null when blank or not money. */
export function dollarsToStayCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!cleaned || !/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return normalizeStayCents(Math.round(Number(cleaned) * 100));
}

export function stayCentsToDollars(cents: number | null | undefined): string {
  return typeof cents === "number" && Number.isFinite(cents) ? (cents / 100).toFixed(2) : "";
}

/** A YYYY-MM-DD day or an ISO timestamp -> ISO timestamp (UTC noon for a bare day); null otherwise. */
export function normalizeStayPaidAt(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const t = raw.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(t) ? new Date(`${t}T12:00:00.000Z`) : new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
