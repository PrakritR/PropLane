/**
 * Message a whole house: the pure half. Who lives there (derived from occupancy stays), what each person can
 * receive, the tally the compose sheet shows before Send, and the fan-out that sends ONE copy per person
 * through the existing per-person send route (so each copy lands in that person's own conversation and every
 * existing authorization applies). Not a group text: replies come back one-to-one.
 *
 * Server loading lives in `house-message-recipients.server.ts`. See docs/agents/send-message-compose.md.
 */
import { isPlaceholderMailbox, type InboxMessageDelivery } from "@/lib/inbox-delivery-status";
import { resolveRecipientChannels, type ReachChannel, type RecipientChannels } from "@/lib/recipient-channels";

/** A stay at least this long is a long-term resident; anything shorter is a short-stay guest. */
export const HOUSE_LONG_TERM_MIN_DAYS = 30;
/** How many per-person sends run at once. */
export const HOUSE_SEND_CONCURRENCY = 3;
/**
 * A fan-out spends one token of the send route's per-minute budget per person, so a big house (or a second
 * house in the same minute) can be refused with 429 part-way through. Each person is re-tried with the SAME
 * `sendId`, which the route treats as the same message, so a retry can only deliver what has not gone out —
 * never a second copy. The delays cover the limiter's one-minute window.
 */
export const HOUSE_SEND_RETRY_DELAYS_MS: readonly number[] = [5_000, 20_000, 35_000];

export type HouseRecipient = {
  /** The profile id when the person has an account, else their lowercased email. Stable per person. */
  id: string;
  name: string;
  roomLabel: string;
  /** The address the per-person send is addressed to (the person's inbox key). */
  email: string;
  userId: string | null;
  /** A short-stay / channel guest: left out unless the manager ticks "Include short-stay guests". */
  guest: boolean;
  channels: RecipientChannels;
};

export type HouseStayLike = {
  propertyId: string;
  roomLabel: string;
  start: string;
  end: string;
  openEnded?: boolean;
  resident?: {
    residentName?: string;
    residentEmail?: string;
    residentPhone?: string;
    icalConnectionId?: string;
    openEnded?: boolean;
    source?: string;
  };
};

export type HouseProfileLike = { id: string; email: string; phone: string | null; fullName: string };

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

/** Does this stay cover `today` (inclusive)? An open-ended stay has no end. */
function covers(stay: Pick<HouseStayLike, "start" | "end" | "openEnded">, today: string): boolean {
  return !(stay.start > today || (!stay.openEnded && stay.end < today));
}

/** A channel reservation, or any stay shorter than a month, is a short stay. */
export function isShortStayGuest(stay: HouseStayLike): boolean {
  if (stay.resident?.icalConnectionId) return true;
  return !(stay.openEnded || stay.resident?.openEnded || dayDiff(stay.start, stay.end) >= HOUSE_LONG_TERM_MIN_DAYS);
}

/**
 * The people living in one house today. Pure. A stay needs a `resident` payload (an executed lease or an
 * approved hold) and an address to send to; one person with two stays counts once, and a long-term stay wins
 * over a guest stay for the same person.
 */
export function houseResidentsFromStays(
  stays: readonly HouseStayLike[],
  input: {
    propertyId: string;
    today: string;
    includeGuests: boolean;
    profilesByEmail: ReadonlyMap<string, HouseProfileLike>;
    /** Lowercased emails whose phone has texted STOP. */
    optedOutEmails: ReadonlySet<string>;
    reachByEmail: ReadonlyMap<string, readonly ReachChannel[]>;
    /** Real phone digits on file for a person; absent = no phone. Defaults to profile phone, then the stay's. */
    normalizePhone: (raw: string | null | undefined) => string | null;
  },
): { people: HouseRecipient[]; excludedGuests: number; unaddressable: number } {
  const byKey = new Map<string, HouseRecipient>();
  let unaddressable = 0;
  const excludedGuestKeys = new Set<string>();
  for (const stay of stays) {
    if (stay.propertyId !== input.propertyId || !stay.resident) continue;
    if (!covers(stay, input.today)) continue;
    const email = String(stay.resident.residentEmail ?? "").trim().toLowerCase();
    if (!email) {
      unaddressable += 1;
      continue;
    }
    const guest = isShortStayGuest(stay);
    if (guest && !input.includeGuests) {
      excludedGuestKeys.add(email);
      continue;
    }
    const profile = input.profilesByEmail.get(email);
    const phone = input.normalizePhone(profile?.phone ?? stay.resident.residentPhone ?? null);
    const channels = resolveRecipientChannels({
      reachBy: input.reachByEmail.get(email) ?? null,
      hasVerifiedOrKnownPhone: Boolean(phone),
      optedOut: input.optedOutEmails.has(email),
      hasRealEmail: !isPlaceholderMailbox(email),
    });
    const name =
      profile?.fullName?.trim() || stay.resident.residentName?.trim() || `${stay.roomLabel.trim() || "Room"} resident`;
    const next: HouseRecipient = {
      id: profile?.id || email,
      name,
      roomLabel: stay.roomLabel.trim(),
      email,
      userId: profile?.id || null,
      guest,
      channels,
    };
    const existing = byKey.get(email);
    // A long-term stay beats a guest stay held by the same person.
    if (!existing || (existing.guest && !guest)) byKey.set(email, next);
  }
  const people = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const excludedGuests = [...excludedGuestKeys].filter((email) => !byKey.has(email)).length;
  return { people, excludedGuests, unaddressable };
}

export type HouseSendVia = { app: boolean; email: boolean; sms: boolean };

export type HouseChannelTally = {
  total: number;
  /** "Text 2 of 5": people who will get a text out of those the manager picked. Absent when Text is off. */
  sms: { reached: number; total: number } | null;
  email: { reached: number; total: number } | null;
  app: { reached: number; total: number };
  /** Who lacks a (usable) phone, only counted when Text is picked. */
  missingPhone: HouseRecipient[];
  /** Who has no real email (an import or placeholder address), only counted when Email is picked. */
  missingEmail: HouseRecipient[];
};

/** The per-channel tally shown before sending. App always reaches everyone. */
export function tallyHouseChannels(people: readonly HouseRecipient[], via: HouseSendVia): HouseChannelTally {
  const total = people.length;
  const missingPhone = via.sms ? people.filter((person) => !person.channels.sms) : [];
  const missingEmail = via.email ? people.filter((person) => !person.channels.email) : [];
  return {
    total,
    sms: via.sms ? { reached: total - missingPhone.length, total } : null,
    email: via.email ? { reached: total - missingEmail.length, total } : null,
    app: { reached: total, total },
    missingPhone,
    missingEmail,
  };
}

/** The one amber line: how many lack a phone, how many only have a placeholder email. Empty when everyone is reachable. */
export function houseLackLine(tally: HouseChannelTally): string {
  const parts: string[] = [];
  if (tally.missingPhone.length > 0) {
    parts.push(`${tally.missingPhone.length} ${tally.missingPhone.length === 1 ? "has" : "have"} no phone`);
  }
  if (tally.missingEmail.length > 0) {
    parts.push(`${tally.missingEmail.length} ${tally.missingEmail.length === 1 ? "has" : "have"} no real email`);
  }
  return parts.join(", ");
}

/** What a house recipient shows in the To picker. */
export function houseRecipientLabel(addressLabel: string, count: number): string {
  return `⌂ ${addressLabel} · everyone living there (${count})`;
}

/**
 * The body of one per-person send. The server re-authorizes the recipient; nothing here is trust. No
 * `propertyId`: on this route it switches on the property-manager fan-out, which a resident send must not trigger.
 */
export function houseSendPayload(
  person: HouseRecipient,
  input: { subject: string; text: string; via: HouseSendVia; senderName: string; sendId: string },
): Record<string, unknown> {
  return {
    fromName: input.senderName,
    toEmails: [person.email],
    ...(person.userId ? { toUserIds: [person.userId] } : {}),
    subject: input.subject || "Message",
    text: input.text,
    deliverToPortalInbox: true,
    deliverViaEmail: input.via.email && person.channels.email,
    deliverViaSms: input.via.sms && person.channels.sms,
    eventCategory: "messages",
    senderPortal: "manager",
    sendId: input.sendId,
  };
}

export type HouseChannelOutcome = "delivered" | "sent" | "sending" | "failed" | "skipped";

export type HousePersonResult = {
  id: string;
  name: string;
  roomLabel: string;
  ok: boolean;
  error?: string;
  email: HouseChannelOutcome | null;
  sms: HouseChannelOutcome | null;
  emailError?: string;
  smsError?: string;
};

function outcomeFor(
  channel: "email" | "sms",
  wanted: boolean,
  canReach: boolean,
  deliveries: readonly InboxMessageDelivery[] | undefined,
): { outcome: HouseChannelOutcome | null; error?: string } {
  if (!wanted) return { outcome: null };
  if (!canReach) return { outcome: "skipped" };
  const mine = (deliveries ?? []).filter((delivery) => delivery.channel === channel);
  if (mine.length === 0) return { outcome: "sent" };
  const failed = mine.find((delivery) => delivery.status === "failed");
  if (mine.some((delivery) => delivery.status === "delivered")) return { outcome: "delivered" };
  if (failed) return { outcome: "failed", error: failed.error };
  if (mine.some((delivery) => delivery.status === "sent")) return { outcome: "sent" };
  return { outcome: "sending" };
}

/** Read the `deliveries` the send route returns, when it returns them; otherwise a wanted channel reads "sent". */
export function personResultFromResponse(
  person: HouseRecipient,
  via: HouseSendVia,
  response: { ok: boolean; data: unknown },
): HousePersonResult {
  const base = { id: person.id, name: person.name, roomLabel: person.roomLabel };
  const data = (response.data && typeof response.data === "object" ? response.data : {}) as {
    ok?: boolean;
    error?: string;
    deliveries?: InboxMessageDelivery[];
    message?: { deliveries?: InboxMessageDelivery[] };
  };
  if (!response.ok || data.ok === false) {
    return { ...base, ok: false, error: data.error || "Could not send.", email: null, sms: null };
  }
  const deliveries = data.deliveries ?? data.message?.deliveries;
  const email = outcomeFor("email", via.email, person.channels.email, deliveries);
  const sms = outcomeFor("sms", via.sms, person.channels.sms, deliveries);
  return {
    ...base,
    ok: true,
    email: email.outcome,
    sms: sms.outcome,
    ...(email.error ? { emailError: email.error } : {}),
    ...(sms.error ? { smsError: sms.error } : {}),
  };
}

/**
 * One person's send, re-tried while the route refuses it for rate limiting (429). `attempt` must post the
 * same `sendId` every time: the send route is idempotent on it, so a retry never duplicates a copy that
 * already went out. Any other failure is returned as-is for the summary to report.
 */
export async function sendHousePersonWithRetry(
  attempt: () => Promise<{ status: number; ok: boolean; data: unknown }>,
  options: { delaysMs?: readonly number[]; wait?: (ms: number) => Promise<void> } = {},
): Promise<{ ok: boolean; data: unknown }> {
  const delays = options.delaysMs ?? HOUSE_SEND_RETRY_DELAYS_MS;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let result = await attempt();
  for (const delay of delays) {
    if (result.status !== 429) break;
    await wait(delay);
    result = await attempt();
  }
  return { ok: result.ok, data: result.data };
}

/**
 * One send per person, at most `concurrency` in flight. A person's failure never stops the others, and a
 * throw is recorded as that person's failure. Results keep the input order.
 */
export async function fanOutHouseSend(
  people: readonly HouseRecipient[],
  sendOne: (person: HouseRecipient) => Promise<HousePersonResult>,
  options: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<HousePersonResult[]> {
  const concurrency = Math.max(1, options.concurrency ?? HOUSE_SEND_CONCURRENCY);
  const results = new Array<HousePersonResult>(people.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < people.length) {
      const index = next;
      next += 1;
      const person = people[index]!;
      try {
        results[index] = await sendOne(person);
      } catch {
        results[index] = {
          id: person.id,
          name: person.name,
          roomLabel: person.roomLabel,
          ok: false,
          error: "Could not send.",
          email: null,
          sms: null,
        };
      }
      done += 1;
      options.onProgress?.(done, people.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, people.length) }, worker));
  return results;
}

/** Counts only, for analytics (never a name, address or number). */
export function houseSendCounts(results: readonly HousePersonResult[]) {
  return {
    recipients: results.length,
    sent: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    email_failed: results.filter((result) => result.email === "failed").length,
    sms_failed: results.filter((result) => result.sms === "failed").length,
  };
}

const OUTCOME_WORD: Record<HouseChannelOutcome, string> = {
  delivered: "Delivered",
  sent: "Sent",
  sending: "Sending…",
  failed: "Not delivered",
  skipped: "Skipped",
};

/** One plain line for a summary row: "App ✓ · Text Delivered · Email Not delivered". */
export function housePersonResultLine(result: HousePersonResult): string {
  if (!result.ok) return result.error || "Could not send.";
  const parts = ["App ✓"];
  if (result.sms) parts.push(`Text ${OUTCOME_WORD[result.sms]}`);
  if (result.email) parts.push(`Email ${OUTCOME_WORD[result.email]}`);
  return parts.join(" · ");
}
