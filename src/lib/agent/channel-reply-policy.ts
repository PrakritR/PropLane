/**
 * What the channel guest assistant may say, and what it may not answer on its own. Pure: no IO.
 *
 * Two independent gates sit between a model and a guest on Airbnb, Booking.com, PadSplit or SpareRoom:
 *
 * 1. `channelHoldReason` reads the GUEST's message. Money, refunds, cancellations and complaints are never answered
 *    automatically: the draft is stored and the manager is told (captain, Oct 26, Decide 1).
 * 2. `channelReplyViolations` reads the REPLY. Airbnb and Booking.com penalise (and can suspend for) contact details in
 *    a message, so a reply with a link, a phone number or an email is held no matter what the prompt said; PadSplit and
 *    SpareRoom may carry the listing link and the PropLane line, never an address or any other number.
 *
 * Both fail toward holding: a held reply is a draft the manager sends with one tap, a sent one cannot be recalled.
 */
import { channelAllowsContactDetails, type ChannelSite } from "@/lib/inbound-email/channel-senders";

export type ChannelHoldReason = "money" | "cancellation" | "complaint";

const HOLD_PATTERNS: { reason: ChannelHoldReason; pattern: RegExp }[] = [
  {
    reason: "cancellation",
    pattern: /\b(cancel(?:l?ed|l?ing|lation|lations)?|call off|no longer (?:coming|need)|can(?:no|')?t (?:make it|come|stay)|change (?:my|the) (?:dates|reservation|booking)|shorten my stay|leave early)\b/i,
  },
  {
    reason: "money",
    pattern: /\b(refund(?:s|ed|ing)?|money back|pay(?:ing)? (?:me )?back|reimburs\w*|compensat\w*|charge[ds]?\b|charge ?back|overcharg\w*|double[- ]?charged|dispute[ds]?|deposit (?:back|return)|return(?:ed)? (?:my )?deposit|discount|cheaper|lower (?:the )?price|negotiat\w*|waive|fee waiver|pay(?:ing)? (?:in )?cash|venmo|zelle|paypal|cash ?app|wire (?:transfer|me)|invoice|receipt)\b/i,
  },
  {
    reason: "complaint",
    pattern: /\b(complain\w*|unacceptable|terrible|horrible|awful|disgust\w*|filthy|dirty|unsafe|not safe|dangerous|scam\w*|fraud\w*|rip[- ]?off|mold|mould|bed ?bugs?|roach\w*|cockroach\w*|mice|rats?|infest\w*|broken|doesn.?t work|not working|no (?:hot water|heat|power|wifi|internet)|disappointed|misled|misrepresent\w*|lied|lawyer|attorney|sue\b|legal action|police|report (?:you|this|the host)|bad review|leave a review|one star|1[- ]star)\b/i,
  },
];

/** Why a guest message must wait for the manager, or null when the assistant may answer it. */
export function channelHoldReason(guestMessage: string): ChannelHoldReason | null {
  const text = guestMessage ?? "";
  for (const { reason, pattern } of HOLD_PATTERNS) {
    if (pattern.test(text)) return reason;
  }
  return null;
}

export const CHANNEL_HOLD_REASON_LABEL: Record<ChannelHoldReason, string> = {
  money: "money or a refund",
  cancellation: "a cancellation or change",
  complaint: "a complaint",
};

/** A reply the assistant may send when it could not check availability: never "available". */
export const CHANNEL_CONFIRM_LATER_REPLY = "Thanks for asking! Let me confirm the exact availability and get back to you shortly.";

const URL_PATTERN = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|ai|io|co|us|app|me|info|biz|ly|link|uk|ca)\b(?:\/\S*)?/i;
const EMAIL_PATTERN = /[a-z0-9._%+-]+\s?(?:@|\[at\]|\(at\))\s?[a-z0-9-]+(?:\.[a-z0-9-]+)+/i;
const OFF_PLATFORM_PATTERN = /\b(whatsapp|telegram|signal app|text me|call me|venmo|zelle|paypal|cash ?app|wire transfer|google voice)\b/i;

function stripSafeNumbers(reply: string): string {
  return reply
    .replace(/\b20\d{2}-\d{2}-\d{2}\b/g, " ")
    .replace(/\$\s?\d[\d,]*(?:\.\d{2})?/g, " ")
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, " ");
}

/** Digit runs that read as a phone number: 10+ digits, or the common 3-3-4 / 3-4 separated shapes. */
export function phoneNumbersIn(reply: string): string[] {
  const text = stripSafeNumbers(reply);
  const found: string[] = [];
  for (const match of text.matchAll(/(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b|\b\d{3}[\s.\-]\d{4}\b|\+?\d[\d\s().\-]{8,}\d/g)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 7) found.push(digits);
  }
  return found;
}

export type ChannelReplyViolation = "link" | "email" | "phone" | "off_platform";

/**
 * Everything in `reply` the site's rules forbid. Empty = fine to send. `allowedPhoneDigits` is the PropLane line (digits
 * only, with or without the leading 1) a PadSplit/SpareRoom reply may quote; Airbnb/Booking.com allow no number at all.
 */
export function channelReplyViolations(
  site: ChannelSite,
  reply: string,
  options: { allowedPhoneDigits?: string | null } = {},
): ChannelReplyViolation[] {
  const text = reply ?? "";
  const out: ChannelReplyViolation[] = [];
  const contactAllowed = channelAllowsContactDetails(site);
  if (EMAIL_PATTERN.test(text)) out.push("email");
  const withoutEmails = text.replace(new RegExp(EMAIL_PATTERN.source, "gi"), " ");
  if (!contactAllowed && URL_PATTERN.test(withoutEmails)) out.push("link");
  if (OFF_PLATFORM_PATTERN.test(text) && (!contactAllowed || /\b(?:venmo|zelle|paypal|cash ?app|wire transfer|whatsapp|telegram|signal app|google voice)\b/i.test(text))) {
    out.push("off_platform");
  }
  const allowed = (options.allowedPhoneDigits ?? "").replace(/\D/g, "");
  const allowedTail = allowed.length >= 10 ? allowed.slice(-10) : "";
  for (const digits of phoneNumbersIn(text)) {
    if (contactAllowed && allowedTail && digits.slice(-10) === allowedTail) continue;
    out.push("phone");
    break;
  }
  return out;
}

/** The channel-specific half of the system prompt: the site's rules, the hold rule and the availability rule. */
export function channelAgentInstructions(input: {
  site: ChannelSite;
  siteLabel: string;
  guestName: string;
  listingLine: string | null;
  holdReason: ChannelHoldReason | null;
  serviceWorkspace: boolean;
  proplaneLine: string | null;
}): string {
  const { site, siteLabel } = input;
  const contactAllowed = channelAllowsContactDetails(site);
  const lines = [
    "",
    `You are replying to a guest message that arrived from ${siteLabel}. The reply is posted in the guest's thread on ${siteLabel}, by email through the site's own relay. It is a message in a chat, not a text and not a letter.`,
    `The guest is ${input.guestName}.${input.listingLine ? ` They are asking about: ${input.listingLine}.` : " The listing they asked about could not be matched to a PropLane room: ask which house or room they mean, from list_live_listings, before stating any availability."}`,
    "Keep it to a few friendly sentences. Do not sign off with a name or a signature block.",
    "",
    "AVAILABILITY: state availability only from list_live_listings, get_listing_details or check_room_availability in THIS turn. Name the room and the exact date it is free (for example \"Room 6 is free from November 1\"). Never use a published label or anything remembered from earlier. If a tool call fails, or returns an answer that is not verified, say you will confirm and get back to them. Never say a room is available without a verified tool answer.",
  ];
  if (contactAllowed) {
    lines.push(
      `LINKS: you may include the home's own listing link exactly as the tool returned it${input.proplaneLine ? ` and the PropLane line ${input.proplaneLine}` : ""}. Never any other phone number, and never an email address.`,
    );
  } else {
    lines.push(
      `${siteLabel} FORBIDS contact details in messages. Never include a link, a web address, a phone number, an email address, or any request to move the conversation or the payment off ${siteLabel} (no text me, call me, WhatsApp, Venmo, Zelle). A reply containing one will be discarded.`,
    );
  }
  lines.push(
    "MONEY AND DISPUTES: never promise, offer or discuss a refund, a discount, a price change, a cancellation or a compensation, and never take a side in a complaint. You may state the listed price when asked.",
  );
  if (input.holdReason) {
    lines.push(
      `HELD FOR THE MANAGER: this message is about ${input.holdReason === "money" ? "money or a refund" : input.holdReason === "cancellation" ? "a cancellation or a change to the reservation" : "a complaint"}. Write only a short, warm holding reply that acknowledges it and says the host will follow up personally. Do not commit to anything; the manager will read it before it is sent.`,
    );
  }
  if (input.serviceWorkspace) {
    lines.push("This is a PropLane-managed workspace: only the homes PropLane manages are in your catalog.");
  }
  return lines.join("\n");
}

/** The reads that return the CHECKED calendar (occupancy, every channel booking). `get_listing_details` and `check_room_availability` are per room; the listing search now carries it for the homes it returns. */
export const CHECKED_AVAILABILITY_TOOLS: readonly string[] = ["list_live_listings", "get_listing_details", "check_room_availability"];

const AVAILABILITY_CLAIM = /\b(is available|are available|available (?:now|from|on|until|starting)|free (?:from|on|until|starting)|is free|vacant|open (?:from|on|now)|ready (?:from|on)|move[- ]in (?:on|from))\b/i;

/** One room an availability read reported on, and whether that read actually VERIFIED it. */
type CheckedRoom = { label: string | null; verified: boolean };

/**
 * The rooms one checked read reported on. A read that merely SUCCEEDED proves nothing: `list_live_listings` reads real
 * occupancy for the first ranked homes only and returns `currentAvailabilityVerified: false` for every other room (and
 * for every room of a home whose occupancy read threw), and `check_room_availability` / `get_listing_details` return
 * `available: null` / `currentAvailabilityVerified: false` for the same reason. So the room rows are read, not the call.
 */
function checkedRoomsIn(output: unknown): CheckedRoom[] {
  const rooms: CheckedRoom[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (node === null || typeof node !== "object" || depth > 8) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const row = node as Record<string, unknown>;
    const label =
      typeof row.name === "string" && row.name.trim() ? row.name.trim()
      : typeof row.roomLabel === "string" && row.roomLabel.trim() ? row.roomLabel.trim()
      : null;
    if (typeof row.currentAvailabilityVerified === "boolean") {
      rooms.push({ label, verified: row.currentAvailabilityVerified });
    } else if (typeof row.roomId === "string" && "available" in row) {
      rooms.push({ label, verified: typeof row.available === "boolean" });
    }
    for (const value of Object.values(row)) visit(value, depth + 1);
  };
  visit(output, 0);
  return rooms;
}

function mentionsLabel(reply: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(reply);
  } catch {
    return reply.toLowerCase().includes(label.toLowerCase());
  }
}

/**
 * Availability is only ever stated from a checked tool read that VERIFIED a room. A reply that states availability is
 * replaced with the confirm-later text when no room came back verified in this turn, and when it names a room whose
 * own read was NOT verified (the unverified half of a list the model was also shown). Pure: the tool answers are the
 * evidence, never the fact a call was made.
 */
export function enforceCheckedAvailability(input: {
  reply: string;
  /** This turn's successful reads with their own answers (`runAgentTurn().toolEvidence`). */
  toolEvidence: readonly { tool: string; output: unknown }[];
}): { reply: string; replaced: boolean } {
  const reply = input.reply ?? "";
  if (!AVAILABILITY_CLAIM.test(reply)) return { reply, replaced: false };
  const rooms = input.toolEvidence
    .filter((entry) => CHECKED_AVAILABILITY_TOOLS.includes(entry.tool))
    .flatMap((entry) => checkedRoomsIn(entry.output));
  if (!rooms.some((room) => room.verified)) return { reply: CHANNEL_CONFIRM_LATER_REPLY, replaced: true };
  const verifiedLabels = new Set(rooms.filter((room) => room.verified && room.label).map((room) => room.label!.toLowerCase()));
  const namesUnverifiedRoom = rooms.some(
    (room) => !room.verified && room.label && !verifiedLabels.has(room.label.toLowerCase()) && mentionsLabel(reply, room.label),
  );
  if (namesUnverifiedRoom) return { reply: CHANNEL_CONFIRM_LATER_REPLY, replaced: true };
  return { reply, replaced: false };
}
