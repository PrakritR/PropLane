import { assemble, bodyLines, messageBody, nameFrom, NAME } from "./common";
import type { LeadParseInput, PlatformLeadMessage } from "./types";

/** Zillow Rentals inquiry ("New inquiry for <address>", Name / Email / Phone / Message). Known shape, not a real mail. */
export function parseZillowLead(input: LeadParseInput): PlatformLeadMessage | null {
  const lines = bodyLines(input.text);
  const subject = (input.subject ?? "").replace(/\s+/g, " ").trim();
  const labelled = (label: string) => lines.map((line) => new RegExp(`^${label}\\s*:\\s*(.{1,80})$`, "i").exec(line)?.[1]).find(Boolean);
  const name =
    nameFrom(subject, lines, [new RegExp(`^${NAME}\\s+is interested in\\b`, "iu"), new RegExp(`inquiry from ${NAME}`, "iu")], [new RegExp(`^${NAME}\\s+is interested in\\b`, "iu")]) ??
    nameFrom("", [`x`, labelled("name") ? `${labelled("name")} sent you a message` : ""], [], [new RegExp(`^${NAME}\\s+sent you a message`, "iu")]);
  if (!name) return null;
  const listingHint = /\b(?:for|in|at|about)\s+(\d{1,6}[A-Za-z]?\s+.{3,80})$/i.exec(subject)?.[1] ?? labelled("(?:property|listing|address)") ?? null;
  const at = lines.findIndex((line) => /^message\s*:/i.test(line));
  let body: string;
  if (at >= 0) {
    const first = lines[at]!.replace(/^message\s*:\s*/i, "");
    body = [first, messageBody(lines, at + 1)].filter(Boolean).join("\n");
  } else {
    body = messageBody(lines, lines.findIndex((line) => /interested in|inquiry/i.test(line)) + 1);
  }
  return assemble("zillow", input, { senderName: name, body, listingHint, via: "site" });
}
