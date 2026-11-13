import { parseChannelGuestMessage } from "@/lib/inbound-email/channel-senders";
import { assemble } from "./common";
import type { LeadParseInput, PlatformLeadMessage } from "./types";

/** SpareRoom keeps the parser that has handled live mail (`parseChannelGuestMessage`); this maps it onto the lead shape. */
export function parseSpareRoomLead(input: LeadParseInput): PlatformLeadMessage | null {
  const parsed = parseChannelGuestMessage({ fromEmail: input.fromEmail, subject: input.subject, text: input.text, replyTo: input.replyTo ?? null });
  if (!parsed || parsed.site !== "spareroom") return null;
  const result = assemble("spareroom", { ...input, replyTo: parsed.replyAddress }, { senderName: parsed.guestName, body: parsed.messageText, listingHint: parsed.listingTitle, via: "site" });
  return result;
}
