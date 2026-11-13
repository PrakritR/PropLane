import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { mintPhoneSession, phoneOwners } from "@/lib/auth/phone-auth.server";
import { smsProvenSessionAllowed } from "@/lib/auth/sms-proven-session.server";
import { recordOptOut } from "@/lib/house-groups/store.server";
import { addResidentToHouseSmsGroup } from "@/lib/house-sms-group/sync.server";
import { sendWorkspaceText } from "@/lib/one-number/link-text.server";
import { type PhoneBoundLink } from "@/lib/one-number/links.server";
import { provisionSmsSignupAccount } from "@/lib/one-number/signup/provision.server";
import { ROOM_DATE_BLOCK_RECORD_TYPE } from "@/lib/portal-schedule-record-scope";
import {
  firstNameOf,
  ONBOARDING_TARGET_TYPE,
  onboardingWelcomeText,
  parseOnboardingTargetId,
  validateOnboardingInput,
  type OnboardingPrefill,
} from "./model";
import { ONBOARDING_WELCOME_SMS_PURPOSE } from "./send.server";
import { loadOnboardingFacts, type OnboardingFacts, type OnboardingFactsResult } from "./sources.server";
import { createHash } from "node:crypto";

export type OnboardingOpen =
  | { ok: true; facts: OnboardingFacts; prefill: OnboardingPrefill }
  | { ok: false; reason: "gone" };

export type OnboardingDeps = {
  facts?: (input: { workspaceId: string; kind: "application" | "booking"; id: string }) => Promise<OnboardingFactsResult>;
  verifyIdRequired?: (facts: OnboardingFacts, userId: string | null) => Promise<boolean>;
  findOwners?: (db: SupabaseClient, phone: string) => Promise<string[]>;
  provision?: typeof provisionSmsSignupAccount;
  sessionAllowed?: (db: SupabaseClient, userId: string) => Promise<boolean>;
  mintSession?: (db: SupabaseClient, userId: string) => Promise<{ access_token: string; refresh_token: string } | null>;
  addToGroup?: typeof addResidentToHouseSmsGroup;
  sendText?: typeof sendWorkspaceText;
  optOut?: typeof recordOptOut;
  now?: () => Date;
};

async function defaultVerifyIdRequired(db: SupabaseClient, facts: OnboardingFacts): Promise<boolean> {
  // The manager's own setting for this house, and only while an ID check can actually run in this environment.
  try {
    const { resolveApplicantScreeningSettings } = await import("@/lib/screening/applicant-screening-settings.server");
    const resolved = await resolveApplicantScreeningSettings(db, { managerUserId: facts.ownerUserId, propertyId: facts.propertyId, workspaceId: facts.workspaceId });
    return resolved.settings.idCheck === true && facts.kind === "application";
  } catch {
    return false;
  }
}

function maskLast4(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `•••• ${digits.slice(-4)}`;
}

/**
 * The record behind an OPEN (code-verified) onboarding link, re-derived live, and what the form starts with. The
 * phone on the record must still be the phone the link is bound to (a record whose number was edited since the
 * text went out reads as `gone`). Callers must have proven the link's code first.
 */
export async function openOnboarding(
  db: SupabaseClient,
  link: Pick<PhoneBoundLink, "purpose" | "targetType" | "targetId" | "workspaceId" | "phoneKey">,
  deps: OnboardingDeps = {},
): Promise<OnboardingOpen> {
  if (link.purpose !== "move_in" || link.targetType !== ONBOARDING_TARGET_TYPE || !link.workspaceId) return { ok: false, reason: "gone" };
  const target = parseOnboardingTargetId(link.targetId);
  if (!target) return { ok: false, reason: "gone" };
  const loaded = await (deps.facts ?? ((i) => loadOnboardingFacts(db, i)))({ workspaceId: link.workspaceId, kind: target.kind, id: target.id });
  if (!loaded.ok || loaded.facts.phoneKey !== link.phoneKey) return { ok: false, reason: "gone" };
  const { facts } = loaded;
  const verifyIdRequired = await (deps.verifyIdRequired ?? ((f) => defaultVerifyIdRequired(db, f)))(facts, facts.residentUserId);
  return {
    ok: true,
    facts,
    prefill: {
      fullName: facts.fullName,
      email: facts.email,
      houseLabel: facts.houseLabel,
      roomLabel: facts.roomLabel,
      moveInDate: facts.moveInDate,
      houseRules: facts.houseRules,
      maskedPhone: maskLast4(facts.phoneE164),
      verifyIdRequired,
    },
  };
}

export type CompleteOnboardingResult =
  | { ok: true; userId: string; created: boolean; session: { access_token: string; refresh_token: string } | null; nextPath: string }
  | { ok: false; status: 400 | 404 | 409 | 503; error: string };

/**
 * Finish onboarding. Only reached with a live code-verified session on THIS link (the route proves it), so this is
 * the first moment an account may exist. In order:
 *
 *  1. the record is re-read and its phone re-matched to the link; the form is validated (rules accepted when the
 *     house has rules);
 *  2. the account for this PROVEN phone: none yet -> the SMS sign-up provisioning (a phone-only resident login, the
 *     same `provisionSmsSignupAccount` the by-text sign-up uses; the typed email stays an unverified claim and is
 *     never the login); exactly one existing account whose credentials are no stronger than a phone -> that one
 *     (no password is set by a phone proof); anything else -> refused, the person signs in the normal way;
 *  3. a booking is stamped with the account (`residentUserId`, only when unbound); an application is NOT bound here:
 *     its binding is the emailed `token_hash` proof (`bind_resident_setup_subject`), which stays the one door;
 *  4. rules acceptance is kept on the account, a "no" to the group text is the same state as texting LEAVE GROUP;
 *  5. the link is spent (single use), the house's SMS group re-derives its members from occupancy (so a resident
 *     with a current lease joins, and one who opted out does not), one welcome text goes from the workspace line,
 *     and a signed-in session is minted where a phone proof is enough.
 */
export async function completeOnboarding(
  db: SupabaseClient,
  input: { link: PhoneBoundLink; body: unknown },
  deps: OnboardingDeps = {},
): Promise<CompleteOnboardingResult> {
  // Single use is a claim, not a read: the link row is spent atomically (`used_at is null` -> now) BEFORE anything is
  // created, so two simultaneous submits cannot both win, and a replayed call finds it spent. A refusal or a crash
  // before the account exists gives the claim back, so the person can try again with the same link.
  const now = (deps.now ?? (() => new Date()))();
  const claimed = await claimLink(db, input.link.id, now);
  if (!claimed) return { ok: false, status: 404, error: "This link has expired." };
  let finished = false;
  try {
    const result = await finishOnboarding(db, input, deps, now);
    finished = result.ok;
    return result;
  } finally {
    if (!finished) await releaseLink(db, input.link.id);
  }
}

async function claimLink(db: SupabaseClient, linkId: string, now: Date): Promise<boolean> {
  const { data, error } = await db
    .from("phone_bound_links")
    .update({ used_at: now.toISOString() })
    .eq("id", linkId)
    .is("used_at", null)
    .is("revoked_at", null)
    .gt("expires_at", now.toISOString())
    .select("id");
  return !error && Array.isArray(data) && data.length > 0;
}

async function releaseLink(db: SupabaseClient, linkId: string): Promise<void> {
  await db.from("phone_bound_links").update({ used_at: null }).eq("id", linkId).then(() => undefined, () => undefined);
}

async function finishOnboarding(
  db: SupabaseClient,
  input: { link: PhoneBoundLink; body: unknown },
  deps: OnboardingDeps,
  now: Date,
): Promise<CompleteOnboardingResult> {
  const opened = await openOnboarding(db, input.link, deps);
  if (!opened.ok) return { ok: false, status: 404, error: "This link has expired." };
  const { facts, prefill } = opened;
  const checked = validateOnboardingInput(input.body, { rulesRequired: Boolean(facts.houseRules) });
  if (!checked.ok) return { ok: false, status: 400, error: checked.error };
  const form = checked.value;

  const owners = await (deps.findOwners ?? phoneOwners)(db, facts.phoneE164).catch(() => null);
  if (owners === null) return { ok: false, status: 503, error: "We could not finish that just now. Try again in a moment." };
  const sessionAllowed = deps.sessionAllowed ?? smsProvenSessionAllowed;
  let userId: string | null = null;
  let created = false;
  if (owners.length === 0) {
    const provisioned = await (deps.provision ?? provisionSmsSignupAccount)(db, {
      phoneE164: facts.phoneE164,
      role: "resident",
      answers: { fullName: form.fullName, ...(form.email ? { email: form.email } : {}), home: facts.houseLabel },
    });
    if (provisioned.ok) {
      userId = provisioned.userId;
      created = true;
    } else if (provisioned.reason === "exists" && provisioned.existingUserId) {
      userId = provisioned.existingUserId;
    } else {
      return { ok: false, status: 503, error: "We could not finish that just now. Try again in a moment." };
    }
  } else if (owners.length === 1) {
    userId = owners[0]!;
  } else {
    return { ok: false, status: 409, error: "Sign in to continue." };
  }
  if (!created && !(await sessionAllowed(db, userId))) return { ok: false, status: 409, error: "Sign in to continue." };

  // The record's account. An application waits for the emailed proof; a booking is stamped (only while unbound).
  if (facts.residentUserId && facts.residentUserId !== userId) return { ok: false, status: 409, error: "Sign in to continue." };
  if (facts.kind === "booking" && !facts.residentUserId) {
    const stamped = await stampBooking(db, facts.id, userId);
    if (!stamped) return { ok: false, status: 409, error: "Sign in to continue." };
  }

  await recordRulesAcceptance(db, userId, facts, form.fullName, form.acceptRules, now);
  if (!form.joinGroupText) await (deps.optOut ?? recordOptOut)(db, facts.workspaceId, facts.phoneKey).catch(() => false);

  // Everything after the account is best effort: the person is onboarded whether or not these land.
  await (deps.addToGroup ?? addResidentToHouseSmsGroup)(db, { workspaceId: facts.workspaceId, propertyId: facts.propertyId }).catch(() => null);
  await (deps.sendText ?? sendWorkspaceText)(db, {
    workspaceId: facts.workspaceId,
    phoneKey: facts.phoneE164,
    body: onboardingWelcomeText({ firstName: firstNameOf(form.fullName), houseLabel: facts.houseLabel }),
    role: "resident",
    idempotencyKey: `onboarding-welcome:${userId}:${facts.propertyId}`,
    propertyId: facts.propertyId,
    basis: { kind: "resident_notice", purpose: ONBOARDING_WELCOME_SMS_PURPOSE, sendClass: "transactional", recipientUserId: userId, recipientEmail: facts.email || null },
  }).catch(() => undefined);

  let session: { access_token: string; refresh_token: string } | null = null;
  try {
    if (created || (await sessionAllowed(db, userId))) {
      session = deps.mintSession ? await deps.mintSession(db, userId) : await mintSessionFor(db, userId);
    }
  } catch {
    session = null;
  }
  return { ok: true, userId, created, session, nextPath: prefill.verifyIdRequired ? "/resident/profile#verification" : "/resident" };
}

async function mintSessionFor(db: SupabaseClient, userId: string) {
  const { data, error } = await db.auth.admin.getUserById(userId);
  if (error || !data.user) return null;
  return mintPhoneSession(db, data.user);
}

/** Stamp the booking with the account, only while it has none. Compare-and-set on `updated_at`. */
async function stampBooking(db: SupabaseClient, blockId: string, userId: string): Promise<boolean> {
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("row_data, updated_at, record_type")
    .eq("id", blockId)
    .maybeSingle();
  const row = data as { row_data?: Record<string, unknown>; updated_at?: string | null; record_type?: string } | null;
  if (error || !row || row.record_type !== ROOM_DATE_BLOCK_RECORD_TYPE) return false;
  const bound = typeof row.row_data?.residentUserId === "string" ? row.row_data.residentUserId.trim() : "";
  if (bound) return bound === userId;
  let query = db.from("portal_schedule_records").update({ row_data: { ...(row.row_data ?? {}), residentUserId: userId } }).eq("id", blockId);
  query = row.updated_at ? query.eq("updated_at", row.updated_at) : query;
  const { data: updated, error: updateError } = await query.select("id");
  return !updateError && Array.isArray(updated) && updated.length > 0;
}

/** The acceptance, kept on the account: which house, when, and a digest of the exact rules shown. Never the rules' text. */
async function recordRulesAcceptance(db: SupabaseClient, userId: string, facts: OnboardingFacts, fullName: string, accepted: boolean, now: Date): Promise<void> {
  try {
    const { data } = await db.auth.admin.getUserById(userId);
    const meta = (data.user?.user_metadata ?? {}) as Record<string, unknown>;
    const prior = Array.isArray(meta.house_rules_accepted) ? (meta.house_rules_accepted as unknown[]) : [];
    const entry = accepted && facts.houseRules
      ? { propertyId: facts.propertyId, at: now.toISOString(), sha256: createHash("sha256").update(facts.houseRules).digest("hex") }
      : null;
    await db.auth.admin.updateUserById(userId, {
      user_metadata: {
        ...meta,
        ...(meta.full_name ? {} : { full_name: fullName }),
        ...(entry ? { house_rules_accepted: [...prior.filter((p) => (p as { propertyId?: string })?.propertyId !== facts.propertyId), entry].slice(-20) } : {}),
        onboarding_completed_at: now.toISOString(),
      },
    });
  } catch {
    /* the account exists; the acceptance is re-asked at lease signing */
  }
}
