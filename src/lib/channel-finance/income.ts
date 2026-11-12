import { moneyToCents } from "./money-dates";
import { FINANCE_PLATFORMS, type ChannelFinanceRecord, type FinancePlatform } from "./types";

/**
 * One source for channel income: `ChannelFinanceRecord`s (mail + CSV) plus the legacy typed/emailed Airbnb stay payouts
 * (`channel_stay_details`), deduped, normalised, then rolled up per house / room / month. The Payments list rows and the
 * channel income report both read `channelIncomeRows`, so they can never disagree. Pure; cents are integers.
 */

/** Days after check-out before a booking with no payout reads "Not paid out yet". Airbnb pays about a day after check-in; Booking.com pays on a monthly-ish schedule. */
export const PAYOUT_OVERDUE_AFTER_DAYS: Record<FinancePlatform, number> = { airbnb: 3, booking_com: 35 };

export type StayPayoutInput = {
  id: string;
  connectionId: string;
  sourceUid: string;
  propertyId: string;
  propertyLabel: string;
  roomLabel: string;
  guestLabel: string;
  /** Last night of the stay. */
  start: string;
  end: string;
  payoutCents: number;
  paidAt: string | null;
};

export type ChannelIncomeStatus = "paid" | "pending" | "overdue" | "needs_room" | "needs_review";

export type ChannelIncomeRow = {
  key: string;
  platform: FinancePlatform;
  confirmationCode: string | null;
  recordId: string | null;
  connectionId: string | null;
  sourceUid: string | null;
  propertyId: string | null;
  propertyLabel: string;
  roomLabel: string;
  guestLabel: string;
  checkIn: string | null;
  checkOut: string | null;
  grossCents: number | null;
  hostFeeCents: number | null;
  taxCents: number | null;
  /** What the channel paid (status paid) or is expected to pay. Null = not known. */
  payoutCents: number | null;
  paidOn: string | null;
  status: ChannelIncomeStatus;
};

function nextDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
}
function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

export function channelIncomeRows(input: {
  records: readonly ChannelFinanceRecord[];
  stayPayouts?: readonly StayPayoutInput[];
  /** YYYY-MM-DD "today" (injected so the report is deterministic). */
  today: string;
}): ChannelIncomeRow[] {
  const groups = new Map<string, ChannelFinanceRecord[]>();
  for (const record of input.records) {
    const key = `${record.platform}:${record.confirmationCode}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const rows: ChannelIncomeRow[] = [];
  const linkedStays = new Set<string>();
  for (const [key, group] of groups) {
    const payout = group.find((r) => r.kind === "payout");
    const reservation = group.find((r) => r.kind === "reservation");
    const base = payout ?? reservation!;
    const flagged = group.find((r) => r.reviewStatus === "needs_review") ?? group.find((r) => r.reviewStatus === "needs_room");
    const pick = <K extends "grossCents" | "hostFeeCents" | "taxCents" | "checkIn" | "checkOut" | "guestLabel" | "propertyLabel" | "roomLabel" | "propertyId" | "connectionId" | "sourceUid">(field: K) =>
      payout?.[field] ?? reservation?.[field] ?? null;
    const connectionId = pick("connectionId");
    const sourceUid = pick("sourceUid");
    if (connectionId && sourceUid) linkedStays.add(`${connectionId}:${sourceUid}`);
    const gross = pick("grossCents");
    const fee = pick("hostFeeCents");
    const expected = payout?.payoutCents ?? reservation?.payoutCents ?? (gross !== null && fee !== null ? gross - fee : null);
    const paidOn = payout?.payoutCents != null && payout.paidAt ? payout.paidAt.slice(0, 10) : null;
    const checkOut = pick("checkOut");
    let status: ChannelIncomeStatus;
    if (flagged?.reviewStatus === "needs_review") status = "needs_review";
    else if (flagged?.reviewStatus === "needs_room") status = "needs_room";
    else if (paidOn) status = "paid";
    else status = checkOut && input.today >= addDays(checkOut, PAYOUT_OVERDUE_AFTER_DAYS[base.platform]) ? "overdue" : "pending";
    rows.push({
      key,
      platform: base.platform,
      confirmationCode: base.confirmationCode,
      recordId: base.id,
      connectionId,
      sourceUid,
      propertyId: pick("propertyId"),
      propertyLabel: pick("propertyLabel") ?? "",
      roomLabel: pick("roomLabel") ?? "",
      guestLabel: pick("guestLabel") ?? "",
      checkIn: pick("checkIn"),
      checkOut,
      grossCents: gross,
      hostFeeCents: fee,
      taxCents: pick("taxCents"),
      payoutCents: expected,
      paidOn,
      status,
    });
  }
  for (const stay of input.stayPayouts ?? []) {
    if (linkedStays.has(`${stay.connectionId}:${stay.sourceUid}`)) continue;
    const checkOut = nextDay(stay.end);
    const paidOn = stay.paidAt ? stay.paidAt.slice(0, 10) : null;
    rows.push({
      key: `stay:${stay.id}`,
      platform: "airbnb",
      confirmationCode: null,
      recordId: null,
      connectionId: stay.connectionId,
      sourceUid: stay.sourceUid,
      propertyId: stay.propertyId,
      propertyLabel: stay.propertyLabel,
      roomLabel: stay.roomLabel,
      guestLabel: stay.guestLabel,
      checkIn: stay.start,
      checkOut,
      grossCents: null,
      hostFeeCents: null,
      taxCents: null,
      payoutCents: stay.payoutCents,
      paidOn,
      status: paidOn ? "paid" : input.today >= addDays(checkOut, PAYOUT_OVERDUE_AFTER_DAYS.airbnb) ? "overdue" : "pending",
    });
  }
  return rows.sort((a, b) => (b.paidOn ?? b.checkOut ?? "").localeCompare(a.paidOn ?? a.checkOut ?? ""));
}

export type DirectRentInput = { propertyId: string | null; propertyLabel: string; roomLabel: string; /** YYYY-MM */ month: string; cents: number };

/** Paid rent from the PropLane ledger's rows (strings as the Payments list draws them). Channel payouts and unpaid rows never count. */
export function directRentFromLedger(
  rows: readonly { bucket: string; chargeKind?: string; amountPaid: string; dueDateSortMs?: number | null; propertyId?: string; propertyName: string; roomNumber?: string }[],
): DirectRentInput[] {
  const out: DirectRentInput[] = [];
  for (const row of rows) {
    if (row.bucket !== "paid" || row.dueDateSortMs == null) continue;
    if (row.chargeKind === "airbnb_payout" || row.chargeKind === "booking_com_payout") continue;
    if (row.chargeKind && row.chargeKind !== "rent") continue;
    const cents = moneyToCents(row.amountPaid);
    if (!cents || cents <= 0) continue;
    out.push({ propertyId: row.propertyId ?? null, propertyLabel: row.propertyName, roomLabel: row.roomNumber ?? "", month: new Date(row.dueDateSortMs).toISOString().slice(0, 7), cents });
  }
  return out;
}

export type IncomeGroupBy = "house" | "room" | "month";
export type ChannelTotals = { grossCents: number; feeCents: number; payoutCents: number; count: number };
export type IncomeLine = {
  key: string;
  label: string;
  airbnb: ChannelTotals;
  booking_com: ChannelTotals;
  directRentCents: number;
  /** Everything in: channel payouts plus direct rent. */
  totalCents: number;
};

const zero = (): ChannelTotals => ({ grossCents: 0, feeCents: 0, payoutCents: 0, count: 0 });

/**
 * Channel income by house, room or month. ONLY paid payouts count (what the channel really paid); a booking not yet paid,
 * a row needing a room, or one needing review never inflates a total. Month = the month the payout landed.
 */
export function rollupChannelIncome(
  rows: readonly ChannelIncomeRow[],
  direct: readonly DirectRentInput[],
  options: { groupBy: IncomeGroupBy; fromMonth?: string; toMonth?: string },
): { lines: IncomeLine[]; grand: IncomeLine } {
  const inRange = (month: string) => (!options.fromMonth || month >= options.fromMonth) && (!options.toMonth || month <= options.toMonth);
  const lines = new Map<string, IncomeLine>();
  const line = (key: string, label: string): IncomeLine => {
    let l = lines.get(key);
    if (!l) {
      l = { key, label, airbnb: zero(), booking_com: zero(), directRentCents: 0, totalCents: 0 };
      lines.set(key, l);
    }
    return l;
  };
  const keyFor = (propertyId: string | null, house: string, room: string, month: string) =>
    options.groupBy === "month" ? { key: month, label: month } : options.groupBy === "house" ? { key: propertyId ?? house, label: house || "Unassigned" } : { key: `${propertyId ?? house}::${room}`, label: [house, room].filter(Boolean).join(" · ") || "Unassigned" };
  for (const row of rows) {
    if (row.status !== "paid" || !row.paidOn || row.payoutCents === null) continue;
    const month = row.paidOn.slice(0, 7);
    if (!inRange(month)) continue;
    const k = keyFor(row.propertyId, row.propertyLabel, row.roomLabel, month);
    const t = line(k.key, k.label)[row.platform];
    t.grossCents += row.grossCents ?? 0;
    t.feeCents += row.hostFeeCents ?? 0;
    t.payoutCents += row.payoutCents;
    t.count += 1;
  }
  for (const d of direct) {
    if (!inRange(d.month)) continue;
    const k = keyFor(d.propertyId, d.propertyLabel, d.roomLabel, d.month);
    line(k.key, k.label).directRentCents += d.cents;
  }
  const grand: IncomeLine = { key: "all", label: "All", airbnb: zero(), booking_com: zero(), directRentCents: 0, totalCents: 0 };
  const sorted = [...lines.values()].sort((a, b) => (options.groupBy === "month" ? b.key.localeCompare(a.key) : a.label.localeCompare(b.label)));
  for (const l of sorted) {
    l.totalCents = l.airbnb.payoutCents + l.booking_com.payoutCents + l.directRentCents;
    for (const p of FINANCE_PLATFORMS) {
      grand[p].grossCents += l[p].grossCents;
      grand[p].feeCents += l[p].feeCents;
      grand[p].payoutCents += l[p].payoutCents;
      grand[p].count += l[p].count;
    }
    grand.directRentCents += l.directRentCents;
    grand.totalCents += l.totalCents;
  }
  return { lines: sorted, grand };
}
