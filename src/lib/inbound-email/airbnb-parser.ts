/**
 * Airbnb "Reservation confirmed" / "New booking" and payout emails, read into the facts a channel
 * stay needs. Airbnb has no host API for this, so the host points Airbnb's notification address (or a
 * Gmail auto-forward) at the workspace work email and these bodies arrive as ordinary inbound mail.
 *
 * Tolerant by design: Airbnb rewords these emails often, so the parser keys on the stable pieces
 * (the HM… confirmation code, a check-in / check-out pair, a dollar amount next to "payout") and
 * returns null the moment it is unsure. A null never writes anything - the mail is just stored.
 * Pure function: no IO.
 */

export type AirbnbEmailKind = "booking" | "payout";

export type ParsedAirbnbEmail = {
  kind: AirbnbEmailKind;
  confirmationCode: string;
  guestFirstName?: string;
  /** YYYY-MM-DD */
  checkIn?: string;
  /** YYYY-MM-DD (check-out day) */
  checkOut?: string;
  nights?: number;
  /** Payout mails only. */
  payoutCents?: number;
};

const CODE = /\b(HM[A-Z0-9]{8,})\b/;
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_WORD = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const DATE_RE = new RegExp(`(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\\s+)?${MONTH_WORD}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?`, "i");

const pad = (n: number) => String(n).padStart(2, "0");

function parseDateAt(text: string, receivedYear: number): { iso: string; explicitYear: boolean; month: number; day: number } | null {
  const match = DATE_RE.exec(text);
  if (!match) return null;
  const month = MONTHS[match[1]!.slice(0, 4).toLowerCase()] ?? MONTHS[match[1]!.slice(0, 3).toLowerCase()];
  const day = Number(match[2]);
  if (!month || day < 1 || day > 31) return null;
  const explicitYear = Boolean(match[3]);
  const year = explicitYear ? Number(match[3]) : receivedYear;
  return { iso: `${year}-${pad(month)}-${pad(day)}`, explicitYear, month, day };
}

function stripTags(text: string): string {
  return text.replace(/ /g, " ").replace(/[ \t]+/g, " ");
}

const TRAILING_PUNCTUATION = ".,!:;";

/**
 * Trailing `.,!:;` dropped by a backwards scan, not a regex: an anchored `[.,!:;]+$`
 * backtracks quadratically on a long run of punctuation from an inbound mail.
 */
function trimTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && TRAILING_PUNCTUATION.includes(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
}

function plausibleName(raw: string | undefined): string | undefined {
  const name = raw === undefined ? undefined : trimTrailingPunctuation(raw.trim());
  if (!name || name.length > 40 || !/^[\p{L}][\p{L}'’\-]*$/u.test(name)) return undefined;
  if (/^(your|the|a|an|new|guest|reservation|booking|airbnb|we|you|host)$/i.test(name)) return undefined;
  return name;
}

function guestFirstNameFrom(subject: string, body: string): string | undefined {
  const patterns = [
    /(?:reservation confirmed|new booking(?: confirmed)?|booking confirmed)\s*[-–—:!]+\s*([\p{L}][\p{L}'’\-]*)\s+(?:arrives|is arriving|will arrive|checks? in)/iu,
    /([\p{L}][\p{L}'’\-]*)\s+(?:arrives|is arriving|will arrive)\b/iu,
    /\bguest\s*[:\-]\s*([\p{L}][\p{L}'’\-]*)/iu,
    /\b(?:booked by|reserved by)\s+([\p{L}][\p{L}'’\-]*)/iu,
    /\bpayout for\s+([\p{L}][\p{L}\-]*)(?:'s|’s)\s+(?:stay|reservation|trip)/iu,
  ];
  for (const text of [subject, body]) {
    for (const pattern of patterns) {
      const name = plausibleName(pattern.exec(text)?.[1]);
      if (name) return name;
    }
  }
  return undefined;
}

function moneyCents(raw: string): number | null {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 && n < 1_000_000 ? Math.round(n * 100) : null;
}

function payoutCentsFrom(body: string): number | null {
  const labelled = /(?:total payout|payout(?: amount)?|you(?:'|’)?ve been paid|we(?:'|’)?ve sent|amount sent|you earn(?:ed)?)\D{0,60}?\$\s?([\d,]+(?:\.\d{2})?)/i.exec(body);
  if (labelled) return moneyCents(labelled[1]!);
  const amounts = [...body.matchAll(/\$\s?([\d,]+(?:\.\d{2})?)/g)].map((m) => m[1]!);
  return amounts.length === 1 ? moneyCents(amounts[0]!) : null;
}

/**
 * @param input.receivedAt  When the mail arrived (ISO). Airbnb often omits the year, so the stay's year is
 *   inferred from it: a date that would land well before the arrival day belongs to the next year.
 */
export function parseAirbnbEmail(input: { subject: string; text: string; receivedAt?: string }): ParsedAirbnbEmail | null {
  const subject = stripTags(input.subject ?? "").trim();
  const body = stripTags(input.text ?? "");
  const haystack = `${subject}\n${body}`;
  const code = CODE.exec(haystack)?.[1];
  if (!code) return null;

  const isPayout = /\b(payout|you(?:'|’)?ve been paid|we(?:'|’)?ve sent your|paid you)\b/i.test(haystack);
  const isBooking = /\b(reservation confirmed|new booking|booking confirmed|reservation is confirmed)\b/i.test(haystack);
  // A payout mail also quotes its reservation; a mail that says both is a payout.
  const kind: AirbnbEmailKind | null = isPayout ? "payout" : isBooking ? "booking" : null;
  if (!kind) return null;

  const received = input.receivedAt ? new Date(input.receivedAt) : new Date();
  const receivedDate = Number.isNaN(received.getTime()) ? new Date() : received;
  const receivedYear = receivedDate.getUTCFullYear();

  let checkIn: string | undefined;
  let checkOut: string | undefined;
  const inMatch = /check[\s-]?in\b[^\n]{0,40}?\n?\s*([^\n]{0,40})/i.exec(body);
  const outMatch = /check[\s-]?out\b[^\n]{0,40}?\n?\s*([^\n]{0,40})/i.exec(body);
  const inDate = inMatch ? parseDateAt(inMatch[0]!, receivedYear) : null;
  const outDate = outMatch ? parseDateAt(outMatch[0]!, receivedYear) : null;
  if (inDate && outDate) {
    let inIso = inDate.iso;
    let outIso = outDate.iso;
    // No year in the mail: a stay that would start >6 months before arrival is next year's.
    if (!inDate.explicitYear) {
      const mailMonth = receivedDate.getUTCMonth() + 1;
      if (mailMonth - inDate.month > 6) inIso = `${receivedYear + 1}-${pad(inDate.month)}-${pad(inDate.day)}`;
    }
    if (!outDate.explicitYear) outIso = `${inIso.slice(0, 4)}-${pad(outDate.month)}-${pad(outDate.day)}`;
    if (outIso <= inIso && !outDate.explicitYear) outIso = `${Number(inIso.slice(0, 4)) + 1}-${pad(outDate.month)}-${pad(outDate.day)}`;
    if (outIso > inIso) {
      checkIn = inIso;
      checkOut = outIso;
    }
  }

  const nightsMatch = /\b(\d{1,3})\s+nights?\b/i.exec(body);
  const nights = nightsMatch ? Number(nightsMatch[1]) : undefined;
  const guestFirstName = guestFirstNameFrom(subject, body);

  if (kind === "payout") {
    const payoutCents = payoutCentsFrom(body);
    if (!payoutCents) return null;
    return {
      kind,
      confirmationCode: code,
      ...(guestFirstName ? { guestFirstName } : {}),
      ...(checkIn && checkOut ? { checkIn, checkOut } : {}),
      ...(nights ? { nights } : {}),
      payoutCents,
    };
  }

  if (!checkIn && !guestFirstName) return null;
  return {
    kind,
    confirmationCode: code,
    ...(guestFirstName ? { guestFirstName } : {}),
    ...(checkIn && checkOut ? { checkIn, checkOut } : {}),
    ...(nights ? { nights } : {}),
  };
}

/** Airbnb's own sending domains. A look-alike (airbnb.com.evil.test) is not one. */
export function isAirbnbSenderAddress(address: string): boolean {
  const at = address.lastIndexOf("@");
  const domain = (at >= 0 ? address.slice(at + 1) : address).replace(/[>\s]/g, "").toLowerCase();
  return domain === "airbnb.com" || domain.endsWith(".airbnb.com");
}
