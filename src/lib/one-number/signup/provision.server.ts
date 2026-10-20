import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { track } from "@/lib/analytics/posthog";
import { ensureFreeManagerPortalAccess } from "@/lib/auth/manager-portal-provision";
import { phoneBrowserHash, phoneOwners } from "@/lib/auth/phone-auth.server";
import { provisionResidentAccountByEmail } from "@/lib/auth/provision-resident-account";
import { provisionVendorAccountByEmail } from "@/lib/auth/provision-vendor-account";
import type { SignupAnswers } from "@/lib/one-number/signup/state.server";
import type { SignupRole } from "@/lib/one-number/signup/intent";
import { tradeLabelFor } from "@/lib/one-number/vendor-jobs/intent";
import { VENDOR_TRADE_OPTIONS } from "@/lib/work-order-taxonomy";

/**
 * Create the account for a phone that PROVED itself (it texted back the code we texted it; see flow.server.ts). The
 * account is the same one the website makes, through the same provisioning:
 *
 *   manager   `ensureFreeManagerPortalAccess` (the create-account path): profile + manager role + the default workspace
 *             on the Free plan. The business name renames that default workspace.
 *   vendor    `provisionVendorAccountByEmail` (vendor-register): profile + vendor role, then the vendor business record
 *             (trade, area) the web form collects.
 *   resident  `provisionResidentAccountByEmail` with `emailProven: false`: resident role, NO workspace binding; the
 *             manager invites or confirms them into a home.
 *
 * The phone is bound by the SAME `phone_auth_bind` the phone sign-in uses (a phone-only Auth user with a random
 * non-deliverable `@phone.proplane.invalid` login, `profiles.phone` + `phone_verified_at`, the `sms_phone_contacts`
 * binding and the Auth phone identity, in one transaction), under the same phone lease. The typed email is a CLAIM: it
 * is kept as `user_metadata.unverified_email` and is never the login, `profiles.email`, or an inheritance key.
 */

export type SmsSignupInput = {
  phoneE164: string;
  role: SignupRole;
  answers: SignupAnswers;
  /** A pending vendor lead for this phone, to link to the new account. */
  vendorLeadPhoneKey?: string;
};

export type SmsSignupResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; reason: "exists" | "unavailable"; existingUserId?: string | null };

const PLACEHOLDER_DOMAIN = "phone.proplane.invalid";

type Db = SupabaseClient;

async function deleteQuietly(db: Db, userId: string): Promise<void> {
  await db.auth.admin.deleteUser(userId).then(() => undefined, () => undefined);
}

/** A phone-only Auth user with the phone already confirmed (the sole confirmation path `guard_auth_phone_change` allows). */
async function createPhoneOnlyUser(db: Db, phone: string, fullName: string, email: string | undefined): Promise<User | null> {
  const { data, error } = await db.auth.admin.createUser({
    phone,
    phone_confirm: true,
    email: `${randomUUID()}@${PLACEHOLDER_DOMAIN}`,
    email_confirm: true,
    app_metadata: { phone_only: true },
    user_metadata: { full_name: fullName, signup_source: "sms", ...(email ? { unverified_email: email } : {}) },
  });
  return error || !data.user ? null : data.user;
}

async function bindVerifiedPhone(db: Db, input: { phone: string; userId: string; operation: string }): Promise<boolean> {
  // The proof is the echoed code on the sms_signup challenge; `phone_auth_bind` needs its own verified challenge row,
  // so one is written from that proof and removed again (it must not eat the phone's hourly send allowance).
  const challengeId = randomUUID();
  const browser = randomBytes(32).toString("base64url");
  const phoneKey = input.phone.replace(/\D/g, "").slice(-10);
  const now = new Date();
  const inserted = await db.from("phone_otp_challenges").insert({
    id: challengeId,
    phone_key: phoneKey,
    purpose: "sign_in",
    subject_id: null,
    auth_user_id: input.userId,
    phone_e164: input.phone,
    browser_hash: phoneBrowserHash(browser),
    code_hash: createHash("sha256").update(`sms-signup-echo:${challengeId}`).digest("hex"),
    auth_provider: "local",
    attempts: 1,
    verified_at: now.toISOString(),
    delivered_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
  });
  if (inserted.error) return false;
  try {
    const claimed = await db.rpc("phone_auth_claim_operation", { p_operation: input.operation, p_phone: input.phone, p_user: input.userId });
    if (claimed.error || claimed.data !== true) return false;
    const bound = await db.rpc("phone_auth_bind", {
      p_id: challengeId,
      p_user: input.userId,
      p_browser_hash: phoneBrowserHash(browser),
      p_old_id: null,
      p_operation: input.operation,
    });
    return !bound.error && bound.data === true;
  } finally {
    await db.from("phone_otp_challenges").delete().eq("id", challengeId).then(() => undefined, () => undefined);
  }
}

async function provisionManager(db: Db, user: User, answers: SignupAnswers): Promise<boolean> {
  // Free plan: nothing here starts a paid trial, a number or a subscription.
  const access = await ensureFreeManagerPortalAccess(db, user, { trialForNewManager: false, allowResidentUpgrade: true });
  if (access.status !== "portal_ready") return false;
  const name = answers.businessName?.trim();
  if (name) {
    const ensured = await db.rpc("ensure_default_portal_workspace", { p_owner: user.id });
    const workspaceId = typeof ensured.data === "string" ? ensured.data : null;
    if (workspaceId) {
      // Only the untouched default name is replaced.
      await db.from("portal_workspaces").update({ name: name.slice(0, 80) }).eq("id", workspaceId).eq("owner_user_id", user.id).eq("name", "My workspace");
    }
  }
  // A manager is not a resident: drop the default role bind wrote (the website path never adds it).
  await db.from("profile_roles").delete().eq("user_id", user.id).eq("role", "resident");
  return true;
}

async function provisionVendor(db: Db, user: User, answers: SignupAnswers, leadPhoneKey: string | undefined): Promise<boolean> {
  // `profiles.role` is the legacy primary role: bind wrote 'resident', so the vendor role must lead before provisioning.
  await db.from("profiles").update({ role: "vendor" }).eq("id", user.id);
  const provisioned = await provisionVendorAccountByEmail(db, {
    userId: user.id,
    email: user.email ?? "",
    fullName: answers.fullName ?? null,
    invite: null,
    confirmEmail: true,
  });
  if (!provisioned.ok) return false;
  const label = tradeLabelFor(answers.trade ?? null);
  const trades = label && label !== "Other" && (VENDOR_TRADE_OPTIONS as readonly string[]).includes(label) ? [label] : [];
  const zips = (answers.area ?? "").match(/\b\d{5}\b/g) ?? [];
  await db.from("vendor_business_profiles").upsert(
    {
      user_id: user.id,
      contact_name: answers.fullName ?? "",
      service_area: (answers.area ?? "").slice(0, 120),
      ...(trades.length ? { trades } : {}),
      ...(zips.length ? { service_area_zips: [...new Set(zips)].slice(0, 12) } : {}),
    },
    { onConflict: "user_id" },
  );
  if (leadPhoneKey) {
    await db.from("sms_vendor_leads").update({ user_id: user.id, updated_at: new Date().toISOString() }).eq("phone_key", leadPhoneKey).is("user_id", null).then(() => undefined, () => undefined);
  }
  // The vendor is not a resident: drop the default role bind wrote.
  await db.from("profile_roles").delete().eq("user_id", user.id).eq("role", "resident");
  return true;
}

async function provisionResident(db: Db, user: User, phone: string, answers: SignupAnswers): Promise<boolean> {
  const provisioned = await provisionResidentAccountByEmail(db, {
    userId: user.id,
    email: user.email ?? "",
    fullName: answers.fullName ?? null,
    phone,
    inheritFromApplication: false,
    emailProven: false,
  });
  if (!provisioned.ok) return false;
  if (answers.home) {
    // Where they said they live is a hint for support, never a binding to any home or workspace.
    await db.auth.admin.updateUserById(user.id, { user_metadata: { ...(user.user_metadata ?? {}), sms_signup_home: answers.home.slice(0, 80) } }).then(() => undefined, () => undefined);
  }
  return true;
}

export async function provisionSmsSignupAccount(db: Db, input: SmsSignupInput): Promise<SmsSignupResult> {
  const fullName = input.answers.fullName?.trim();
  if (!fullName) return { ok: false, reason: "unavailable" };
  const operation = randomUUID();
  let createdId: string | null = null;
  try {
    const claimed = await db.rpc("phone_auth_claim_operation", { p_operation: operation, p_phone: input.phoneE164, p_user: null });
    if (claimed.error || claimed.data !== true) return { ok: false, reason: "unavailable" };

    // One phone, one account: a verified owner anywhere (profile, Auth phone, texter contact) means no second account.
    const owners = await phoneOwners(db, input.phoneE164);
    if (owners.length > 0) return { ok: false, reason: "exists", existingUserId: owners.length === 1 ? owners[0]! : null };

    const created = await createPhoneOnlyUser(db, input.phoneE164, fullName, input.answers.email);
    if (!created) {
      const again = await phoneOwners(db, input.phoneE164).catch(() => []);
      return again.length > 0 ? { ok: false, reason: "exists", existingUserId: again.length === 1 ? again[0]! : null } : { ok: false, reason: "unavailable" };
    }
    createdId = created.id;

    if (!(await bindVerifiedPhone(db, { phone: input.phoneE164, userId: created.id, operation }))) {
      await deleteQuietly(db, created.id);
      return { ok: false, reason: "unavailable" };
    }
    const fresh = (await db.auth.admin.getUserById(created.id)).data.user ?? created;
    let ok = false;
    if (input.role === "manager") ok = await provisionManager(db, fresh, input.answers);
    else if (input.role === "vendor") ok = await provisionVendor(db, fresh, input.answers, input.vendorLeadPhoneKey);
    else ok = await provisionResident(db, fresh, input.phoneE164, input.answers);
    if (!ok) {
      await deleteQuietly(db, created.id);
      createdId = null;
      return { ok: false, reason: "unavailable" };
    }
    track(`${input.role}_account_created`, created.id, { signup_method: "sms" });
    return { ok: true, userId: created.id, email: fresh.email ?? "" };
  } catch (error) {
    console.error("sms signup provisioning failed", error instanceof Error ? error.name : "unknown");
    if (createdId) await deleteQuietly(db, createdId);
    return { ok: false, reason: "unavailable" };
  } finally {
    await db.rpc("phone_auth_release_operation", { p_operation: operation }).then(() => undefined, () => undefined);
  }
}
