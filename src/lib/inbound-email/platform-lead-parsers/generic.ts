import { assemble, bodyLines, messageBody } from "./common";
import { PLATFORM_LEAD_LABEL, type LeadParseInput, type PlatformLeadMessage, type PlatformLeadSite } from "./types";
import { plausibleGuestName } from "@/lib/inbound-email/airbnb-parser";

const HEADERISH =
  /^(?:hi|hello|hey)\b.*[,!]?$|^(?:from|to|subject|date|sent)\s*:|sent you a message|new (?:message|inquiry|lead)|is interested in|wants to know|inquir(?:y|ed)|^(?:message|their message|your message)\s*:?\s*$|^re:/i;

/**
 * The fallback when a site's own parser is off, unverified or came back empty: sender domain -> site, then whatever the
 * mail says about the person, the listing and the message. Never null for a mail with a readable body, so a lead from a
 * site whose format we have not seen is still stored, tagged and alerted - nothing is dropped.
 */
export function parseGenericLead(site: PlatformLeadSite, input: LeadParseInput): PlatformLeadMessage | null {
  const lines = bodyLines(input.text);
  const subject = (input.subject ?? "").replace(/\s+/g, " ").trim();
  const label = PLATFORM_LEAD_LABEL[site];

  // The sender: a "From" name that is not the site's own brand, else a name in the subject or the first lines.
  const fromName = plausibleGuestName(input.fromName ?? undefined);
  const brand = new RegExp(`^(?:${label}|no.?reply|notifications?|messages?|automated|mailer)`, "i");
  let senderName = fromName && !brand.test(fromName) ? fromName : undefined;
  if (!senderName) {
    for (const pattern of [
      /(?:message|inquiry|reply|response) (?:from|by)\s+([\p{L}][\p{L}'’.\- ]{1,40}?)(?:\s+(?:about|regarding|for|on|re)\b|\s*[:\-–—]|$)/iu,
      /^([\p{L}][\p{L}'’.\-]*(?:\s+[\p{L}][\p{L}'’.\-]*){0,2})\s+(?:sent you|is interested|wants|messaged|asked|replied)/iu,
    ]) {
      const hit = plausibleGuestName(pattern.exec(subject)?.[1]) ?? lines.slice(0, 14).map((l) => plausibleGuestName(pattern.exec(l)?.[1])).find(Boolean);
      if (hit) {
        senderName = hit;
        break;
      }
    }
  }

  // The listing: an "about <x>" in the subject, else the first line that names an ad / address / room.
  let listingHint: string | null = /\b(?:about|regarding|re:?|for)\s+["“']?(.{3,100}?)["”']?\s*$/i.exec(subject)?.[1] ?? null;
  const listingLine = lines.slice(0, 16).find((line) => /\b(?:ad|advert|listing|property|room|post)\b.*[:\-–—]\s*.{3,}|\b\d{2,5}[a-z]?\s+[A-Za-z]+\s+(?:ave|st|street|avenue|way|blvd|rd|road|dr|drive)\b/i.test(line));
  if (listingLine) listingHint = [listingHint, listingLine].filter(Boolean).join(" ");

  // The message: after the last header-ish line near the top, up to the footer.
  let start = 0;
  lines.slice(0, 12).forEach((line, index) => {
    if (HEADERISH.test(line)) start = index + 1;
  });
  let body = messageBody(lines, start);
  if (!body) body = messageBody(lines, 0);
  return assemble(site, input, { senderName: senderName ?? `${label} lead`, body, listingHint, via: "generic" });
}
