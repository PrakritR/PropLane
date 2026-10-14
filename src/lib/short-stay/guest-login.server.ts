import "server-only";

/**
 * A guest who books from the public listing card has no PropLane login. This makes (or finds) one,
 * keyed on the PHONE they typed, and mints a one-time sign-in link for the confirmation text.
 *
 * Why the phone is the key and the typed email is not: the link is texted to that phone, so only
 * whoever holds it can open the account. Matching on a typed email would let anyone name a victim's
 * address and their own phone and be texted a sign-in link for the victim's account. A typed email
 * that already belongs to a different account is therefore never used as the login; the new account
 * gets a placeholder login address (the same `@import.proplane.local` family a phone-only resident
 * already has) and the real email stays on the stay for the host's copy of the confirmation.
 *
 * The link is a `token_hash` that `/auth/confirm` verifies with `verifyOtp`, never a PKCE `code`
 * (a code is bound to the browser that asked, and a text is opened on a phone). The account gets the
 * `resident` role, which is what unlocks `/resident/stays`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { findAuthUserIdByEmail } from "@/lib/auth/find-auth-user-id-by-email";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { provisionResidentAccountByEmail } from "@/lib/auth/provision-resident-account";

export type GuestLogin = {
  userId: string;
  /** The address the account signs in with (real, or the phone-keyed placeholder). */
  loginEmail: string;
  created: boolean;
  /** One-time link for the guest's text, or null when it could not be minted. */
  signInUrl: string | null;
};

/** `/auth/confirm?token_hash=…&type=magiclink` - the destination is derived from `type` there. */
export function guestSignInConfirmUrl(origin: string, tokenHash: string): string {
  return `${origin.trim().replace(/\/$/, "")}/auth/confirm?token_hash=${encodeURIComponent(tokenHash)}&type=magiclink`;
}

/** The placeholder login for a guest whose typed email cannot be the login. Stable per phone. */
export function guestPlaceholderEmail(phone: string): string {
  return `guest.${phone.replace(/\D/g, "")}@import.proplane.local`;
}

async function mintSignInUrl(db: SupabaseClient, loginEmail: string): Promise<string | null> {
  const { data, error } = await db.auth.admin.generateLink({ type: "magiclink", email: loginEmail });
  const tokenHash = data?.properties?.hashed_token;
  if (error || !tokenHash) return null;
  return guestSignInConfirmUrl(resolveEmailLinkBaseUrl(), tokenHash);
}

/**
 * Finds the resident login for this phone, or creates one. Null when it cannot be done safely (two
 * accounts claim the phone, or the account service refused): the stay is still saved, the guest just
 * gets no link.
 */
export async function ensureGuestLogin(
  db: SupabaseClient,
  input: { name: string; phone: string; email: string },
): Promise<GuestLogin | null> {
  const { name, phone } = input;
  const email = input.email.trim().toLowerCase();
  if (!phone) return null;

  const { data: matches } = await db.from("profiles").select("id, email").eq("phone", phone).limit(2);
  const rows = (matches ?? []) as Array<{ id?: string; email?: string | null }>;
  if (rows.length > 1) return null;
  if (rows.length === 1) {
    const existing = rows[0]!;
    const userId = String(existing.id ?? "");
    const loginEmail = String(existing.email ?? "").trim().toLowerCase();
    if (!userId || !loginEmail) return null;
    // Only an account that already holds the resident role is reused: a manager who shares the number
    // is not handed a new role by a stranger's booking.
    const { data: role } = await db
      .from("profile_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "resident")
      .maybeSingle();
    if (role) {
      return { userId, loginEmail, created: false, signInUrl: await mintSignInUrl(db, loginEmail).catch(() => null) };
    }
  }

  // A typed address that already has an account is not ours to log into (see the module note).
  const emailTaken = email ? Boolean(await findAuthUserIdByEmail(db, email)) : false;
  const loginEmail = email && !emailTaken ? email : guestPlaceholderEmail(phone);

  const { data: created, error } = await db.auth.admin.createUser({
    email: loginEmail,
    email_confirm: true,
    user_metadata: { role: "resident", full_name: name || undefined, guest_stay: true },
  });
  const userId = created?.user?.id;
  if (error || !userId) return null;

  const provisioned = await provisionResidentAccountByEmail(db, {
    userId,
    email: loginEmail,
    fullName: name,
    phone,
    inheritFromApplication: false,
  });
  if (!provisioned.ok) return null;
  await ensureProfileRoleRow(db, userId, "resident");
  return { userId, loginEmail, created: true, signInUrl: await mintSignInUrl(db, loginEmail).catch(() => null) };
}
