import { moneyToCents, readDate } from "./money-dates";
import type { ChannelFinanceFacts, FinancePlatform } from "./types";

/**
 * Airbnb and Booking.com reservation / payout / invoice mails, read into finance facts. Pure; no IO.
 *
 * NO REAL SAMPLES were available when this was written: every label below comes from the sites' documented wording, so the
 * parsers are UNVERIFIED (`CHANNEL_FINANCE_PARSER_VERIFIED`). The one rule that holds regardless: an amount is read ONLY from
 * a line that names it ("Total payout", "Host service fee", "Commission"), never inferred from "the only dollar sign in the
 * mail". Several different values under one label, a foreign currency, or gross/fee/payout that do not add up make the read
 * UNCERTAIN: the caller stores the mail and the parsed candidates for a person to confirm, and nothing is counted until then.
 */
export type ParsedFinanceMail =
  | { status: "not_finance" }
  | { status: "unreadable"; reason: string }
  | {
      status: "parsed";
      facts: ChannelFinanceFacts;
      /** Structure and amounts are readable and consistent. */
      certain: boolean;
      /** gross, fee and payout were all stated and they add up: the amount is cross-validated, not just matched. */
      crossChecked: boolean;
      reasons: string[];
    };

const AMOUNT = "(-?\\s?(?:US\\$|\\$)\\s?[\\d,]+(?:\\.\\d{1,2})?)";

function labelledCents(body: string, labels: string): number | null | "ambiguous" {
  const re = new RegExp(`(?:${labels})[^\\n$.]{0,24}?${AMOUNT}`, "gi");
  const seen = new Set<number>();
  for (const match of body.matchAll(re)) {
    const cents = moneyToCents(match[1]!.replace(/\s/g, ""));
    if (cents === null) return "ambiguous";
    seen.add(Math.abs(cents));
  }
  if (seen.size === 0) return null;
  return seen.size === 1 ? [...seen][0]! : "ambiguous";
}

function labelledDate(body: string, labels: string, receivedAt: Date): string | null {
  const m = new RegExp(`(?:${labels})[^\\n]{0,6}?[:\\-]?[ \\t]*([^\\n]{0,40})`, "i").exec(body);
  if (!m) return null;
  return nearestYear(m[1]!, receivedAt);
}

function sameLineOrNext(body: string, label: string): string {
  const lines = body.split(/\r?\n/);
  const i = lines.findIndex((line) => new RegExp(label, "i").test(line));
  if (i < 0) return "";
  const own = lines[i]!.replace(new RegExp(`.*?${label}`, "i"), "");
  if (readDate(own, 2000)) return own;
  const next = lines[i + 1] ?? "";
  return /check[\s-]?(?:in|out)/i.test(next) ? "" : next;
}

/** A date written without a year is the one nearest the day the mail arrived (within about six months either way). */
function nearestYear(raw: string, receivedAt: Date): string | null {
  const explicit = /\b20\d{2}\b/.test(raw);
  const iso = readDate(raw, receivedAt.getUTCFullYear());
  if (!iso || explicit) return iso;
  const [, m, d] = iso.split("-").map(Number);
  let best = iso;
  let bestGap = Infinity;
  for (const year of [receivedAt.getUTCFullYear() - 1, receivedAt.getUTCFullYear(), receivedAt.getUTCFullYear() + 1]) {
    const candidate = `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const gap = Math.abs(Date.parse(`${candidate}T00:00:00Z`) - receivedAt.getTime());
    if (gap < bestGap) {
      best = candidate;
      bestGap = gap;
    }
  }
  return best;
}

const FOREIGN_CURRENCY = /[€£¥]|\b(?:EUR|GBP|CAD|AUD|MXN|JPY|CHF)\b|\b(?:C|CA|A)\$/;

function plausibleFirstName(raw: string | undefined): string | undefined {
  const name = (raw ?? "").trim().replace(/[.,:!]+$/, "");
  if (!name || name.length > 40 || !/^[\p{L}][\p{L}'’\- ]*$/u.test(name)) return undefined;
  if (/^(your|the|a|an|new|guest|reservation|booking|airbnb|we|you|host)$/i.test(name)) return undefined;
  return name;
}

function guestFrom(subject: string, body: string): string | undefined {
  const patterns = [
    /(?:reservation confirmed|new booking(?: confirmed)?|booking confirmed)\s*[-–—:!]+\s*([\p{L}][\p{L}'’\-]*(?:\s+[\p{L}][\p{L}'’\-]*){0,2})\s+(?:arrives|is arriving|will arrive|checks? in)/iu,
    /\bpayout for\s+([\p{L}][\p{L}'’\-]*)(?:'s|’s)\s+(?:stay|reservation|trip)/iu,
    /^[ \t>]*guest(?: name)?(?:\(s\))?\s*[:\-][ \t]*([^\n]{2,60})$/imu,
    /\b(?:booked by|reserved by)\s+([\p{L}][\p{L}'’\-]*)/iu,
  ];
  for (const text of [subject, body]) {
    for (const pattern of patterns) {
      const name = plausibleFirstName(pattern.exec(text)?.[1]);
      if (name) return name;
    }
  }
  return undefined;
}

function guestLabelOf(site: FinancePlatform, name: string | undefined): string | undefined {
  return name ? name : undefined;
}

/** One of `a`'s kinds of payout label ("payout", "paid you", ...) or a reservation label. Payout wins when both appear. */
const PAYOUT_WORDS = /\b(payout|you(?:'|’)?ve been paid|we(?:'|’)?ve sent your|paid you|payment (?:has been )?sent|net amount)\b/i;
const RESERVATION_WORDS = /\b(reservation confirmed|new booking|booking confirmed|reservation is confirmed|new reservation|you have a new reservation)\b/i;

function codeFor(platform: FinancePlatform, subject: string, body: string): string | null {
  const hay = `${subject}\n${body}`;
  if (platform === "airbnb") return /\b(HM[A-Z0-9]{8,})\b/.exec(hay)?.[1] ?? null;
  const labelled = /(?:reservation|booking|confirmation)\s*(?:number|id|no\.?|code)?\s*[:#]?\s*(\d{8,12})\b/i.exec(hay)?.[1];
  if (labelled) return labelled;
  return /(?:new (?:booking|reservation)[^\n(]{0,40}|payout[^\n(]{0,40})\((\d{8,12})[,)]/i.exec(subject)?.[1] ?? null;
}

const LABELS = {
  airbnb: {
    payoutKind: "total payout|payout amount|your payout|amount sent|you(?:'|’)ve been paid|we(?:'|’)ve sent(?: you)?|you earn(?:ed)?",
    payoutReservation: "you earn(?:ed)?|expected payout|your earnings",
    gross: "guest paid|total paid by guest|gross earnings|reservation total|accommodation total",
    fee: "host service fee|service fee|host fee",
    tax: "occupancy tax(?:es)?",
    date: "payout (?:sent|date)|sent on|paid on",
  },
  booking_com: {
    payoutKind: "payout amount|net amount|your payout|payout of|amount paid out|net payout",
    payoutReservation: "net amount|expected payout",
    gross: "total price|reservation amount|gross amount|booking amount",
    fee: "commission(?: amount)?",
    tax: "city tax|tourist tax|occupancy tax(?:es)?",
    date: "payout date|paid on|payment date|sent on|transfer date",
  },
} as const;

export function parseChannelFinanceEmail(input: { platform: FinancePlatform; subject: string; text: string; receivedAt?: string }): ParsedFinanceMail {
  const subject = (input.subject ?? "").replace(/\s+/g, " ").trim();
  const body = (input.text ?? "").replace(/ /g, " ").replace(/[ \t]+/g, " ");
  const hay = `${subject}\n${body}`;
  // A guest MESSAGE is a person to answer, never money data, even when it quotes a reservation.
  if (/\b(?:new message|message from|sent you a message|messaged you|is asking about)\b/i.test(subject)) return { status: "not_finance" };
  const isPayout = PAYOUT_WORDS.test(hay);
  const isReservation = RESERVATION_WORDS.test(hay);
  if (!isPayout && !isReservation) return { status: "not_finance" };
  const code = codeFor(input.platform, subject, body);
  if (!code) return { status: "unreadable", reason: "no confirmation code" };

  const received = input.receivedAt ? new Date(input.receivedAt) : new Date();
  const receivedAt = Number.isNaN(received.getTime()) ? new Date() : received;
  const kind = isPayout ? "payout" : "reservation";
  const labels = LABELS[input.platform];
  const reasons: string[] = [];

  const read = (name: string, pattern: string): number | undefined => {
    const value = labelledCents(body, pattern);
    if (value === "ambiguous") {
      reasons.push(`${name} appears with different values`);
      return undefined;
    }
    return value ?? undefined;
  };
  const payoutCents = read("payout", kind === "payout" ? labels.payoutKind : labels.payoutReservation);
  const grossCents = read("gross", labels.gross);
  let hostFeeCents = read("host fee", labels.fee);
  if (input.platform === "booking_com") {
    const paymentFee = read("payment fee", "payment (?:service )?(?:fee|charge)");
    if (paymentFee !== undefined) hostFeeCents = (hostFeeCents ?? 0) + paymentFee;
  }
  const taxCents = read("tax", labels.tax);

  const checkIn = nearestYear(sameLineOrNext(body, "check[\\s-]?in"), receivedAt) ?? undefined;
  const checkOut = nearestYear(sameLineOrNext(body, "check[\\s-]?out"), receivedAt) ?? undefined;
  const validRange = checkIn && checkOut && checkOut > checkIn;
  const paidOn = kind === "payout" ? labelledDate(body, labels.date, receivedAt) ?? receivedAt.toISOString().slice(0, 10) : undefined;
  const guest = guestLabelOf(input.platform, guestFrom(subject, body));
  const listing = /^[ \t>]*(?:property|listing|accommodation)\s*[:\-–—][ \t]*([^\n]{3,120})$/imu.exec(body)?.[1]?.trim();

  const currencyOk = !FOREIGN_CURRENCY.test(hay);
  if (!currencyOk) reasons.push("amounts are not in US dollars");
  if (kind === "payout" && payoutCents === undefined && !reasons.some((r) => r.startsWith("payout"))) reasons.push("no labelled payout amount");
  if (kind === "payout" && payoutCents === 0) reasons.push("payout is zero");
  if (checkIn && checkOut && !validRange) reasons.push("check-out is not after check-in");

  let crossChecked = false;
  if (grossCents !== undefined && hostFeeCents !== undefined && payoutCents !== undefined) {
    const candidates = [grossCents - hostFeeCents, grossCents - hostFeeCents - (taxCents ?? 0), grossCents - hostFeeCents + (taxCents ?? 0)];
    if (candidates.some((c) => Math.abs(c - payoutCents) <= 1)) crossChecked = true;
    else reasons.push("gross, fee and payout do not add up");
  }

  const facts: ChannelFinanceFacts = {
    platform: input.platform,
    kind,
    confirmationCode: code,
    ...(guest ? { guestLabel: guest } : {}),
    ...(listing ? { listingHint: listing } : {}),
    ...(validRange ? { checkIn, checkOut } : {}),
    ...(grossCents !== undefined ? { grossCents } : {}),
    ...(hostFeeCents !== undefined ? { hostFeeCents } : {}),
    ...(taxCents !== undefined ? { taxCents } : {}),
    ...(payoutCents !== undefined ? { payoutCents } : {}),
    currency: "USD",
    ...(paidOn ? { paidOn } : {}),
  };
  const certain = reasons.length === 0 && (kind === "payout" ? payoutCents !== undefined && payoutCents > 0 : Boolean(validRange));
  return { status: "parsed", facts, certain, crossChecked, reasons };
}
