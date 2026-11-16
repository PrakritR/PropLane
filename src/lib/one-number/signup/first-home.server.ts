import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { phoneOwners } from "@/lib/auth/phone-auth.server";
import { uploadListingPhotoBytes } from "@/lib/listing-draft-agent.server";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import { toGsm7 } from "@/lib/one-number/lead-qualifying";
import { saveTextListingDraft } from "@/lib/one-number/onboarding/house-draft.server";
import {
  isDoneText,
  isLaterText,
  isSkipText,
  parseAvailabilityAnswer,
  parseHomeAddressAnswer,
  parseRoomsAndRentAnswer,
  parseRulesAnswer,
  type RoomsAndRent,
} from "@/lib/one-number/signup/first-home-parse";
import { mintPhoneSignInLink } from "@/lib/one-number/signup/sign-in-link.server";
import { rateLimit } from "@/lib/rate-limit";
import { phoneKeyOf, phoneRateKey } from "@/lib/sms/phone-key";
import { SMS_MEDIA_BUCKET, SMS_MEDIA_MAX_BYTES } from "@/lib/sms-media.server";

/**
 * "Add your first home" by text: the second half of a landlord's text sign-up (docs/agents/one-number.md § PropLane Jobs and
 * the landlord walkthrough). After the account exists (name, business, the phone proven by the code the person texted back),
 * the same conversation asks, one question per text:
 *
 *   address -> rooms and rent -> when available -> house rules -> photos (MMS) -> DONE
 *
 * and ends with a DRAFT listing plus a one-tap link to finish and publish it in the portal. No model runs: every question
 * and every parse is fixed code.
 *
 * Invariants
 *  - The listing is written ONLY by `saveTextListingDraft` (the one text-listing writer, shared with the assistant's
 *    `create_listing_draft_by_text`): `status: "draft"`, never public, never a listing slot. Publishing stays the Add property
 *    wizard's (`POST /api/property-records`: ownership, plan cap, listing wizard defaults, `publicListingProjection`).
 *  - The account is the session's `user_id`, written by the sign-up after the code proof; every turn re-checks that this
 *    phone is that account's VERIFIED phone (`phoneOwners`) and fails closed. Nothing about identity comes from the text.
 *  - Photos are the texter's own MMS from this verified phone (indexed in `sms_media_files` before routing), re-uploaded to the
 *    public listing-photos bucket under THEIR account; only images, size-capped, at most 12.
 *  - A reply is only sent to the person who texted (the line's own transport); STOP, quiet hours and consent are the
 *    transport's. A session idles out after 48 hours; CANCEL / LATER ends it and keeps the account.
 */

export type FirstHomeStep = "address" | "rooms" | "available" | "rules" | "photos";

export type FirstHomeAnswers = {
  address?: string;
  roomCount?: number;
  rentsUsd?: number[];
  availability?: string;
  rules?: string;
  photoCount?: number;
  /** Names this walkthrough's draft (`ft-<flowKey>`); a later walkthrough is a new draft, never a rewrite of a published one. */
  flowKey?: string;
};

export type FirstHomeSession = {
  phoneKey: string;
  userId: string;
  step: FirstHomeStep;
  answers: FirstHomeAnswers;
  lastSid: string | null;
  updatedAt: string;
};

export const FIRST_HOME_TTL_MS = 48 * 60 * 60 * 1000;
export const FIRST_HOME_TURNS_PER_PHONE_PER_DAY = 60;
export const FIRST_HOME_MAX_PHOTOS = 12;
const STEPS: readonly FirstHomeStep[] = ["address", "rooms", "available", "rules", "photos"];

export const FIRST_HOME_COPY = {
  askAddress: "Want to add your first home now? Text its street address, like 4709A 8th Ave. Or reply LATER.",
  retryAddress: "I need a street address with the house number, like 4709A 8th Ave. Or reply LATER.",
  askRooms: "How many rooms are for rent, and the monthly rent? For example: 3 rooms, $900 each. Or list each rent: 4 rooms $850 $900 $900 $950.",
  retryRooms: "I could not read that. Try: 3 rooms, $900 each. If the rents differ, give one per room.",
  askAvailable: "When can a tenant move in? Say 'now' or a date like Dec 1. Reply SKIP if unsure.",
  retryAvailable: "I could not read that date. Say 'now' or a date like Dec 1, or reply SKIP.",
  askRules: "Any house rules to list? For example: no smoking, quiet after 10pm. Reply SKIP to leave it for now.",
  retryRules: "Send your house rules as one short line, or reply SKIP.",
  askPhotos: "Last step: text photos of the home (rooms, kitchen, bathrooms), then reply DONE. Or reply SKIP to add them later.",
  gotPhotos: (n: number, total: number) => `Got ${n} photo${n === 1 ? "" : "s"} (${total} so far). Send more, or reply DONE.`,
  noPhotosYet: "I have not received any photos yet. Text them to this number, then reply DONE. Or reply SKIP.",
  later: (link: string) => `No problem. Text me a street address any time to add a home, or open your portal: ${link}`,
  unavailable: "I could not save that just now. Please text me again in a minute.",
  busy: "That is a lot of texts for today. Please pick this up again tomorrow, or open your portal.",
} as const;

type Row = Record<string, unknown>;

function toSession(row: Row): FirstHomeSession {
  const answers = row.answers && typeof row.answers === "object" && !Array.isArray(row.answers) ? (row.answers as FirstHomeAnswers) : {};
  const step = STEPS.find((s) => s === row.step) ?? "address";
  return {
    phoneKey: String(row.phone_key ?? ""),
    userId: String(row.user_id ?? ""),
    step,
    answers,
    lastSid: typeof row.last_sid === "string" ? row.last_sid : null,
    updatedAt: String(row.updated_at ?? ""),
  };
}

export async function readFirstHomeSession(db: SupabaseClient, phoneKey: string): Promise<FirstHomeSession | null> {
  const { data, error } = await db.from("sms_first_home_sessions").select("phone_key, user_id, step, answers, last_sid, updated_at").eq("phone_key", phoneKey).maybeSingle();
  if (error || !data) return null;
  return toSession(data as Row);
}

async function writeSession(db: SupabaseClient, s: { phoneKey: string; userId: string; step: FirstHomeStep; answers: FirstHomeAnswers; lastSid: string | null; now: Date }): Promise<boolean> {
  const { error } = await db.from("sms_first_home_sessions").upsert(
    { phone_key: s.phoneKey, user_id: s.userId, step: s.step, answers: s.answers, last_sid: s.lastSid, updated_at: s.now.toISOString() },
    { onConflict: "phone_key" },
  );
  if (error && !isMissingSchemaError(error)) console.error("first-home session write failed", error.code ?? "unknown");
  return !error;
}

async function deleteSession(db: SupabaseClient, phoneKey: string): Promise<void> {
  await db.from("sms_first_home_sessions").delete().eq("phone_key", phoneKey).then(() => undefined, () => undefined);
}

/**
 * Open the walkthrough for a landlord whose account was JUST created from this phone. Returns the first question (the sign-up
 * appends it to its welcome), or null when it could not be stored (the welcome then goes out without it). Idempotent.
 */
export async function startFirstHomeWalkthrough(db: SupabaseClient, input: { phoneE164: string; userId: string; now?: Date }): Promise<string | null> {
  const phoneKey = phoneKeyOf(input.phoneE164);
  if (!/^\d{10}$/.test(phoneKey) || !input.userId) return null;
  const ok = await writeSession(db, { phoneKey, userId: input.userId, step: "address", answers: { flowKey: (input.now ?? new Date()).getTime().toString(36) }, lastSid: null, now: input.now ?? new Date() });
  return ok ? FIRST_HOME_COPY.askAddress : null;
}

export type FirstHomeTurn = { handled: false } | { handled: true; reply: string };

export type FirstHomeDeps = {
  now?: () => Date;
  origin?: string;
  /** Test seam: who owns this verified phone. */
  findOwners?: (db: SupabaseClient, phone: string) => Promise<string[]>;
  /** Test seam: the one-tap portal link. */
  signInLink?: (db: SupabaseClient, input: { phoneE164: string; userId: string }) => Promise<string | null>;
  /** Test seam: the photos the person texted (already uploaded to listing-photos). */
  adoptPhotos?: (db: SupabaseClient, input: { phoneKey: string; userId: string; now: Date }) => Promise<{ urls: string[]; mediaIds: string[] }>;
};

const say = (text: string): FirstHomeTurn => ({ handled: true, reply: toGsm7(text) });

/** The next question after `step`, in order. */
export function nextFirstHomeStep(step: FirstHomeStep): FirstHomeStep | null {
  const i = STEPS.indexOf(step);
  return STEPS[i + 1] ?? null;
}

function questionFor(step: FirstHomeStep): string {
  switch (step) {
    case "address": return FIRST_HOME_COPY.askAddress;
    case "rooms": return FIRST_HOME_COPY.askRooms;
    case "available": return FIRST_HOME_COPY.askAvailable;
    case "rules": return FIRST_HOME_COPY.askRules;
    case "photos": return FIRST_HOME_COPY.askPhotos;
  }
}

function retryFor(step: FirstHomeStep): string {
  switch (step) {
    case "address": return FIRST_HOME_COPY.retryAddress;
    case "rooms": return FIRST_HOME_COPY.retryRooms;
    case "available": return FIRST_HOME_COPY.retryAvailable;
    case "rules": return FIRST_HOME_COPY.retryRules;
    case "photos": return FIRST_HOME_COPY.noPhotosYet;
  }
}

/** The flow id: one draft per walkthrough (the draft id is deterministic per account + flow, so a retry rewrites the same row). */
function flowIdFor(session: Pick<FirstHomeSession, "phoneKey" | "answers">): string {
  return `ft-${session.answers.flowKey || session.phoneKey}`.slice(0, 64);
}

async function saveDraft(db: SupabaseClient, session: FirstHomeSession, answers: FirstHomeAnswers, photoUrls: string[]): Promise<{ ok: true; propertyId: string } | { ok: false }> {
  if (!answers.address || !answers.roomCount || !answers.rentsUsd?.length) return { ok: false };
  const saved = await saveTextListingDraft(db, {
    userId: session.userId,
    flowId: flowIdFor(session),
    address: answers.address,
    roomCount: answers.roomCount,
    rentsUsd: answers.rentsUsd,
    availabilityText: answers.availability ?? null,
    rulesText: answers.rules ?? null,
    photoUrls,
  });
  return saved.ok ? { ok: true, propertyId: saved.propertyId } : { ok: false };
}

/** The recent unlinked images this verified phone texted, re-uploaded to the public listing-photos bucket under the account. */
async function defaultAdoptPhotos(db: SupabaseClient, input: { phoneKey: string; userId: string; now: Date }): Promise<{ urls: string[]; mediaIds: string[] }> {
  const since = new Date(input.now.getTime() - FIRST_HOME_TTL_MS).toISOString();
  const { data, error } = await db
    .from("sms_media_files")
    .select("id, storage_path, content_type, byte_size")
    .eq("sender_phone_key", input.phoneKey)
    .is("linked_type", null)
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(FIRST_HOME_MAX_PHOTOS);
  if (error || !data) return { urls: [], mediaIds: [] };
  const urls: string[] = [];
  const mediaIds: string[] = [];
  for (const row of data as Row[]) {
    const type = String(row.content_type ?? "");
    if (!/^image\/(jpeg|png|webp|heic|gif)$/i.test(type)) continue;
    if (Number(row.byte_size ?? 0) > SMS_MEDIA_MAX_BYTES) continue;
    const { data: blob } = await db.storage.from(SMS_MEDIA_BUCKET).download(String(row.storage_path));
    if (!blob) continue;
    const bytes = Buffer.from(await blob.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > SMS_MEDIA_MAX_BYTES) continue;
    try {
      urls.push(await uploadListingPhotoBytes(db, input.userId, bytes, type.toLowerCase()));
      mediaIds.push(String(row.id));
    } catch {
      /* skip the one that would not upload */
    }
  }
  return { urls, mediaIds };
}

/**
 * One inbound text. `handled: false` = this phone has no live walkthrough (the caller continues exactly as before). Anything
 * else is answered here. `body` may be empty for a photo-only text; the media was already indexed by the pipeline.
 */
export async function handleFirstHomeText(
  db: SupabaseClient,
  input: { phoneE164: string; body: string; messageSid: string; hasMedia?: boolean },
  deps: FirstHomeDeps = {},
): Promise<FirstHomeTurn> {
  const now = (deps.now ?? (() => new Date()))();
  const phoneKey = phoneKeyOf(input.phoneE164);
  if (!/^\d{10}$/.test(phoneKey)) return { handled: false };
  const session = await readFirstHomeSession(db, phoneKey);
  if (!session) return { handled: false };
  const updated = Date.parse(session.updatedAt);
  if (!Number.isFinite(updated) || now.getTime() - updated > FIRST_HOME_TTL_MS) {
    await deleteSession(db, phoneKey);
    return { handled: false };
  }
  // Fail closed on identity: this must still be the account's VERIFIED phone.
  const owners = await (deps.findOwners ?? phoneOwners)(db, input.phoneE164).catch(() => null);
  if (!owners || owners.length !== 1 || owners[0] !== session.userId) return { handled: false };
  if (!(await rateLimit(`first-home:${phoneRateKey(input.phoneE164)}`, FIRST_HOME_TURNS_PER_PHONE_PER_DAY, 24 * 60 * 60 * 1000)).ok) return say(FIRST_HOME_COPY.busy);

  const body = String(input.body ?? "").trim().slice(0, 500);
  const origin = (deps.origin ?? resolveEmailLinkBaseUrl()).replace(/\/$/, "");
  const portalLink = async () => (await (deps.signInLink ?? mintPhoneSignInLink)(db, { phoneE164: input.phoneE164, userId: session.userId }).catch(() => null)) ?? `${origin}/auth/sign-in`;
  const save = (step: FirstHomeStep, answers: FirstHomeAnswers) => writeSession(db, { phoneKey, userId: session.userId, step, answers, lastSid: input.messageSid || null, now });

  // A retried webhook: say the current question again, change nothing.
  if (input.messageSid && session.lastSid === input.messageSid) return say(questionFor(session.step));

  if (body && isLaterText(body)) {
    await deleteSession(db, phoneKey);
    return say(FIRST_HOME_COPY.later(`${origin}/portal/properties`));
  }

  const answers: FirstHomeAnswers = { ...session.answers };
  const advance = async (from: FirstHomeStep): Promise<FirstHomeTurn> => {
    const next = nextFirstHomeStep(from);
    if (next === null) return finish();
    // The draft exists as soon as the essentials are known, so stopping anywhere after "rules" still leaves a real draft.
    if (next === "photos") {
      const draft = await saveDraft(db, session, answers, []);
      if (!draft.ok) return say(FIRST_HOME_COPY.unavailable);
    }
    await save(next, answers);
    return say(questionFor(next));
  };
  const retry = async (): Promise<FirstHomeTurn> => {
    await save(session.step, answers);
    return say(retryFor(session.step));
  };
  const finish = async (): Promise<FirstHomeTurn> => {
    const adopt = deps.adoptPhotos ?? defaultAdoptPhotos;
    const photos = await adopt(db, { phoneKey, userId: session.userId, now }).catch(() => ({ urls: [] as string[], mediaIds: [] as string[] }));
    const draft = await saveDraft(db, session, answers, photos.urls);
    if (!draft.ok) return say(FIRST_HOME_COPY.unavailable);
    if (photos.mediaIds.length > 0) {
      await db.from("sms_media_files").update({ linked_type: "listing", linked_id: draft.propertyId }).in("id", photos.mediaIds).is("linked_type", null).then(() => undefined, () => undefined);
    }
    await deleteSession(db, phoneKey);
    const link = await portalLink();
    const photoNote = photos.urls.length > 0 ? ` with ${photos.urls.length} photo${photos.urls.length === 1 ? "" : "s"}` : "";
    return say(`Your first home is saved as a draft${photoNote}. It is not public yet. Review it and publish it here: ${link} You are on the free plan, and you can upgrade any time in Settings.`);
  };

  switch (session.step) {
    case "address": {
      const parsed = parseHomeAddressAnswer(body);
      if (parsed.kind !== "value") return retry();
      answers.address = parsed.value;
      return advance("address");
    }
    case "rooms": {
      const parsed = parseRoomsAndRentAnswer(body);
      if (parsed.kind !== "value") return retry();
      const v: RoomsAndRent = parsed.value;
      answers.roomCount = v.roomCount;
      answers.rentsUsd = v.rentsUsd;
      return advance("rooms");
    }
    case "available": {
      const parsed = parseAvailabilityAnswer(body);
      if (parsed.kind === "invalid") return retry();
      if (parsed.kind === "value") answers.availability = parsed.value;
      return advance("available");
    }
    case "rules": {
      const parsed = parseRulesAnswer(body);
      if (parsed.kind === "invalid") return retry();
      if (parsed.kind === "value") answers.rules = parsed.value;
      return advance("rules");
    }
    case "photos": {
      if (isDoneText(body) || isSkipText(body)) return finish();
      // A photo-only text (or one with a caption): count what has arrived, ask for more or DONE.
      const total = input.hasMedia ? await countPendingPhotos(db, phoneKey, now) : 0;
      if (total > 0) {
        const before = session.answers.photoCount ?? 0;
        answers.photoCount = total;
        await save("photos", answers);
        return say(FIRST_HOME_COPY.gotPhotos(total > before ? total - before : total, total));
      }
      return retry();
    }
  }
}

async function countPendingPhotos(db: SupabaseClient, phoneKey: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - FIRST_HOME_TTL_MS).toISOString();
  const { count } = await db.from("sms_media_files").select("id", { count: "exact", head: true }).eq("sender_phone_key", phoneKey).is("linked_type", null).gte("created_at", since);
  return Math.min(count ?? 0, FIRST_HOME_MAX_PHOTOS);
}
