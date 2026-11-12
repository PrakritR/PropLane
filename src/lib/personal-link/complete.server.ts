import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mintPhoneSession, phoneOwners } from "@/lib/auth/phone-auth.server";
import { smsProvenSessionAllowed } from "@/lib/auth/sms-proven-session.server";
import type { PhoneBoundLink } from "@/lib/one-number/links.server";
import { provisionSmsSignupAccount } from "@/lib/one-number/signup/provision.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { linkAccountToProspectRecord } from "@/lib/prospect-spine/index.server";
import { startEmailProof } from "./email-proof.server";
import { openPersonalAccountLink } from "./open.server";
import { residentPortalApplyReturnPath } from "@/lib/rental-application/public-apply-session";
import { PERSONAL_LINK_LANDING_PATH, validatePersonalAccountInput } from "./model";

export async function defaultEmailTaken(db: SupabaseClient, email: string): Promise<boolean> {
  const { data, error } = await db.from("profiles").select("id").eq("email", email.toLowerCase()).limit(1);
  return Boolean(error) || (data ?? []).length > 0;
}

async function defaultSetPassword(db: SupabaseClient, userId: string, password: string): Promise<boolean> {
  const { error } = await db.auth.admin.updateUserById(userId, { password });
  return !error;
}

export type PersonalAccountDeps = {
  open?: typeof openPersonalAccountLink;
  findOwners?: (db: SupabaseClient, phone: string) => Promise<string[]>;
  provision?: typeof provisionSmsSignupAccount;
  sessionAllowed?: (db: SupabaseClient, userId: string) => Promise<boolean>;
  mintSession?: (db: SupabaseClient, userId: string) => Promise<{ access_token: string; refresh_token: string } | null>;
  link?: typeof linkAccountToProspectRecord;
  /** True when an account already holds this email. Unreadable counts as taken (the claim is then simply not stored). */
  emailTaken?: (db: SupabaseClient, email: string) => Promise<boolean>;
  sendEmailProof?: typeof startEmailProof;
  setPassword?: (db: SupabaseClient, userId: string, password: string) => Promise<boolean>;
  now?: () => Date;
};

export type CompletePersonalAccountResult =
  | {
      ok: true;
      userId: string;
      created: boolean;
      session: { access_token: string; refresh_token: string } | null;
      /** The conversation. */
      nextPath: string;
      /** Where the asked-about home continues (its application), re-derived from the link, or null. */
      propertyPath: string | null;
    }
  | { ok: false; status: 400 | 404 | 409 | 503; error: string };

const SIGN_IN = "Sign in to continue.";
const TRY_AGAIN = "We could not finish that just now. Try again in a moment.";

/**
 * Finish a personal account link. Possession of the link is the proof of the phone (it only ever reaches a phone that
 * proved itself: the listing-message code step shows it in the browser, a text sends it to the number), so there is no
 * second code. In order:
 *
 *  1. the link is spent atomically (`used_at is null` -> now) BEFORE anything is created, so two simultaneous submits
 *     cannot both win and a replay reads as expired; a refusal or crash before the account exists gives it back;
 *  2. the account for this phone: none yet -> `provisionSmsSignupAccount` (a phone-only resident login, the typed email
 *     stays an unverified claim and is never the login); exactly one existing account whose credentials are no
 *     stronger than a phone -> that one (the same `smsProvenSessionAllowed` rule every phone-proven session asks);
 *     anything else -> refused with the ordinary sign-in, saying nothing about why;
 *  3. `linkAccountToProspectRecord` connects the account to the conversation and the home. It refuses on its own
 *     unless the phone is verified and owned by exactly this account, and its failure never undoes the account;
 *  4. a session is minted where a phone proof is enough.
 */
export async function completePersonalAccount(
  db: SupabaseClient,
  input: { link: PhoneBoundLink; body: unknown },
  deps: PersonalAccountDeps = {},
): Promise<CompletePersonalAccountResult> {
  const now = (deps.now ?? (() => new Date()))();
  const claimed = await claimLink(db, input.link.id, now);
  if (!claimed) return { ok: false, status: 404, error: "This link has expired." };
  let finished = false;
  try {
    const result = await finish(db, input, deps);
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

async function mintSessionFor(db: SupabaseClient, userId: string) {
  const { data, error } = await db.auth.admin.getUserById(userId);
  if (error || !data.user) return null;
  return mintPhoneSession(db, data.user);
}

async function finish(
  db: SupabaseClient,
  input: { link: PhoneBoundLink; body: unknown },
  deps: PersonalAccountDeps,
): Promise<CompletePersonalAccountResult> {
  const opened = await (deps.open ?? openPersonalAccountLink)(db, input.link);
  if (!opened.ok) return { ok: false, status: 404, error: "This link has expired." };
  const checked = validatePersonalAccountInput(input.body);
  if (!checked.ok) return { ok: false, status: 400, error: checked.error };
  const form = checked.value;
  const phone = normalizeE164(input.link.phoneKey);
  if (!phone) return { ok: false, status: 404, error: "This link has expired." };

  const owners = await (deps.findOwners ?? phoneOwners)(db, phone).catch(() => null);
  if (owners === null) return { ok: false, status: 503, error: TRY_AGAIN };
  const sessionAllowed = deps.sessionAllowed ?? smsProvenSessionAllowed;

  let userId: string | null = null;
  let created = false;
  let claim = "";
  if (owners.length === 0) {
    // An email another account already holds is never stored as a claim here, and nothing in the answer differs:
    // the person is not told whether it was taken (no existence oracle). The phone proof is what makes the account.
    const emailTaken = deps.emailTaken ?? defaultEmailTaken;
    claim = form.email && !(await emailTaken(db, form.email).catch(() => true)) ? form.email : "";
    const provisioned = await (deps.provision ?? provisionSmsSignupAccount)(db, {
      phoneE164: phone,
      role: "resident",
      answers: { fullName: form.fullName, ...(claim ? { email: claim } : {}), ...(opened.prefill.houseLabel ? { home: opened.prefill.houseLabel } : {}) },
    });
    if (provisioned.ok) {
      userId = provisioned.userId;
      created = true;
    } else if (provisioned.reason === "exists" && provisioned.existingUserId) {
      userId = provisioned.existingUserId;
    } else {
      return { ok: false, status: 503, error: TRY_AGAIN };
    }
  } else if (owners.length === 1) {
    userId = owners[0]!;
  } else {
    return { ok: false, status: 409, error: SIGN_IN };
  }
  if (!created && !(await sessionAllowed(db, userId).catch(() => false))) return { ok: false, status: 409, error: SIGN_IN };

  // A password is set on a NEW account only: a link never changes an existing account's credentials. It becomes usable
  // as a login once the email claim is proven by the emailed single-use proof (the login stays the phone until then).
  if (created && form.password) {
    const ok = await (deps.setPassword ?? defaultSetPassword)(db, userId, form.password).catch(() => false);
    if (!ok) console.error("[personal-link] could not set the password");
  }

  // Prove the claimed email by its own emailed proof link (our own hashed single-use token; nothing is confirmed here).
  // Best effort and silent: a taken email or a failed send changes nothing the person sees.
  if (created && claim) {
    await (deps.sendEmailProof ?? startEmailProof)(db, { userId, email: claim }, { emailTaken: deps.emailTaken ?? defaultEmailTaken }).catch(() => false);
  }

  // The asked-about home rides the account as a starting point for Applications (never a binding to the home).
  if (created && opened.propertyId) {
    await db.auth.admin
      .getUserById(userId)
      .then(async ({ data }) => {
        const meta = (data.user?.user_metadata ?? {}) as Record<string, unknown>;
        await db.auth.admin.updateUserById(userId!, { user_metadata: { ...meta, prospect_property_id: opened.propertyId } });
      })
      .catch(() => undefined);
  }

  // Connect the account to its history. Idempotent, and a failure leaves the (valid) account in place.
  try {
    await (deps.link ?? linkAccountToProspectRecord)(db, { userId, phoneE164: phone });
  } catch (error) {
    console.error("[personal-link] could not link the account to its history", error instanceof Error ? error.name : "unknown");
  }

  let session: { access_token: string; refresh_token: string } | null = null;
  try {
    if (created || (await sessionAllowed(db, userId))) {
      session = deps.mintSession ? await deps.mintSession(db, userId) : await mintSessionFor(db, userId);
    }
  } catch {
    session = null;
  }
  return {
    ok: true,
    userId,
    created,
    session,
    nextPath: PERSONAL_LINK_LANDING_PATH,
    propertyPath: opened.propertyId ? residentPortalApplyReturnPath({ propertyId: opened.propertyId }) : null,
  };
}
