import { assemble, bodyLines, messageBody, nameFrom, NAME } from "./common";
import type { LeadParseInput, PlatformLeadMessage } from "./types";

/** Facebook / Marketplace notification ("<Name> sent you a message about <listing>" / "<Name> is interested in <listing>"). Known shape. */
export function parseFacebookLead(input: LeadParseInput): PlatformLeadMessage | null {
  const lines = bodyLines(input.text);
  const subject = (input.subject ?? "").replace(/\s+/g, " ").trim();
  const name = nameFrom(
    subject,
    lines,
    [new RegExp(`^${NAME}\\s+(?:sent you a message|is interested in|messaged you|replied to)`, "iu"), new RegExp(`message from ${NAME}`, "iu")],
    [new RegExp(`^${NAME}\\s+(?:sent you a message|is interested in|messaged you)`, "iu")],
  );
  if (!name) return null;
  const listingHint = /(?:interested in|about|regarding)\s+["“]?(.{3,120}?)["”]?\s*[:.]?$/i.exec(subject)?.[1] ?? lines.map((l) => /(?:interested in|about)\s+["“]?(.{3,120}?)["”]?\s*[:.]?$/i.exec(l)?.[1]).find(Boolean) ?? null;
  const start = lines.findIndex((line) => /sent you a message|is interested in|messaged you/i.test(line)) + 1;
  return assemble("facebook", input, { senderName: name, body: messageBody(lines, start), listingHint, via: "site" });
}
