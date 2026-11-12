import { classifyIntentHeuristic, type SmsIntent } from "@/lib/one-number/intent";
import { redactSensitiveNumbers } from "@/lib/one-number/redact";
import { toGsm7 } from "@/lib/one-number/segments";

/**
 * The text PropLane's own people get when someone texts a PropLane-managed workspace's number or the PropLane line
 * (pure: no database, no clock). One line: WHO (a name when PropLane knows it, else the last four digits), WHICH HOUSE,
 * WHAT they want in a few words, and a short https link into the portal thread. GSM-7, no card or bank number
 * (the quoted words are redacted first), never longer than two segments.
 */
export type InboundSenderKind = "owner" | "resident" | "applicant" | "prospect" | "vendor" | "unknown";

export const INBOUND_ALERT_MAX_CHARS = 300;
const QUOTE_CHARS = 70;

const KIND_LABEL: Record<InboundSenderKind, string> = {
  owner: "Owner",
  resident: "Resident",
  applicant: "Applicant",
  prospect: "Lead",
  vendor: "Vendor",
  unknown: "New contact",
};

/** What they want, in plain words: from the sender's relationship first, then from what the text says. */
export function inboundGist(kind: InboundSenderKind, body: string): string {
  const intent: SmsIntent | null = classifyIntentHeuristic(body);
  if (kind === "owner") {
    if (intent === "rent") return "owner asking about rent or money";
    if (intent === "maintenance") return "owner raising a repair";
    return "owner message";
  }
  if (kind === "vendor") return intent === "maintenance" ? "vendor about a service" : "vendor message";
  if (intent === "human_needed") return kind === "resident" ? "resident wants a person" : "wants a person";
  if (kind === "resident") {
    if (intent === "maintenance") return "resident reports a repair issue";
    if (intent === "rent") return "resident asks about rent or a charge";
    if (intent === "tour" || intent === "application") return "resident asks about a room or application";
    return "resident message";
  }
  if (intent === "tour") return "lead wants a tour";
  if (intent === "application") return "lead asking about applying";
  if (intent === "rent") return "asking about rent";
  if (intent === "maintenance") return "reports a repair issue";
  return kind === "unknown" ? "new contact, no clear ask" : "lead message";
}

export function senderName(name: string | null | undefined, phone: string): string {
  const raw = (name ?? "").replace(/\s+/g, " ").trim();
  if (raw && !/@/.test(raw) && !/^\+?\d[\d\s().-]{6,}$/.test(raw)) return raw.slice(0, 40);
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-4)}` : "Unknown number";
}

/** A short quote of the text with card / bank numbers removed and quotes and links flattened. */
export function inboundQuote(body: string): string {
  const flat = redactSensitiveNumbers(String(body ?? "").replace(/\s+/g, " ").trim()).text.replace(/https?:\/\/\S+/g, "").replace(/"/g, "'").trim();
  if (!flat) return "";
  return flat.length > QUOTE_CHARS ? `${flat.slice(0, QUOTE_CHARS - 3).trimEnd()}...` : flat;
}

export function buildInboundAlertText(input: {
  kind: InboundSenderKind;
  name?: string | null;
  phone: string;
  /** The house label (with the room when known), or null when no house is known yet. */
  house?: string | null;
  body: string;
  link: string;
  /** Where the text came from when it was not an SMS ("Listing message", "SpareRoom"). Shown in place of "text". */
  channelLabel?: string | null;
  /** The short handle this staff phone replies with ("K7"); the line `Reply: K7 <your message>` is added when set. */
  handle?: string | null;
}): string {
  const who = senderName(input.name, input.phone);
  const house = input.house?.replace(/\s+/g, " ").trim();
  const quote = inboundQuote(input.body);
  const channel = input.channelLabel?.replace(/\s+/g, " ").trim();
  const head = `PropLane ${channel ? channel.toLowerCase() : "text"}: ${KIND_LABEL[input.kind]} ${who}${house ? ` (${house})` : " (house not known yet)"} - ${inboundGist(input.kind, input.body)}`;
  const line = `${head}${quote ? ` "${quote}"` : ""}`;
  const handle = (input.handle ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 4);
  const replyLine = handle ? `Reply: ${handle} <your message>` : "";
  const room = INBOUND_ALERT_MAX_CHARS - input.link.length - 1 - (replyLine ? replyLine.length + 1 : 0);
  const fitted = line.length > room ? `${line.slice(0, Math.max(0, room - 3)).trimEnd()}...` : line;
  return toGsm7(`${fitted}\n${replyLine ? `${replyLine}\n` : ""}${input.link}`);
}
