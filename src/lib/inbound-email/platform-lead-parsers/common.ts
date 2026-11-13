import { normalizeE164 } from "@/lib/phone-e164";
import { plausibleGuestName } from "@/lib/inbound-email/airbnb-parser";
import { singleEmailAddress } from "@/lib/inbound-email/channel-senders";
import { PLATFORM_LEAD_DOMAINS, type LeadParseInput, type PlatformLeadMessage, type PlatformLeadSite } from "./types";

export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return (at >= 0 ? address.slice(at + 1) : address).replace(/[>\s]/g, "").toLowerCase();
}

export function domainBelongsTo(domain: string, parents: readonly string[]): boolean {
  return parents.some((parent) => domain === parent || domain.endsWith(`.${parent}`));
}

/** Which lead site an address belongs to, by exact domain or true subdomain. Null for everyone else. */
export function leadSiteOfAddress(address: string): PlatformLeadSite | null {
  const domain = domainOf(address);
  if (!domain.includes(".")) return null;
  for (const [site, domains] of Object.entries(PLATFORM_LEAD_DOMAINS) as [PlatformLeadSite, readonly string[]][]) {
    if (domainBelongsTo(domain, domains)) return site;
  }
  return null;
}

/** A reply address is trusted only on the site's OWN domain: a lead mail cannot point replies somewhere else. */
export function isLeadRelayAddress(site: PlatformLeadSite, address: string | null | undefined): boolean {
  const value = singleEmailAddress(address);
  return Boolean(value) && domainBelongsTo(domainOf(value!), PLATFORM_LEAD_DOMAINS[site]);
}

const FOOTER =
  /^(?:reply to this (?:email|message)|reply directly|to reply|view (?:the )?(?:message|conversation|listing)|view in|open the|respond (?:in|to)|log in to|sign in to|unsubscribe|this (?:email|message) was sent|sent (?:with|from|by)|please (?:do not|don.?t) reply|copyright|©|manage (?:your )?(?:notification|email)|you received this|to stop receiving|safety tip|original craigslist post|zillow,? inc|roomies|roomster|spareroom|facebook|meta platforms)/i;

export function bodyLines(text: string): string[] {
  return (text ?? "")
    .replace(/ /g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[>\s]+/, "").replace(/[ \t]+/g, " ").trim());
}

/** The prospect's message: the lines after the last header-ish line up to the first footer marker. */
export function messageBody(lines: string[], start = 0): string {
  const kept: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (FOOTER.test(line)) break;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000);
}

const NAME_PATTERN = "([\\p{L}][\\p{L}'’\\-]*\\.?(?:[ \\t]+[\\p{L}][\\p{L}'’\\-]*\\.?){0,2})";

export function nameFrom(subject: string, lines: string[], subjectPatterns: readonly RegExp[], bodyPatterns: readonly RegExp[]): string | undefined {
  for (const pattern of subjectPatterns) {
    const name = plausibleGuestName(pattern.exec(subject)?.[1]);
    if (name) return name;
  }
  for (const line of lines.slice(0, 16)) {
    for (const pattern of bodyPatterns) {
      const name = plausibleGuestName(pattern.exec(line)?.[1]);
      if (name) return name;
    }
  }
  return undefined;
}

export const NAME = NAME_PATTERN;

const PHONE_SHAPE = /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b/g;

/** The first phone number the prospect wrote: strict E.164 parse, never one of PropLane's own lines. */
export function phoneInText(text: string, exclude: readonly string[] = []): string | null {
  const skip = new Set(exclude.map((phone) => normalizeE164(phone)).filter((phone): phone is string => Boolean(phone)));
  // Dates and money never read as a phone number.
  const cleaned = text.replace(/\b20\d{2}-\d{2}-\d{2}\b/g, " ").replace(/\$\s?\d[\d,]*(?:\.\d{2})?/g, " ");
  for (const match of cleaned.matchAll(PHONE_SHAPE)) {
    const phone = normalizeE164(match[0]);
    if (phone && !skip.has(phone)) return phone;
  }
  return null;
}

/** "Room 9", "room #9", "Rm 9": the room the mail names, as the manager would call it. */
export function roomHintFrom(...texts: Array<string | null | undefined>): string | null {
  for (const text of texts) {
    const match = /\b(?:room|rm)\s*#?\s*([A-Za-z]?\d{1,3}[A-Za-z]?)\b/i.exec(text ?? "");
    if (match) return `Room ${match[1]!.toUpperCase()}`;
  }
  return null;
}

export function urlIn(text: string, hosts: readonly string[]): string | null {
  for (const match of text.matchAll(/https?:\/\/[^\s<>")]+/gi)) {
    try {
      const host = new URL(match[0]).hostname.toLowerCase();
      if (domainBelongsTo(host, hosts)) return match[0].replace(/[.,;]+$/, "");
    } catch {
      /* not a url */
    }
  }
  return null;
}

export function threadIdIn(text: string): string | null {
  const match = /(?:thread|conversation|message|inquiry)s?[\/=:#]\s*([A-Za-z0-9_-]{6,64})/i.exec(text);
  return match?.[1] ?? null;
}

export function assemble(
  site: PlatformLeadSite,
  input: LeadParseInput,
  parts: { senderName: string; body: string; listingHint: string | null; via: "site" | "generic" },
): PlatformLeadMessage | null {
  const body = parts.body.trim();
  if (body.length < 2) return null;
  const reply = singleEmailAddress(input.replyTo);
  const hosts = PLATFORM_LEAD_DOMAINS[site];
  return {
    site,
    senderName: parts.senderName,
    body,
    listingHint: parts.listingHint?.trim() || null,
    roomHint: roomHintFrom(parts.listingHint, input.subject, body),
    replyAddress: reply && isLeadRelayAddress(site, reply) ? reply : null,
    phoneInBody: phoneInText(body, input.excludePhones ?? []),
    platformThreadId: threadIdIn(input.text),
    listingUrl: urlIn(input.text, hosts),
    via: parts.via,
  };
}
