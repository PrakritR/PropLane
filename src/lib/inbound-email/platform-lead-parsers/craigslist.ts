import { assemble, bodyLines, messageBody } from "./common";
import type { LeadParseInput, PlatformLeadMessage } from "./types";

/**
 * Craigslist anonymised relay: the SUBJECT is the ad's title (often prefixed "Re:"), the body is the sender's message, the
 * reply goes to the `…@reply.craigslist.org` Reply-To. The sender has no name: the relay handle stands in. Known shape.
 */
export function parseCraigslistLead(input: LeadParseInput): PlatformLeadMessage | null {
  const lines = bodyLines(input.text);
  const subject = (input.subject ?? "").replace(/\s+/g, " ").replace(/^(?:re|fwd?)\s*:\s*/i, "").trim();
  const body = messageBody(lines, 0);
  return assemble("craigslist", input, { senderName: "Craigslist lead", body, listingHint: subject || null, via: "site" });
}
