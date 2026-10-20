import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isPrimaryAdminEmail } from "@/lib/auth/primary-admin";

/**
 * The ONE rule for when possession of a phone (an inbound text, or a one-time code texted to it) may open a session.
 *
 * A phone proves only that someone holds the SIM or can spoof the sender, which is a weaker proof than an email
 * sign-in. So a session minted on SMS proof alone is allowed only for an account where that proof is not weaker than
 * the account's own credentials:
 *
 *   - never an admin (an `admin` role anywhere, the legacy `profiles.role`, or the primary admin email);
 *   - an accepted team seat (`account_link_invites`, any `team_role` but `property_owner`) counts as a manager-side role,
 *     so a teammate whose `profile_roles` only says resident is not mistaken for a resident;
 *   - and either every role the account holds is resident and/or vendor (the portals a phone already reaches by
 *     design), or the phone is the account's ONLY proven credential (a manager account made by SMS sign-up has a
 *     placeholder login, no real email, no OAuth identity).
 *
 * Anything else, or any read that fails, is refused: the caller sends the person to the ordinary sign-in.
 * `src/lib/one-number/link-portal-session.server.ts` and `src/lib/one-number/signup/sign-in-link.server.ts` both ask.
 *
 * DOCUMENTED EXCEPTION: a signed-out phone-code sign-in (`verifyPhoneChallenge` in `phone-auth.server.ts`) is the
 * captain's phone-first direction, so it stays open for every NON-ADMIN account (a verified one-time code is a
 * stronger proof than an inbound text's sender id). It asks `phoneCodeSignInAllowed`, which refuses only an admin
 * (or an unreadable account): an admin must use their normal login.
 */

const PLACEHOLDER_DOMAIN = "phone.proplane.invalid";
const PHONE_REACHABLE_ROLES = new Set(["resident", "vendor"]);
const PHONE_ONLY_PROVIDERS = new Set(["phone", "email"]);

export type SmsSessionVerdict =
  | { ok: true; reason: "resident_vendor_only" | "phone_only_credential" }
  | { ok: false; reason: "admin" | "other_credential" | "unreadable" };

function isPlaceholderEmail(email: string | null | undefined): boolean {
  const value = String(email ?? "").trim().toLowerCase();
  return value === "" || value.endsWith(`@${PLACEHOLDER_DOMAIN}`);
}

type AuthIdentityLike = { provider?: unknown; identity_data?: { email?: unknown } | null };

/** True when the auth user can prove itself some way other than the phone: a real email login or an OAuth identity. */
function hasNonPhoneCredential(user: {
  email?: string | null;
  identities?: AuthIdentityLike[] | null;
  app_metadata?: Record<string, unknown> | null;
}): boolean {
  if (!isPlaceholderEmail(user.email)) return true;
  for (const identity of user.identities ?? []) {
    const provider = String(identity?.provider ?? "").toLowerCase();
    if (!PHONE_ONLY_PROVIDERS.has(provider)) return true;
    if (provider === "email" && !isPlaceholderEmail(typeof identity?.identity_data?.email === "string" ? identity.identity_data.email : null)) return true;
  }
  const providers = user.app_metadata?.providers;
  if (Array.isArray(providers) && providers.some((p) => !PHONE_ONLY_PROVIDERS.has(String(p).toLowerCase()))) return true;
  const provider = user.app_metadata?.provider;
  if (typeof provider === "string" && provider && !PHONE_ONLY_PROVIDERS.has(provider.toLowerCase())) return true;
  return false;
}

export async function smsProvenSessionVerdict(db: SupabaseClient, userId: string): Promise<SmsSessionVerdict> {
  try {
    const id = String(userId ?? "").trim();
    if (!id) return { ok: false, reason: "unreadable" };
    const [rolesRead, profileRead, authRead, seatsRead] = await Promise.all([
      db.from("profile_roles").select("role").eq("user_id", id),
      db.from("profiles").select("role, email").eq("id", id).maybeSingle(),
      db.auth.admin.getUserById(id),
      // An accepted team seat (co-manager, assistant, ...) is a manager-side account whatever `profile_roles` says: not every
      // accept path stamps the `manager` role, so a teammate could otherwise read as resident-only.
      db.from("account_link_invites").select("team_role").eq("invitee_user_id", id).eq("status", "accepted"),
    ]);
    if (rolesRead.error || profileRead.error || authRead.error || seatsRead.error || !authRead.data?.user) return { ok: false, reason: "unreadable" };
    const roles = new Set<string>();
    for (const row of (rolesRead.data ?? []) as Array<{ role?: unknown }>) {
      const role = String(row.role ?? "").trim().toLowerCase();
      if (role) roles.add(role);
    }
    // `property_owner` is a team role that is not a portal; every other accepted seat counts as a manager-side role.
    for (const seat of (seatsRead.data ?? []) as Array<{ team_role?: unknown }>) {
      if (String(seat.team_role ?? "").trim().toLowerCase() !== "property_owner") roles.add("manager");
    }
    const profile = (profileRead.data ?? null) as { role?: unknown; email?: unknown } | null;
    const legacy = String(profile?.role ?? "").trim().toLowerCase();
    if (legacy) roles.add(legacy);
    const user = authRead.data.user;

    if (roles.has("admin") || isPrimaryAdminEmail(user.email) || isPrimaryAdminEmail(typeof profile?.email === "string" ? profile.email : null)) {
      return { ok: false, reason: "admin" };
    }
    if (roles.size > 0 && [...roles].every((role) => PHONE_REACHABLE_ROLES.has(role))) return { ok: true, reason: "resident_vendor_only" };
    if (!hasNonPhoneCredential(user as Parameters<typeof hasNonPhoneCredential>[0])) return { ok: true, reason: "phone_only_credential" };
    return { ok: false, reason: "other_credential" };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

export async function smsProvenSessionAllowed(db: SupabaseClient, userId: string): Promise<boolean> {
  return (await smsProvenSessionVerdict(db, userId)).ok;
}

/**
 * Signed-out phone-code sign-in: open for every non-admin account (the documented exception above). Fails closed
 * when the account cannot be read.
 */
export async function phoneCodeSignInAllowed(db: SupabaseClient, userId: string): Promise<boolean> {
  const verdict = await smsProvenSessionVerdict(db, userId);
  if (verdict.ok) return true;
  return verdict.reason === "other_credential";
}
