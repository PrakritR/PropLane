import { assemble, bodyLines, messageBody, nameFrom, NAME } from "./common";
import type { LeadParseInput, PlatformLeadMessage } from "./types";

/** Roomster ("<Name> sent you a message on Roomster"). Known shape, not a real mail. */
export function parseRoomsterLead(input: LeadParseInput): PlatformLeadMessage | null {
  const lines = bodyLines(input.text);
  const subject = (input.subject ?? "").replace(/\s+/g, " ").trim();
  const name = nameFrom(
    subject,
    lines,
    [new RegExp(`^${NAME}\\s+sent you a message`, "iu"), new RegExp(`new message from ${NAME}`, "iu")],
    [new RegExp(`^${NAME}\\s+sent you a message`, "iu")],
  );
  if (!name) return null;
  const listingHint = lines.map((l) => /^(?:listing|post|room)\s*[:\-–—]\s*(.{3,120})$/i.exec(l)?.[1] ?? /message about\s+["“]?(.{3,120}?)["”]?\s*[:.]?$/i.exec(l)?.[1]).find(Boolean) ?? null;
  const start = lines.findIndex((line) => /sent you a message/i.test(line)) + 1;
  return assemble("roomster", input, { senderName: name, body: messageBody(lines, start), listingHint, via: "site" });
}
