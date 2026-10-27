import "server-only";

/**
 * A guest who books from the public listing card has no PropLane login. This makes (or finds) one,
 * keyed on the PHONE they typed.
 *
 * Why the phone is the key and the typed email is not: the confirmation is texted to that phone, so
 * only whoever holds it is ever addressed. A typed email is unverified, so it is NEVER the login and
 * never `profiles.email`: anyone could type a victim's address (an applicant or resident with no
 * login yet) and their own phone and read every row keyed on that address. The account always gets a
 * placeholder login address (the `@import.proplane.local` family a phone-only resident already has),
 * is provisioned with `emailProven: false` (no application, inbox or account inheritance), and the
 * typed email stays on the stay row for the host's copy of the confirmation.
 *
 * A TYPED phone is a claim too, so it opens exactly two accounts and no others: the placeholder this
 * flow minted for that number (found by its stable login address, so a returning guest keeps the
 * account their first booking made), or an account whose `profiles.phone` is VERIFIED
 * (`phone_verified_at`). `profiles.phone` is otherwise self-edited in Settings and unverified, so a
 * recycled, reassigned, mistyped or shared number that merely matches would be handed that resident's
 * lease, payments and documents. Same rule as `rowMatchesGuest` in
 * `instant-book.server.ts`, where an unverified number buys no standing either.
 *
 * The account gets the `resident` role, which is what unlocks the short-stay request (`/resident/applications/stay`).
 *
 * This flow mints NO sign-in link. A text sent from a host's line is stored in that host's outbox, and a
 * live sign-in link must never sit where the host can read it, so the public stay request tells the guest
 * to sign in with their phone at `/auth/sign-in` instead (`withGuestSignInPrompt`). `guestSignInConfirmUrl`
 * stays for the phone-bound signup link (`one-number/signup/sign-in-link.server.ts`), which mints one only
 * behind `smsProvenSessionAllowed` and texts it to the number that proved itself.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { provisionResidentAccountByEmail } from "@/lib/auth/provision-resident-account";
import { PORTFOLIO_IMPORT_PLACEHOLDER_EMAIL_DOMAIN } from "@/lib/portfolio-import/placeholder-email";

export type GuestLogin = {
  userId: string;
  /** The address the account signs in with: the phone-keyed placeholder, or the reused account's own. */
  loginEmail: string;
  created: boolean;
};

/** `/auth/confirm?token_hash=…&type=magiclink` - the destination is derived from `type` there. */
export function guestSignInConfirmUrl(origin: string, tokenHash: string): string {
  return `${origin.trim().replace(/\/$/, "")}/auth/confirm?token_hash=${encodeURIComponent(tokenHash)}&type=magiclink`;
}

/** The placeholder login for a guest whose typed email cannot be the login. Stable per phone. */
export function guestPlaceholderEmail(phone: string): string {
  return `guest.${phone.replace(/\D/g, "")}@${PORTFOLIO_IMPORT_PLACEHOLDER_EMAIL_DOMAIN}`;
}

async function holdsResidentRole(db: SupabaseClient, userId: string): Promise<boolean> {
  // Only an account that already holds the resident role is reused: a manager who shares the number
  // is not handed a new role by a stranger's booking.
  const { data } = await db
    .from("profile_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "resident")
    .maybeSingle();
  return Boolean(data);
}

/**
 * Finds the resident login this phone PROVABLY owns, or creates one. Null when it cannot be done
 * safely (two accounts claim a verified number, or the account service refused): the stay is still
 * saved, the guest just gets no link.
 */
export async function ensureGuestLogin(
  db: SupabaseClient,
  input: { name: string; phone: string; email?: string },
): Promise<GuestLogin | null> {
  // `input.email` is deliberately unused: it is unverified and is never an identity (see the module note).
  const { name, phone } = input;
  if (!phone) return null;

  const placeholderEmail = guestPlaceholderEmail(phone);

  // The account this flow already minted for this number, found by its STABLE login address rather
  // than by `profiles.phone`: once a real resident stores the same number the phone query returns
  // several rows, and a returning guest would lose the account their first booking made.
  const { data: minted } = await db.from("profiles").select("id").eq("email", placeholderEmail).maybeSingle();
  const mintedUserId = String((minted as { id?: string } | null)?.id ?? "").trim();
  if (mintedUserId) {
    if (!(await holdsResidentRole(db, mintedUserId))) return null;
    return { userId: mintedUserId, loginEmail: placeholderEmail, created: false };
  }

  const { data: matches } = await db.from("profiles").select("id, email, phone_verified_at").eq("phone", phone).limit(2);
  const rows = (matches ?? []) as Array<{ id?: string; email?: string | null; phone_verified_at?: string | null }>;
  // A VERIFIED number is possession, so two accounts claiming it is a state this flow will not guess at.
  const verified = rows.filter((row) => Boolean(row.phone_verified_at));
  if (verified.length > 1) return null;
  if (verified.length === 1) {
    const existing = verified[0]!;
    const userId = String(existing.id ?? "");
    const loginEmail = String(existing.email ?? "").trim().toLowerCase();
    if (!userId || !loginEmail) return null;
    if (await holdsResidentRole(db, userId)) {
      return { userId, loginEmail, created: false };
    }
  }
  // Every other match is an unverified claim on the number: it gets this phone's own placeholder
  // login below, never a link into the account that merely stored the same digits.

  const loginEmail = placeholderEmail;

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
    emailProven: false,
  });
  if (!provisioned.ok) return null;
  await ensureProfileRoleRow(db, userId, "resident");
  return { userId, loginEmail, created: true };
}

/**
 * The resident login this phone PROVABLY owns, found without creating or signing anything in: the
 * placeholder this flow minted for the number, else the single account whose `profiles.phone` is VERIFIED
 * and which holds the resident role. Same two rules as `ensureGuestLogin`, so "send me the payment link"
 * can never open an account a bare, unverified phone match merely names.
 */
export async function findPhoneOwnedResidentId(db: SupabaseClient, phone: string): Promise<string | null> {
  if (!phone) return null;
  const { data: minted } = await db.from("profiles").select("id").eq("email", guestPlaceholderEmail(phone)).maybeSingle();
  const mintedUserId = String((minted as { id?: string } | null)?.id ?? "").trim();
  if (mintedUserId) return (await holdsResidentRole(db, mintedUserId)) ? mintedUserId : null;
  const { data: matches } = await db.from("profiles").select("id, phone_verified_at").eq("phone", phone).limit(3);
  const verified = ((matches ?? []) as Array<{ id?: string; phone_verified_at?: string | null }>).filter((row) => Boolean(row.phone_verified_at));
  if (verified.length !== 1) return null;
  const userId = String(verified[0]!.id ?? "");
  return userId && (await holdsResidentRole(db, userId)) ? userId : null;
}
