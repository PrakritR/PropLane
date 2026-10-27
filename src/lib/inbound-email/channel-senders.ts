/**
 * Guest-message emails from the booking sites (Airbnb, Booking.com, PadSplit, SpareRoom), read into the facts the
 * channel inbox needs: who wrote, what they said, which listing it is about and where the site wants the reply.
 *
 * None of these sites has a messaging API PropLane can use; each EMAILS the host every new guest message. The host
 * points the site's notification address (or a Gmail auto-forward) at the workspace work email, and these mails arrive
 * as ordinary inbound mail. This module is the pure half: recognise the site from the sender's domain, parse the body,
 * and validate the relay address. Whether the mail really came from the site is NOT decided here - that is the
 * receiving server's DKIM/SPF verdict (`inboundSenderAuthenticated`), checked by the caller before anything is answered.
 *
 * Tolerant by design: the sites reword their mail often, so the parsers key on stable pieces and return null the
 * moment they are unsure. A null never answers anything - the mail is just stored. Pure functions: no IO.
 */
import { parseAirbnbGuestMessage, plausibleGuestName } from "@/lib/inbound-email/airbnb-parser";

export const CHANNEL_SITES = ["airbnb", "booking_com", "padsplit", "spareroom"] as const;
export type ChannelSite = (typeof CHANNEL_SITES)[number];

export const CHANNEL_SITE_LABEL: Record<ChannelSite, string> = {
  airbnb: "Airbnb",
  booking_com: "Booking.com",
  padsplit: "PadSplit",
  spareroom: "SpareRoom",
};

/** The site's own sending / relay domains. A look-alike (airbnb.com.evil.test, notairbnb.com) is not one. */
export const CHANNEL_SITE_DOMAINS: Record<ChannelSite, readonly string[]> = {
  airbnb: ["airbnb.com"],
  booking_com: ["booking.com"],
  padsplit: ["padsplit.com"],
  spareroom: ["spareroom.com", "spareroom.co.uk"],
};

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return (at >= 0 ? address.slice(at + 1) : address).replace(/[>\s]/g, "").toLowerCase();
}

function domainBelongsTo(domain: string, parents: readonly string[]): boolean {
  return parents.some((parent) => domain === parent || domain.endsWith(`.${parent}`));
}

/** Which site an address belongs to, by exact domain or true subdomain. Null for everyone else. */
export function channelSiteOfAddress(address: string): ChannelSite | null {
  const domain = domainOf(address);
  if (!domain.includes(".")) return null;
  return CHANNEL_SITES.find((site) => domainBelongsTo(domain, CHANNEL_SITE_DOMAINS[site])) ?? null;
}

/** A relay/reply address is trusted only on the site's OWN domains: a guest-message mail cannot point replies elsewhere. */
export function isChannelRelayAddress(site: ChannelSite, address: string | null | undefined): boolean {
  const value = (address ?? "").trim();
  if (!value.includes("@")) return false;
  return domainBelongsTo(domainOf(value), CHANNEL_SITE_DOMAINS[site]);
}

/** Airbnb and Booking.com forbid contact details in messages; PadSplit and SpareRoom allow the listing link and a phone. */
export function channelAllowsContactDetails(site: ChannelSite): boolean {
  return site === "padsplit" || site === "spareroom";
}

export type ChannelGuestMessage = {
  site: ChannelSite;
  guestName: string;
  guestFirstName: string;
  messageText: string;
  /** The listing as the site names it in the mail (matched to a house/room later). */
  listingTitle: string | null;
  /** Airbnb HM code / Booking.com reservation number, when the mail quotes one. */
  reservationCode: string | null;
  /** Where the site wants the reply (its relay address), only ever on the site's own domain. */
  replyAddress: string | null;
};

const END_COMMON =
  /^(?:reply to this (?:email|message)|reply directly|to reply|view (?:the )?message|view in|open the|respond (?:in|to)|log in to|sign in to|unsubscribe|this (?:email|message) was sent|sent (?:with|from|by)|please (?:do not|don.?t) reply|booking\.com|padsplit,? inc|spareroom|copyright|©|manage (?:your )?(?:notification|email))/i;

function normalizeBody(text: string): string[] {
  return (text ?? "")
    .replace(/ /g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[>\s]+/, "").replace(/[ \t]+/g, " ").trim());
}

/** First capture group of the first pattern that matches `value`. */
function firstMatch(value: string, patterns: readonly RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const hit = pattern.exec(value)?.[1];
    if (hit) return hit;
  }
  return undefined;
}

/** The lines after the last header-ish line up to the first footer marker; quotes and blank edges trimmed. */
function messageFrom(lines: string[], start: number, endMarkers: RegExp): string {
  const kept: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (endMarkers.test(line) || END_COMMON.test(line)) break;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^["“]+|["”]+$/g, "").trim().slice(0, 4000);
}

function guestFrom(subject: string, lines: string[], subjectPatterns: readonly RegExp[], bodyPatterns: readonly RegExp[]): string | undefined {
  for (const pattern of subjectPatterns) {
    const name = plausibleGuestName(pattern.exec(subject)?.[1]);
    if (name) return name;
  }
  for (const line of lines.slice(0, 14)) {
    for (const pattern of bodyPatterns) {
      const name = plausibleGuestName(pattern.exec(line)?.[1]);
      if (name) return name;
    }
  }
  return undefined;
}

const NAMEY = "([\\p{L}][\\p{L}'’\\-]*\\.?(?:[ \\t]+[\\p{L}][\\p{L}'’\\-]*\\.?){0,2})";

function build(
  site: ChannelSite,
  guestName: string,
  messageText: string,
  extras: { listingTitle?: string | null; reservationCode?: string | null; replyTo?: string | null },
): ChannelGuestMessage | null {
  const text = messageText.trim();
  if (!text) return null;
  const reply = extras.replyTo?.trim().toLowerCase() ?? "";
  return {
    site,
    guestName,
    guestFirstName: guestName.split(" ")[0]!.replace(/\.$/, ""),
    messageText: text,
    listingTitle: extras.listingTitle?.trim() || null,
    reservationCode: extras.reservationCode?.trim() || null,
    replyAddress: isChannelRelayAddress(site, reply) ? reply : null,
  };
}

function parseBookingCom(subject: string, lines: string[], replyTo: string | null): ChannelGuestMessage | null {
  const guest = guestFrom(
    subject,
    lines,
    [
      new RegExp(`new message from (?:guest\\s+)?${NAMEY}(?:\\s+(?:about|regarding|for)\\b.*)?$`, "iu"),
      new RegExp(`message from (?:your )?guest\\s+${NAMEY}(?:\\s+(?:about|regarding|for)\\b.*)?$`, "iu"),
    ],
    [new RegExp(`you (?:have|.ve got) a new message from (?:guest\\s+)?${NAMEY}\\s*$`, "iu"), new RegExp(`^guest\\s*[:\\-]\\s*${NAMEY}\\s*$`, "iu")],
  );
  if (!guest) return null;
  let listingTitle: string | undefined;
  let reservationCode: string | undefined;
  let start = 0;
  lines.forEach((line, i) => {
    const property = /^(?:property|accommodation|listing)\s*[:\-–—]\s*(.{3,120})$/i.exec(line)?.[1];
    if (property && !listingTitle) {
      listingTitle = property.trim();
      start = Math.max(start, i + 1);
    }
    const code = /^(?:reservation|booking)\s*(?:number|id|no\.?)?\s*[:#\-–—]\s*(\d{8,12})\b/i.exec(line)?.[1];
    if (code && !reservationCode) {
      reservationCode = code;
      start = Math.max(start, i + 1);
    }
    if (/^(?:check[\s-]?in|check[\s-]?out|arrival|departure|dates?|guests?)\s*[:\-–—]/i.test(line) || /^you (?:have|.ve got) a new message/i.test(line)) {
      start = Math.max(start, i + 1);
    }
  });
  const labelled = lines.findIndex((line) => /^(?:message|guest message|their message)\s*:\s*$/i.test(line));
  if (labelled >= 0) start = labelled + 1;
  const messageText = messageFrom(lines, start, /^(?:please reply|you can reply|reply from|extranet)/i);
  return build("booking_com", guest, messageText, { listingTitle, reservationCode, replyTo });
}

function parsePadSplit(subject: string, lines: string[], replyTo: string | null): ChannelGuestMessage | null {
  const guest = guestFrom(
    subject,
    lines,
    [
      new RegExp(`^(?:re:\\s*)?${NAMEY}\\s+sent you a message\\b`, "iu"),
      new RegExp(`new message from ${NAMEY}(?:\\s+(?:about|regarding|for)\\b.*)?$`, "iu"),
    ],
    [new RegExp(`^${NAMEY}\\s+sent you a message\\b`, "iu"), new RegExp(`^${NAMEY}\\s+(?:wrote|messaged you|is interested)\\b`, "iu")],
  );
  if (!guest) return null;
  let listingTitle: string | undefined;
  let start = 0;
  lines.forEach((line, i) => {
    const about = /sent you a message about\s+["“]?(.{3,120}?)["”]?\s*[:.]?\s*$/i.exec(line)?.[1] ?? /^(?:property|room|listing)\s*[:\-–—]\s*(.{3,120})$/i.exec(line)?.[1];
    if (about && !listingTitle) {
      listingTitle = about.trim();
      start = Math.max(start, i + 1);
    }
    if (/^(?:hi|hello|hey)\b.*,?$/i.test(line) && i < 3) start = Math.max(start, i + 1);
  });
  const subjectListing = /\babout\s+["“]?(.{3,100}?)["”]?\s*$/i.exec(subject)?.[1];
  if (!listingTitle && subjectListing && !/^(?:your|a|the)\s+(?:listing|property)$/i.test(subjectListing)) listingTitle = subjectListing.trim();
  const messageText = messageFrom(lines, start, /^(?:reply|respond|go to your inbox)/i);
  return build("padsplit", guest, messageText, { listingTitle, replyTo });
}

function parseSpareRoom(subject: string, lines: string[], replyTo: string | null): ChannelGuestMessage | null {
  const guest = guestFrom(
    subject,
    lines,
    [
      new RegExp(`^(?:re:\\s*)?new message from ${NAMEY}(?:\\s+(?:about|regarding|for)\\b.*)?$`, "iu"),
      new RegExp(`^(?:re:\\s*)?${NAMEY}\\s+(?:has )?sent you a message`, "iu"),
    ],
    [new RegExp(`^${NAMEY}\\s+(?:has )?sent you a message`, "iu"), new RegExp(`^from\\s*:\\s*${NAMEY}\\s*$`, "iu")],
  );
  if (!guest) return null;
  let listingTitle: string | undefined;
  let start = 0;
  lines.forEach((line, i) => {
    const ad = /(?:about your ad|regarding your ad|your ad)\s*[:\-–—]\s*["“]?(.{3,120}?)["”]?\s*$/i.exec(line)?.[1] ?? /^(?:ad|advert|listing|property)\s*[:\-–—]\s*(.{3,120})$/i.exec(line)?.[1];
    if (ad && !listingTitle) {
      listingTitle = ad.trim();
      start = Math.max(start, i + 1);
    }
    if (/sent you a message/i.test(line)) start = Math.max(start, i + 1);
  });
  const subjectListing = /\babout\s+["“']?(.{3,100}?)["”']?\s*$/i.exec(subject)?.[1];
  if (!listingTitle && subjectListing) listingTitle = subjectListing.trim();
  const labelled = lines.findIndex((line) => /^(?:message|their message)\s*:\s*$/i.test(line));
  if (labelled >= 0) start = labelled + 1;
  const messageText = messageFrom(lines, start, /^(?:reply|respond|view all)/i);
  return build("spareroom", guest, messageText, { listingTitle, replyTo });
}

/**
 * Read one site's guest-message email. `fromEmail` decides the site (never the body); a mail whose sender is some
 * other site's domain is parsed by that site's rules only. Null = not a guest message we can read.
 */
export function parseChannelGuestMessage(input: {
  fromEmail: string;
  subject: string;
  text: string;
  /** The Reply-To header (the site's relay address), when the mail carries one. */
  replyTo?: string | null;
}): ChannelGuestMessage | null {
  const site = channelSiteOfAddress(input.fromEmail);
  if (!site) return null;
  const subject = (input.subject ?? "").replace(/\s+/g, " ").trim();
  const replyTo = input.replyTo?.trim() ? input.replyTo.trim() : null;

  if (site === "airbnb") {
    const parsed = parseAirbnbGuestMessage({ subject, text: input.text });
    if (!parsed) return null;
    return build("airbnb", parsed.guestName, parsed.messageText, {
      listingTitle: parsed.listingTitle ?? null,
      reservationCode: parsed.confirmationCode ?? null,
      replyTo,
    });
  }
  const lines = normalizeBody(input.text);
  if (site === "booking_com") return parseBookingCom(subject, lines, replyTo);
  if (site === "padsplit") return parsePadSplit(subject, lines, replyTo);
  return parseSpareRoom(subject, lines, replyTo);
}

/**
 * The one conversation key per guest per site: a stable, never-deliverable address (`.invalid`, RFC 2606) derived from the
 * site and the guest's name. The conversation key resolver keys on it like any email, so a guest who writes again - even
 * about another reservation - lands in the same conversation, and nothing can ever be sent to it by accident.
 */
export function channelGuestKeyAddress(site: ChannelSite, guestName: string): string {
  const slug = guestName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "guest"}@${site.replace("_", "-")}.guest.invalid`;
}

export function isChannelGuestKeyAddress(address: string): boolean {
  return /@[a-z-]+\.guest\.invalid$/i.test(address.trim());
}
