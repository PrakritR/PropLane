import { assemble, bodyLines, messageBody, nameFrom, NAME } from "./common";
import type { LeadParseInput, PlatformLeadMessage } from "./types";

/** Roomies ("<Name> sent you a message about <listing>"). Written from the known shape, not from a real mail: see PLATFORM_LEAD_PARSER_VERIFIED. */
export function parseRoomiesLead(input: LeadParseInput): PlatformLeadMessage | null {
  const lines = bodyLines(input.text);
  const subject = (input.subject ?? "").replace(/\s+/g, " ").trim();
  const name = nameFrom(
    subject,
    lines,
    [new RegExp(`^(?:re:\\s*)?new message from ${NAME}(?:\\s+(?:on|about)\\b.*)?$`, "iu"), new RegExp(`^${NAME}\\s+sent you a message`, "iu")],
    [new RegExp(`^${NAME}\\s+sent you a message`, "iu"), new RegExp(`^from\\s*:\\s*${NAME}\\s*$`, "iu")],
  );
  if (!name) return null;
  let listingHint: string | null = null;
  let start = 0;
  lines.forEach((line, i) => {
    const about = /sent you a message about\s+["“]?(.{3,120}?)["”]?\s*[:.]?$/i.exec(line)?.[1] ?? /^(?:listing|room|post)\s*[:\-–—]\s*(.{3,120})$/i.exec(line)?.[1];
    if (about && !listingHint) {
      listingHint = about;
      start = Math.max(start, i + 1);
    }
    if (/sent you a message/i.test(line)) start = Math.max(start, i + 1);
  });
  return assemble("roomies", input, { senderName: name, body: messageBody(lines, start), listingHint, via: "site" });
}
