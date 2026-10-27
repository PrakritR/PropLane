import "server-only";

import { createHash, createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { SHARED_LINE_OTP_RULES } from "@/lib/one-number/contracts";
import { loadSharedLineConfig } from "@/lib/one-number/config.server";
import { isAllowedPhoneAuthDestination, normalizeE164 } from "@/lib/phone-e164";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { phoneAuthHookEnabled } from "@/lib/auth/phone-hook-flag";
import { sendPhoneAuthCode } from "@/lib/auth/phone-otp-delivery.server";
import { phoneCodeSignInAllowed, phoneCodeSignInDecision } from "@/lib/auth/sms-proven-session.server";
import { writeAuditLog } from "@/lib/tools/audit";
import { isAdminAccount, loadPhoneRequired, phoneSkipActive, PhoneSendFailedError } from "@/lib/auth/phone-required.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { PhoneOwnFlowError } from "@/lib/auth/phone-own-errors";
import { PhoneAuthError, type PhoneAuthErrorKind } from "@/lib/auth/phone-auth-errors";

export const PHONE_AUTH_ERROR = "We couldn't verify this number. Try again or contact your manager.";
export const PHONE_BROWSER_COOKIE = "proplane_phone_browser";
export const PHONE_OLD_COOKIE = "proplane_phone_old";
/**
 * `verify_own_phone` is the Settings > Profile "Verify" flow: a SIGNED-IN person proving the number already saved on
 * their own profile. It works whatever the rollout switches say (see `startPhoneChallenge`); every other purpose keeps
 * its switch behaviour.
 */
export type PhonePurpose = "sign_in" | "verify_phone" | "verify_own_phone" | "change_number_old" | "change_number_new";
export type PhoneProof = { id: string; phone: string; purpose: string; provider: "local" | "supabase" };

export function phoneCodeHash(id: string, code: string): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error(PHONE_AUTH_ERROR);
  // A database read alone cannot brute-force six digits. Each code is bound to
  // its random challenge; the HMAC key never enters the database or browser.
  return createHmac("sha256", secret).update(`phone-auth:${id}:${code}`).digest("hex");
}

export function phoneBrowserHash(browser: string): string {
  return createHash("sha256").update(browser).digest("hex");
}

export function newPhoneBrowserSecret(): string {
  return randomBytes(32).toString("base64url");
}

export async function phoneAuthEnabled(db = createSupabaseServiceRoleClient()): Promise<boolean> {
  return (await loadSharedLineConfig(db)).mode === "shared";
}

export async function readPhoneIdentity(db: SupabaseClient, userId: string) {
  const { data, error } = await db.from("profiles").select("phone, phone_verified_at").eq("id", userId).maybeSingle();
  if (error) throw new Error(PHONE_AUTH_ERROR);
  const phone = normalizeE164(data?.phone);
  if (phone && data?.phone_verified_at) return { phone, verified: true };
  const auth = await db.auth.admin.getUserById(userId);
  if (auth.error || !auth.data.user) throw new Error(PHONE_AUTH_ERROR);
  const authPhone = auth.data.user.phone ? normalizeE164(`+${auth.data.user.phone.replace(/^\+/, "")}`) : null;
  if (authPhone && auth.data.user.phone_confirmed_at) return { phone: authPhone, verified: true };
  // Not verified: show the number typed at signup (auth metadata, since a roleless login has no profile row yet) so the
  // verify screen is prefilled. It proves nothing - only the code does - and nothing else here reads an unverified phone.
  const typedAtSignup = normalizeE164(typeof auth.data.user.user_metadata?.phone === "string" ? auth.data.user.user_metadata.phone : "");
  return { phone: phone ?? typedAtSignup, verified: false };
}

/**
 * Phone verification (codes for a SIGNED-IN account) is available on the shared line AND whenever `phone_required` is
 * on. Phone SIGN-IN (a code to someone with no session) stays shared-line only (`phoneAuthEnabled`).
 */
export async function phoneVerificationEnabled(db = createSupabaseServiceRoleClient()): Promise<boolean> {
  return (await phoneAuthEnabled(db)) || (await loadPhoneRequired(db));
}

/**
 * Must this account verify a phone before it enters a portal?
 *  - Shared mode: always, until verified (the older gate, unchanged).
 *  - Otherwise only when `sms_runtime_config.phone_required` is on, for any account (email, Google, Apple) without a
 *    verified phone, except admins, and except an account that skipped the step on its CURRENT sign-in because a code
 *    could not be sent (`phoneSkipActive`). View-as sessions are exempted by the caller.
 * Nothing new is read when both switches are off.
 */
export async function needsPhoneVerification(userId: string, db = createSupabaseServiceRoleClient()): Promise<boolean> {
  if (await phoneAuthEnabled(db)) return !(await readPhoneIdentity(db, userId)).verified;
  if (!(await loadPhoneRequired(db))) return false;
  if (await isAdminAccount(db, userId)) return false;
  let verified = false;
  try {
    verified = (await readPhoneIdentity(db, userId)).verified;
  } catch {
    // Cannot read the phone state: never lock an account out over it.
    return false;
  }
  if (verified) return false;
  return !(await phoneSkipActive(db, userId));
}

export async function phoneOwners(db: SupabaseClient, phone: string): Promise<string[]> {
  const { data, error } = await db.rpc("phone_auth_owners", { p_phone: phone });
  if (error || !Array.isArray(data)) throw new Error(PHONE_AUTH_ERROR);
  return data.filter((id): id is string => typeof id === "string");
}

/** Isolated auth client: verification cannot install cookies before identity checks. */
function isolatedAuth() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error(PHONE_AUTH_ERROR);
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

export async function startPhoneChallenge(input: {
  db: SupabaseClient; userId: string | null; browser: string; phone: unknown; purpose: PhonePurpose;
}) {
  const { db, userId, browser, purpose } = input;
  const ownPhone = purpose === "verify_own_phone";
  // Only the signed-out sign-in door names a failure (see `phone-auth-errors.ts`); every other purpose keeps the one
  // deliberately generic message.
  const refuse = (kind: PhoneAuthErrorKind) => (purpose === "sign_in" ? new PhoneAuthError(kind, PHONE_AUTH_ERROR) : new Error(PHONE_AUTH_ERROR));
  // Sign-in by phone is shared-line only; verifying or changing a SIGNED-IN account's phone also works when phone_required is on.
  // The Settings "Verify" flow (own phone, signed in) is the one door that does not wait for either switch.
  if (!ownPhone && (purpose === "sign_in" || !(await phoneVerificationEnabled(db)))) {
    if (!(await phoneAuthEnabled(db))) throw refuse("off");
  }
  if (purpose !== "sign_in" && !userId) throw new Error(PHONE_AUTH_ERROR);
  const current = userId ? await readPhoneIdentity(db, userId) : null;
  // Own-phone flow: the number is the one saved on the session user's profile, never one named in the request.
  const phone = purpose === "change_number_old" || ownPhone ? current?.phone : normalizeE164(input.phone);
  if (!phone || !/^\+[1-9]\d{7,14}$/.test(phone)) throw refuse("bad_number");
  // SMS pumping guard: texts go only to allowed countries (+1 by default), before any send budget. Both answers depend
  // on the typed number alone, never on who owns it.
  if (!isAllowedPhoneAuthDestination(phone)) throw refuse(phone.startsWith("+1") ? "bad_number" : "not_us");
  if (purpose === "change_number_old" && !current?.verified) throw new Error(PHONE_AUTH_ERROR);
  if (ownPhone) {
    if (current?.verified) throw new Error(PHONE_AUTH_ERROR);
    // A number verified (or bound) on another account is refused before any text is sent; it never moves silently.
    if ((await phoneOwners(db, phone)).some((id) => id !== userId)) throw new PhoneOwnFlowError("taken");
  }
  if (purpose === "verify_phone" && current?.verified && current.phone !== phone) throw new Error(PHONE_AUTH_ERROR);
  if (purpose === "change_number_new" && (!current?.verified || current.phone === phone)) throw new Error(PHONE_AUTH_ERROR);

  const id = randomUUID();
  const code = String(randomInt(10 ** SHARED_LINE_OTP_RULES.codeLength)).padStart(SHARED_LINE_OTP_RULES.codeLength, "0");
  let provider: "local" | "supabase" = "local";
  // Hosted SMS is opt-in, never inferred from a secret alone. Only an already
  // canonical Auth phone uses it: creating an Auth phone account before checking
  // legacy profile identity would duplicate existing email/social accounts.
  if (purpose === "sign_in" && phoneAuthHookEnabled()) {
    const owners = await phoneOwners(db, phone);
    if (owners.length === 1) {
      const { data, error } = await db.auth.admin.getUserById(owners[0]);
      // Hosted verify would mint the session inside GoTrue, past `phoneCodeSignInAllowed` in `verifyPhoneChallenge`;
      // an account that may not sign in by code (an unreadable one) stays on the local path, where that check runs.
      if (
        !error && data.user.phone_confirmed_at && data.user.phone &&
        normalizeE164(`+${data.user.phone.replace(/^\+/, "")}`) === phone &&
        (await phoneCodeSignInAllowed(db, owners[0]))
      ) provider = "supabase";
    }
  }
  const actor = purpose === "sign_in" ? null : userId;
  const { data, error } = await db.rpc("phone_auth_start", {
    p_id: id, p_phone: phone, p_phone_key: normalizeConsentPhone(phone),
    p_purpose: purpose === "verify_phone" || ownPhone ? "sign_in" : purpose,
    p_user: actor, p_browser_hash: phoneBrowserHash(browser), p_code_hash: phoneCodeHash(id, code), p_provider: provider,
  });
  if (error || data !== true) throw new Error(PHONE_AUTH_ERROR);
  const sent = provider === "supabase"
    ? !(await isolatedAuth().auth.signInWithOtp({ phone, options: { shouldCreateUser: false } })).error
    : await sendPhoneAuthCode(phone, code, actor ?? undefined);
  if (!sent) {
    // Retain the row for the rolling send cap, but no delivered proof exists.
    await db.from("phone_otp_challenges").update({ consumed_at: new Date().toISOString() }).eq("id", id);
    throw new PhoneSendFailedError(PHONE_AUTH_ERROR);
  }
  return { challengeId: id };
}

async function resolvePhoneUser(db: SupabaseClient, phone: string): Promise<{ user: User; created: boolean }> {
  let owners = await phoneOwners(db, phone);
  if (owners.length > 1) throw new Error(PHONE_AUTH_ERROR);
  if (!owners.length) {
    // Random non-deliverable address, never derived from a number. Supabase's
    // admin magic-link session API requires an email; this is not a new inbox.
    // Auth's unique phone constraint arbitrates concurrent successful sign-ins.
    const { data, error } = await db.auth.admin.createUser({
      phone, phone_confirm: true, email: `${randomUUID()}@phone.proplane.invalid`, email_confirm: true,
      app_metadata: { phone_only: true },
    });
    if (!error && data.user) return { user: data.user, created: true };
    owners = await phoneOwners(db, phone);
    if (owners.length !== 1) throw new Error(PHONE_AUTH_ERROR);
  }
  const { data, error } = await db.auth.admin.getUserById(owners[0]);
  if (error || !data.user) throw new Error(PHONE_AUTH_ERROR);
  return { user: data.user, created: false };
}

export async function mintPhoneSession(db: SupabaseClient, user: User) {
  let canonical = user;
  if (!canonical.email) {
    const { data, error } = await db.auth.admin.updateUserById(user.id, {
      email: `${randomUUID()}@phone.proplane.invalid`, email_confirm: true,
      app_metadata: { ...user.app_metadata, phone_only: true },
    });
    if (error || !data.user?.email) throw new Error(PHONE_AUTH_ERROR);
    canonical = data.user;
  }
  const { data: link, error } = await db.auth.admin.generateLink({ type: "magiclink", email: canonical.email! });
  if (error || link?.user?.id !== user.id || !link.properties?.hashed_token) throw new Error(PHONE_AUTH_ERROR);
  const { data, error: verifyError } = await isolatedAuth().auth.verifyOtp({ token_hash: link.properties.hashed_token, type: "email" });
  if (verifyError || !data.session || data.user?.id !== user.id) throw new Error(PHONE_AUTH_ERROR);
  return { access_token: data.session.access_token, refresh_token: data.session.refresh_token };
}

export const ADMIN_PHONE_CODE_SIGN_IN_AUDIT_ACTION = "admin_phone_code_sign_in";

/**
 * A texted code may open an ADMIN session (the captain's Oct 26 decision), so that door leaves the same kind of trail
 * every other admin-privilege door does. Written before the bind, scoped to the admin's own account, and best-effort:
 * the code was already proven, so a failed insert is logged rather than locking the account out of its own sign-in.
 * Ids and enums only, never the number itself.
 */
async function recordAdminPhoneCodeSignIn(db: SupabaseClient, userId: string, provider: "local" | "supabase") {
  try {
    const outcome = await writeAuditLog({ db, landlordId: userId, userId }, {
      action: ADMIN_PHONE_CODE_SIGN_IN_AUDIT_ACTION,
      toolName: ADMIN_PHONE_CODE_SIGN_IN_AUDIT_ACTION,
      inputSummary: { purpose: "sign_in", provider, accountUserId: userId },
      resultSummary: { allowed: true },
    });
    if (!outcome.recorded) console.error("phone-auth: admin phone-code sign-in not audited", outcome);
  } catch (error) {
    console.error("phone-auth: admin phone-code sign-in audit failed", error);
  }
}

/**
 * Own-phone verification finishes only a live sign_in-shaped challenge, for THIS user, aimed at the number now saved on
 * their profile. A spent, expired or exhausted challenge is "expired" (send a new one); anything else is refused generically.
 */
async function assertOwnPhoneChallenge(db: SupabaseClient, challengeId: string, userId: string) {
  const { data, error } = await db.from("phone_otp_challenges")
    .select("purpose, phone_e164, expires_at, consumed_at, attempts").eq("id", challengeId).maybeSingle();
  if (error || !data || data.purpose !== "sign_in") throw new Error(PHONE_AUTH_ERROR);
  const saved = await readPhoneIdentity(db, userId);
  if (!saved.phone || saved.phone !== data.phone_e164) throw new Error(PHONE_AUTH_ERROR);
  const expired = data.consumed_at || new Date(String(data.expires_at)).getTime() <= Date.now() || Number(data.attempts) >= 5;
  if (expired) throw new PhoneOwnFlowError("expired");
}

/**
 * Why `phone_auth_consume` refused a sign-in code, using only this browser's own challenge row: spent / past its ten
 * minutes / out of tries is `expired`, otherwise `wrong_code`. The per-number lockout refuses even a right code with the
 * same null, so a locked number (or an unreadable count) must NOT read as a wrong code: it stays `generic`.
 */
export async function classifyRefusedCode(db: SupabaseClient, challengeId: string): Promise<PhoneAuthErrorKind> {
  try {
    const { data, error } = await db.from("phone_otp_challenges")
      .select("phone_key, purpose, expires_at, consumed_at, attempts").eq("id", challengeId).maybeSingle();
    if (error) return "generic";
    if (!data) return "expired";
    if (data.consumed_at || new Date(String(data.expires_at)).getTime() <= Date.now() || Number(data.attempts) >= SHARED_LINE_OTP_RULES.maxAttempts) return "expired";
    const failed = await db.rpc("phone_auth_failed_code_count", { p_phone_key: data.phone_key, p_purpose: data.purpose });
    if (failed.error || typeof failed.data !== "number" || failed.data >= 10) return "generic";
    return "wrong_code";
  } catch {
    return "generic";
  }
}

/**
 * Would a fresh sign-in code be sent right now for the number behind this browser's challenge? Counts the same rolling
 * hour the database's `phone_auth_start` enforces (per purpose, and across purposes). Fail closed: unreadable = no.
 * Read-only; it never sends and never reveals anything but this browser's own number's budget.
 */
export async function phoneResendAllowed(db: SupabaseClient, challengeId: string, browser: string): Promise<boolean> {
  try {
    // Bound to THIS browser's challenge: another browser's challenge id answers nothing about its number's budget.
    const { data, error } = await db.from("phone_otp_challenges").select("phone_key, purpose")
      .eq("id", challengeId).eq("browser_hash", phoneBrowserHash(browser)).maybeSingle();
    if (error || !data) return false;
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const [own, all] = await Promise.all([
      db.from("phone_otp_challenges").select("id", { count: "exact", head: true })
        .eq("phone_key", data.phone_key).eq("purpose", data.purpose).gt("created_at", since),
      db.from("phone_otp_challenges").select("id", { count: "exact", head: true }).eq("phone_key", data.phone_key).gt("created_at", since),
    ]);
    if (own.error || all.error || own.count === null || all.count === null) return false;
    const failed = await db.rpc("phone_auth_failed_code_count", { p_phone_key: data.phone_key, p_purpose: data.purpose });
    if (failed.error || typeof failed.data !== "number" || failed.data >= 10) return false;
    return own.count < SHARED_LINE_OTP_RULES.maxSendsPerHour && all.count < SHARED_LINE_OTP_RULES.maxSendsPerPhonePerHour;
  } catch {
    return false;
  }
}

export async function verifyPhoneChallenge(input: {
  db: SupabaseClient; userId: string | null; browser: string; challengeId: string; code: string; oldChallengeId?: string;
  /** Settings "Verify" flow: finishes only a challenge for the signed-in user's own saved phone, and answers in plain words. */
  ownPhone?: boolean;
  /** The form says this is the sign-in door. It only chooses the error wording; `actor` (from our own row) still decides everything else. */
  signIn?: boolean;
}) {
  const { db, userId, browser, challengeId, code } = input;
  const ownFlow = input.ownPhone === true;
  if (!/^[\da-f-]{36}$/i.test(challengeId)) throw new Error(PHONE_AUTH_ERROR);
  if (!/^\d{6}$/.test(code)) throw input.signIn && !ownFlow ? new PhoneAuthError("wrong_code", PHONE_AUTH_ERROR) : new Error(PHONE_AUTH_ERROR);
  // Determine the actor from our own challenge. An unauthenticated sign-in
  // remains a sign-in even if a browser already happens to have a session.
  const { data: row, error: readError } = await db.from("phone_otp_challenges").select("auth_user_id, browser_hash")
    .eq("id", challengeId).maybeSingle();
  const browserHash = phoneBrowserHash(browser);
  // A signed-out sign-in challenge that is missing or not this browser's reads the same as an expired one: the caller
  // learns nothing it did not already hold. A row that belongs to a signed-in account's flow stays generic.
  const signInDoor = input.signIn === true && !ownFlow;
  if (readError) throw new Error(PHONE_AUTH_ERROR);
  if (!row || row.browser_hash !== browserHash) throw signInDoor && !row?.auth_user_id ? new PhoneAuthError("expired", PHONE_AUTH_ERROR) : new Error(PHONE_AUTH_ERROR);
  if (row.auth_user_id && row.auth_user_id !== userId) throw new Error(PHONE_AUTH_ERROR);
  const actor = row.auth_user_id as string | null;
  const named = (kind: PhoneAuthErrorKind) => (signInDoor && !actor ? new PhoneAuthError(kind, PHONE_AUTH_ERROR) : new Error(PHONE_AUTH_ERROR));
  if (ownFlow) {
    // Signed in, and the challenge is that same user's own: never a sign-in code, never another user's.
    if (!userId || actor !== userId) throw new Error(PHONE_AUTH_ERROR);
    await assertOwnPhoneChallenge(db, challengeId, userId);
  } else if (!(await phoneAuthEnabled(db)) && !(actor && (await loadPhoneRequired(db)))) {
    // A code for someone with no session (sign-in) is shared-line only; a signed-in account's code also works under phone_required.
    throw named("off");
  }
  const { data, error } = await db.rpc("phone_auth_consume", {
    p_id: challengeId, p_user: actor, p_browser_hash: browserHash, p_code_hash: phoneCodeHash(challengeId, code),
  });
  // The challenge was live and ours (checked above), so a refusal here is the code itself.
  if (ownFlow && !error && !data) throw new PhoneOwnFlowError("wrong");
  if (!error && !data && signInDoor && !actor) throw new PhoneAuthError(await classifyRefusedCode(db, challengeId), PHONE_AUTH_ERROR);
  if (error || !data) throw new Error(PHONE_AUTH_ERROR);
  const proof = data as PhoneProof;
  let nativeUser: User | null = null;
  if (proof.provider === "supabase") {
    const verified = await isolatedAuth().auth.verifyOtp({ phone: proof.phone, token: code, type: "sms" });
    if (verified.error || !verified.data.user || !verified.data.session) throw new Error(PHONE_AUTH_ERROR);
    nativeUser = verified.data.user;
    const consumed = await db.rpc("phone_auth_complete_native", { p_id: challengeId, p_browser_hash: browserHash });
    if (consumed.error || consumed.data !== true) throw new Error(PHONE_AUTH_ERROR);
  }
  if (proof.purpose === "change_number_old") return { ok: true as const, oldNumberVerified: true as const };
  const operation = randomUUID();
  const claimed = await db.rpc("phone_auth_claim_operation", { p_operation: operation, p_phone: proof.phone, p_user: actor });
  if (claimed.error || claimed.data !== true) throw new Error(PHONE_AUTH_ERROR);
  try {
    const owners = await phoneOwners(db, proof.phone);
    if (owners.length > 1 || (actor && owners.some((id) => id !== actor))) {
      throw ownFlow ? new PhoneOwnFlowError("taken") : new Error(PHONE_AUTH_ERROR);
    }
    let user: User;
    let created = false;
    if (actor) {
      const result = await db.auth.admin.getUserById(actor);
      if (result.error || !result.data.user) throw new Error(PHONE_AUTH_ERROR);
      user = result.data.user;
    } else {
      ({ user, created } = await resolvePhoneUser(db, proof.phone));
    }
    if (nativeUser && nativeUser.id !== user.id) throw new Error(PHONE_AUTH_ERROR);
    // A signed-out code sign-in opens any readable account, admins included. Checked before the phone is bound so a
    // refused sign-in changes nothing; an admin session opened this way leaves an audit row before it is minted.
    if (!actor) {
      const decision = await phoneCodeSignInDecision(db, user.id);
      if (!decision.allowed) throw new Error(PHONE_AUTH_ERROR);
      if (decision.admin) await recordAdminPhoneCodeSignIn(db, user.id, proof.provider);
    }
    const claimedUser = await db.rpc("phone_auth_claim_operation", { p_operation: operation, p_phone: proof.phone, p_user: user.id });
    if (claimedUser.error || claimedUser.data !== true) throw new Error(PHONE_AUTH_ERROR);
    const bound = await db.rpc("phone_auth_bind", {
      p_id: challengeId, p_user: user.id, p_browser_hash: browserHash,
      p_old_id: input.oldChallengeId ?? null, p_operation: operation,
    });
    if (bound.error || bound.data !== true) throw new Error(PHONE_AUTH_ERROR);
    // The bind transaction updates Auth phone/identity and application ownership
    // together. Read back only; an external phone update would split the change.
    const updated = await db.auth.admin.getUserById(user.id);
    if (updated.error || !updated.data.user) throw new Error(PHONE_AUTH_ERROR);
    // The projection reader attaches old SMS by verified phone and workspace;
    // sms_phone_contacts is bound atomically above, without moving tenant rows.
    if (actor) return { ok: true as const };
    // `user` + `created` let the route pick the portal (or the "no account yet" screen) without another round trip.
    return { ok: true as const, session: await mintPhoneSession(db, updated.data.user), user: updated.data.user, created, phone: proof.phone };
  } finally {
    await db.rpc("phone_auth_release_operation", { p_operation: operation });
  }
}
