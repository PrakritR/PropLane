/**
 * The pure half of the paid early check-in / late checkout add-ons (bookings-times-1018, contract C):
 * the charge id, the quote shape the guest's sheet and the assistant tool both draw, the guest's
 * texts and the pay link. No server import, so the sheet, the routes, the tool and the tests all read
 * the same rules. The availability RULE itself is `stayAddOnAvailability` in `lib/bookings/stay-times.ts`;
 * nothing here re-decides it. See docs/agents/bookings.md.
 */
import {
  formatAddOnPrice,
  formatStayTime,
  normalizeStayTime,
  stayAddOnLabel,
  type StayAddOnAvailability,
  type StayAddOnKind,
  type StayAddOnRecord,
  type StayAddOns,
  STAY_ADD_ON_KINDS,
} from "@/lib/bookings/stay-times";

/** Checkout will not take a charge under $1.00, so an add-on priced below it is never offered. */
export const STAY_ADD_ON_MIN_PRICE_CENTS = 100;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "oct 16" style label for a YYYY-MM-DD key: "Oct 16". */
export function stayAddOnDayLabel(dateKey: string): string {
  const [, month, day] = dateKey.split("-").map(Number);
  return `${MONTHS[(month ?? 1) - 1]} ${day}`;
}

/** The block-id slug every stay charge id is built from (`stay_total` and the add-ons share it). */
export function stayBlockSlug(blockId: string): string {
  const slug = blockId.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+/, "").replace(/_+$/, "");
  return slug || "unknown";
}

/** `hc_mgr_stay_<block slug>_early_check_in` / `_late_check_out`. Deterministic: the charge is idempotent on it. */
export function stayAddOnChargeId(blockId: string, kind: StayAddOnKind): string {
  return `hc_mgr_stay_${stayBlockSlug(blockId)}_${kind}`;
}

export function isStayAddOnKind(value: unknown): value is StayAddOnKind {
  return typeof value === "string" && (STAY_ADD_ON_KINDS as readonly string[]).includes(value);
}

/** "12 pm", "2:30 pm": the conversational form of a time (the whole hour drops its minutes). */
export function formatStayTimeShort(time: string): string {
  const long = formatStayTime(time);
  return long.replace(":00 ", " ");
}

/** Price in dollars the add-on charge carries: "$25.00". */
export function stayAddOnAmountLabel(priceCents: number): string {
  return `$${(priceCents / 100).toFixed(2)}`;
}

export function stayAddOnChargeTitle(kind: StayAddOnKind, time: string): string {
  return `${stayAddOnLabel(kind)} at ${formatStayTime(time)}`;
}

/* ───────────────────────── availability, with the price floor ───────────────────────── */

export type StayAddOnQuoteReason =
  | Extract<StayAddOnAvailability, { available: false }>["reason"]
  | "not_priced"
  | "stay_started"
  | "stay_over";

export type StayAddOnQuote =
  | { available: true; kind: StayAddOnKind; time: string; priceCents: number }
  | { available: false; kind: StayAddOnKind; reason: StayAddOnQuoteReason };

/** Wraps `stayAddOnAvailability`: an add-on priced under the checkout floor is not offered (fail closed). */
export function withPriceFloor(availability: StayAddOnAvailability): StayAddOnQuote {
  if (!availability.available) return availability;
  if (!Number.isSafeInteger(availability.priceCents) || availability.priceCents < STAY_ADD_ON_MIN_PRICE_CENTS) {
    return { available: false, kind: availability.kind, reason: "not_priced" };
  }
  return availability;
}

/**
 * What a guest (or the public card) is told about one add-on: whether it is on offer, and its time and price
 * when it is. The REASON it is unavailable is never sent: it would say another guest is next door.
 */
export type StayAddOnOffer = { kind: StayAddOnKind; available: boolean; time?: string; priceCents?: number };

export function offerFromQuote(quote: StayAddOnQuote): StayAddOnOffer {
  return quote.available
    ? { kind: quote.kind, available: true, time: quote.time, priceCents: quote.priceCents }
    : { kind: quote.kind, available: false };
}

/** The guest's "Early check-in isn't available that day." sentence. */
export function stayAddOnUnavailableText(kind: StayAddOnKind): string {
  return `${stayAddOnLabel(kind)} isn't available that day.`;
}

/* ───────────────────────── what a stay's sheet / tool draws ───────────────────────── */

export type StayAddOnQuoteRow = {
  kind: StayAddOnKind;
  label: string;
  offer: StayAddOnOffer;
  /** What is stored on the stay for this kind, if anything. */
  record: StayAddOnRecord | null;
};

/** Which verb the row's control carries. `null` = the row has no control (a request waiting on the host, a refund). */
export type StayAddOnRowAction = "add" | "pay" | null;

export type StayAddOnRowView = {
  kind: StayAddOnKind;
  /** "Early check-in · 12:00 pm · $25", "Early check-in · 12:00 pm · Paid". */
  text: string;
  action: StayAddOnRowAction;
};

/**
 * The rows the sheet draws, in kind order. An unavailable add-on with nothing stored is HIDDEN; one the
 * guest already has (paid, waiting on payment, requested, refunded) always stays visible so the sheet
 * never loses a record of money they paid.
 */
export function stayAddOnRowViews(rows: readonly StayAddOnQuoteRow[]): StayAddOnRowView[] {
  const views: StayAddOnRowView[] = [];
  for (const row of rows) {
    const record = row.record;
    if (record) {
      const base = `${row.label} · ${formatStayTime(record.time)}`;
      const price = formatAddOnPrice(record.priceCents);
      if (record.status === "paid") views.push({ kind: row.kind, text: `${base} · Paid`, action: null });
      else if (record.status === "pending") views.push({ kind: row.kind, text: `${base} · ${price}`, action: "pay" });
      else if (record.status === "requested") views.push({ kind: row.kind, text: `${base} · ${price} · Requested`, action: null });
      else if (record.status === "refund_failed") views.push({ kind: row.kind, text: `${base} · Refund in review`, action: null });
      else views.push({ kind: row.kind, text: `${base} · Refunded`, action: null });
      continue;
    }
    if (row.offer.available && row.offer.time && row.offer.priceCents !== undefined) {
      views.push({ kind: row.kind, text: `${row.label} · ${formatStayTime(row.offer.time)} · ${formatAddOnPrice(row.offer.priceCents)}`, action: "add" });
    }
  }
  return views;
}

/* ───────────────────────── the pay link ───────────────────────── */

export const STAY_ADD_ON_LINK_PATH = "/resident/applications/approved";

/** `/resident/applications/approved?stay=<blockId>&addOn=early_check_in&time=12:00`. */
export function stayAddOnPayPath(input: { blockId: string; kind: StayAddOnKind; time?: string | null }): string {
  const params = new URLSearchParams({ stay: input.blockId, addOn: input.kind });
  const time = normalizeStayTime(input.time);
  if (time) params.set("time", time);
  return `${STAY_ADD_ON_LINK_PATH}?${params.toString().replace(/%3A/g, ":")}`;
}

export function stayAddOnPayUrl(origin: string, input: { blockId: string; kind: StayAddOnKind; time?: string | null }): string {
  return `${origin.replace(/\/$/, "")}${stayAddOnPayPath(input)}`;
}

export type StayAddOnLink = { stayId: string; addOn: StayAddOnKind | null; time: string | null };

/** Reads the text link back (`?stay=&addOn=&time=`); null when it names no stay. */
export function parseStayAddOnLink(search: string): StayAddOnLink | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const stayId = (params.get("stay") ?? "").trim();
  if (!stayId) return null;
  const addOn = params.get("addOn");
  return { stayId, addOn: isStayAddOnKind(addOn) ? addOn : null, time: normalizeStayTime(params.get("time")) };
}

/* ───────────────────────── the guest's texts ───────────────────────── */

/** The date an add-on lands on: check-in day for early check-in, checkout day for late checkout. */
export function stayAddOnDate(kind: StayAddOnKind, stay: { checkIn: string; checkOut: string }): string {
  return kind === "early_check_in" ? stay.checkIn : stay.checkOut;
}

/** "Early check-in at 12:00 pm is confirmed for Oct 16." */
export function stayAddOnConfirmedText(input: { kind: StayAddOnKind; time: string; checkIn: string; checkOut: string }): string {
  return `${stayAddOnLabel(input.kind)} at ${formatStayTime(input.time)} is confirmed for ${stayAddOnDayLabel(stayAddOnDate(input.kind, input))}.`;
}

/** The refund text, sent when a paid add-on could not be honored. */
export function stayAddOnRefundText(input: {
  kind: StayAddOnKind;
  time: string;
  priceCents: number;
  checkIn: string;
  checkOut: string;
  standardTime: string;
}): string {
  return `${stayAddOnLabel(input.kind)} at ${formatStayTime(input.time)} isn't available for ${stayAddOnDayLabel(stayAddOnDate(input.kind, input))} anymore, so we refunded ${formatAddOnPrice(input.priceCents)}. Your ${input.kind === "early_check_in" ? "check-in" : "checkout"} stays at ${formatStayTime(input.standardTime)}.`;
}

/**
 * The reply the assistant may send a guest who asks about early check-in / late checkout. On a stay the host
 * has not confirmed yet (`holdOnly`) nothing is charged now: the request is kept and charged at confirmation.
 */
export function stayAddOnSuggestedReply(input: { kind: StayAddOnKind; time: string; priceCents: number; payUrl: string; holdOnly?: boolean }): string {
  const noun = input.kind === "early_check_in" ? "early check-in" : "late checkout";
  const price = `${noun} at ${formatStayTimeShort(input.time)} is ${formatAddOnPrice(input.priceCents)}`;
  return input.holdOnly
    ? `Yes, ${price}. Add it here: ${input.payUrl}. It's charged once the host confirms your stay.`
    : `Yes, ${price}. Pay here: ${input.payUrl}. I'll confirm as soon as it goes through.`;
}

/** Add-on records read off a stored `stayDetails`, tolerant of anything malformed. */
export function readStayAddOns(stayDetails: unknown): StayAddOns {
  const details = stayDetails && typeof stayDetails === "object" ? (stayDetails as Record<string, unknown>) : {};
  const raw = details.addOns && typeof details.addOns === "object" ? (details.addOns as Record<string, unknown>) : {};
  const out: StayAddOns = {};
  for (const kind of STAY_ADD_ON_KINDS) {
    const entry = raw[kind];
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const time = normalizeStayTime(record.time);
    const priceCents = Number(record.priceCents);
    const status = record.status;
    if (!time || !Number.isSafeInteger(priceCents) || priceCents < 0) continue;
    if (status !== "requested" && status !== "pending" && status !== "paid" && status !== "refunded" && status !== "refund_failed") continue;
    out[kind] = {
      time,
      priceCents,
      status,
      ...(typeof record.chargeId === "string" ? { chargeId: record.chargeId } : {}),
      ...(typeof record.requestedAt === "string" ? { requestedAt: record.requestedAt } : {}),
      ...(typeof record.paidAt === "string" ? { paidAt: record.paidAt } : {}),
      ...(typeof record.refundedAt === "string" ? { refundedAt: record.refundedAt } : {}),
      ...(typeof record.refundReason === "string" ? { refundReason: record.refundReason } : {}),
    };
  }
  return out;
}

/* ───────────────────── the booking card / sheet: arrival and add-on choices ───────────────────── */

export const NOT_SURE_ARRIVAL = "";

/** "Estimated arrival" choices: hourly 12 pm to 11 pm, plus "Not sure" (stored as nothing). */
export function estimatedArrivalOptions(): Array<{ value: string; label: string }> {
  const hours = Array.from({ length: 12 }, (_, index) => {
    const value = `${String(12 + index).padStart(2, "0")}:00`;
    return { value, label: formatStayTime(value) };
  });
  return [{ value: NOT_SURE_ARRIVAL, label: "Not sure" }, ...hours];
}

/** "Check-in 3:00 pm · Check-out 11:00 am". */
export function standardTimesLine(times: { checkInTime: string; checkOutTime: string }): string {
  return `Check-in ${formatStayTime(times.checkInTime)} · Check-out ${formatStayTime(times.checkOutTime)}`;
}

/** "Early check-in · 12:00 pm · $25": the checkbox label, from the offer the server's dry run returned. */
export function stayAddOnCheckLabel(offer: StayAddOnOffer): string | null {
  if (!offer.available || !offer.time || offer.priceCents === undefined) return null;
  return `${stayAddOnLabel(offer.kind)} · ${formatStayTime(offer.time)} · ${formatAddOnPrice(offer.priceCents)}`;
}

/**
 * Per kind, the ONE offer the booking UI draws: the first range that has it. Shown only when at least one
 * range is available (the server keeps the add-on only on the ranges where it is), so the sheet never offers
 * what the dry run did not.
 */
export function offersForBooking(perRange: ReadonlyArray<readonly StayAddOnOffer[] | undefined>): StayAddOnOffer[] {
  const out: StayAddOnOffer[] = [];
  for (const kind of STAY_ADD_ON_KINDS) {
    const hit = perRange.flatMap((offers) => offers ?? []).find((offer) => offer.kind === kind && offer.available);
    if (hit) out.push(hit);
  }
  return out;
}

/** Cents the ticked add-ons add to a quote: each ticked kind counts on every range that offers it. */
export function addOnsQuoteCents(perRange: ReadonlyArray<readonly StayAddOnOffer[] | undefined>, ticked: readonly StayAddOnKind[]): number {
  let total = 0;
  for (const offers of perRange) {
    for (const offer of offers ?? []) {
      if (offer.available && offer.priceCents !== undefined && ticked.includes(offer.kind)) total += offer.priceCents;
    }
  }
  return total;
}
