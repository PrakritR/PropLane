/**
 * How one person can be reached — the "Reach by" setting — and the one pure
 * decision that turns an automation's channels into what actually goes out.
 *
 * Pure (no server imports) so the resident wizard, the resident Settings pane and
 * the dispatchers all read the same answer. Server loading lives in
 * `recipient-channels.server.ts`.
 *
 * Every automation sends on: the event's channels ∩ the person's Reach by ∩ what
 * the person can actually receive. The app (inbox) is always on and is never an
 * option someone can remove: it is the durable record.
 */

export type ReachChannel = "app" | "email" | "sms";

export const REACH_CHANNELS: ReachChannel[] = ["app", "email", "sms"];

export const REACH_CHANNEL_LABELS: Record<ReachChannel, string> = { app: "App", email: "Email", sms: "Text" };

/**
 * A stored `reachBy` list. Absent / not an array = the person never chose, which
 * means every channel they can receive. A chosen list always carries `app`.
 */
export function normalizeReachBy(raw: unknown): ReachChannel[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const picked = new Set<ReachChannel>(["app"]);
  for (const value of raw) {
    if (value === "email" || value === "sms") picked.add(value);
  }
  return REACH_CHANNELS.filter((channel) => picked.has(channel));
}

/** The same family `isPlaceholderResidentEmail` skips for outbound mail (import, harness, junk addresses). */
export function hasRealEmailAddress(email: string | null | undefined): boolean {
  const to = (email ?? "").trim().toLowerCase();
  if (!to) return false;
  if (to.endsWith("@axis.local") || to.endsWith("@test.proplane.local") || to.endsWith("@import.proplane.local")) return false;
  if (/[()<>]/.test(to)) return false;
  return /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(to);
}

export type RecipientChannelInput = {
  /** What the event / reminder rule sends on. Absent = no restriction from the rule. */
  eventChannels?: { email?: boolean; sms?: boolean } | null;
  /** The person's own Reach by. Absent = they never chose, so nothing is narrowed. */
  reachBy?: readonly ReachChannel[] | null;
  /** A phone number is on file (verified or merely known). */
  hasVerifiedOrKnownPhone: boolean;
  /** That number texted STOP. */
  optedOut: boolean;
  /** The address on file is a real mailbox, not an import / placeholder address. */
  hasRealEmail: boolean;
};

export type RecipientChannels = { app: true; email: boolean; sms: boolean };

export function resolveRecipientChannels(input: RecipientChannelInput): RecipientChannels {
  const reach = input.reachBy ? new Set<ReachChannel>(input.reachBy) : null;
  const ruleAllows = (channel: "email" | "sms") => (input.eventChannels ? input.eventChannels[channel] !== false : true);
  const personAllows = (channel: "email" | "sms") => (reach ? reach.has(channel) : true);
  return {
    app: true,
    email: input.hasRealEmail && ruleAllows("email") && personAllows("email"),
    // STOP always wins: an opted-out number never gets a text, whatever else is ticked.
    sms: input.hasVerifiedOrKnownPhone && !input.optedOut && ruleAllows("sms") && personAllows("sms"),
  };
}

/** The inline error when an Add resident form has neither a phone nor "No phone". */
export const PHONE_REQUIRED_MESSAGE = "Enter a phone number, or tick No phone.";
