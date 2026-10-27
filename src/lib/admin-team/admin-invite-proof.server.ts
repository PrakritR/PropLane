import "server-only";
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { findAuthUserIdByEmail } from "@/lib/auth/find-auth-user-id-by-email";
import { hashInviteLinkToken } from "@/lib/invite-links/invite-links.server";
import { inviteLinkUnusableReason } from "@/lib/invite-links/invite-link-model";
import { sharedPortalFromAddress } from "@/lib/manager-outbound-identity.server";
import { rateLimit } from "@/lib/rate-limit";
import { postResendEmail } from "@/lib/resend-delivery.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { ADMIN_INVITE_CODE_MINUTES, parseStoredAdminGrant } from "@/lib/admin-team/admin-team-model";

/**
 * A NEW account on an admin invite must prove it reads the invited inbox before it exists. The server mails a 6-digit
 * code to the address stored on the link (never one the browser names); the account is created, already confirmed, only
 * when that code verifies, and carries `app_metadata.admin_invite_proof = <link id>`, which the redeem requires of any
 * account created after the invite (`adminInviteAccountProven`). The generic sign-up route, which confirms an address
 * without an inbox round-trip, therefore cannot be used to take an admin grant.
 *
 * The challenge is stateless: an HMAC over (link, address, expiry, code) keyed with a server secret, so no new table is
 * needed. Verifying is capped at five attempts per link (across every challenge), so a 6-digit code cannot be ground
 * through; a locked link is replaced by Resend, which mints a new one.
 */

export type ProofResult<T> = ({ ok: true } & T) | { ok: false; status: number; error: string };
const fail = (status: number, error: string) => ({ ok: false as const, status, error });

export const ADMIN_CODE_WRONG_ERROR = "That code is not right. Check it and try again.";
export const ADMIN_CODE_EXPIRED_ERROR = "That code has expired. Send a new one.";
export const ADMIN_INVITE_LOCKED_ERROR = "This invite is locked — ask for a new one.";
/** Code attempts one link allows across ALL its challenges (a new code does not reset it). Resend mints a new link. */
export const ADMIN_CODE_ATTEMPTS_PER_LINK = 5;
/** The limiter's longest window is one day, so the lock is per day; the link itself lives seven. */
const ADMIN_CODE_ATTEMPT_WINDOW_MS = 24 * 60 * 60_000;
export const ADMIN_ACCOUNT_EXISTS_ERROR = "An account with this email already exists. Sign in to accept this invite.";

function secret(): string | null {
  return process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
}

function mac(linkId: string, email: string, expiresAt: number, code: string): string | null {
  const key = secret();
  if (!key) return null;
  return createHmac("sha256", key).update(`admin-invite-code:${linkId}:${email}:${expiresAt}:${code}`).digest("base64url");
}

type LiveAdminLink = { id: string; email: string; ownerUserId: string };

async function loadLiveAdminLink(db: SupabaseClient, token: string): Promise<ProofResult<{ link: LiveAdminLink }>> {
  const { data } = await db
    .from("manager_invite_links")
    .select("id, kind, owner_user_id, invitee_email, admin_grant, expires_at, revoked_at, max_uses, used_count")
    .eq("token_hash", hashInviteLinkToken(token))
    .maybeSingle();
  const row = data as {
    id: string; kind: string; owner_user_id: string; invitee_email: string | null; admin_grant: unknown;
    expires_at: string | null; revoked_at: string | null; max_uses: number | null; used_count: number | null;
  } | null;
  const email = (row?.invitee_email ?? "").trim().toLowerCase();
  if (!row || row.kind !== "admin" || !email || !parseStoredAdminGrant(row.admin_grant)) return fail(404, "That invite link is not valid.");
  if (inviteLinkUnusableReason({ expiresAt: row.expires_at, revokedAt: row.revoked_at, maxUses: row.max_uses, usedCount: row.used_count })) {
    return fail(410, "This invite is no longer active. Ask for a new one.");
  }
  return { ok: true, link: { id: String(row.id), email, ownerUserId: String(row.owner_user_id) } };
}

/** Mail a fresh code to the invited address. The browser gets back only the signed challenge, never the code. */
export async function sendAdminInviteCode(
  db: SupabaseClient,
  input: { token: string; now?: number },
): Promise<ProofResult<{ challenge: string; expiresAt: number }>> {
  const loaded = await loadLiveAdminLink(db, input.token);
  if (!loaded.ok) return loaded;
  const { link } = loaded;
  if (!(await rateLimit(`admin-invite-code-send:${link.id}`, 5, 60 * 60_000)).ok) return fail(429, "Too many codes sent. Try again later.");
  // An address that already has a login signs in with it: a code here would only be a second way in.
  if (await findAuthUserIdByEmail(db, link.email)) return fail(409, ADMIN_ACCOUNT_EXISTS_ERROR);
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return fail(503, "Email delivery is not configured.");
  const expiresAt = (input.now ?? Date.now()) + ADMIN_INVITE_CODE_MINUTES * 60_000;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const signature = mac(link.id, link.email, expiresAt, code);
  if (!signature) return fail(503, "Could not send a code. Try again later.");
  try {
    const res = await postResendEmail({
      apiKey,
      actorUserId: link.ownerUserId,
      payload: {
        from: sharedPortalFromAddress(),
        to: [link.email],
        subject: "Your PropLane admin code",
        text: [
          "Hi,",
          "",
          `Your PropLane admin code is ${code}. It works for ${ADMIN_INVITE_CODE_MINUTES} minutes.`,
          "",
          `Enter it on the invite page to create your admin account (${resolveEmailLinkBaseUrl()}).`,
          "If you did not ask for this, ignore this email.",
          "",
          "PropLane",
        ].join("\n"),
      },
      effectSummary: "PropLane admin invite code email captured for the test workspace.",
    });
    if (!res.ok) return fail(502, "The code could not be emailed. Try again.");
  } catch {
    return fail(502, "The code could not be emailed. Try again.");
  }
  return { ok: true, challenge: `${expiresAt}.${signature}`, expiresAt };
}

/**
 * Verify the code and only then create the account: confirmed because the inbox just proved itself, and stamped with the
 * proof the redeem requires. Name and phone ride on the auth metadata like the generic sign-up; the password is the
 * person's own. Nothing is granted here: the caller signs in and redeems the link as usual.
 */
export async function createVerifiedAdminAccount(
  db: SupabaseClient,
  input: { token: string; challenge: string; code: string; fullName: string; phone: string; password: string; now?: number },
): Promise<ProofResult<{ email: string }>> {
  const loaded = await loadLiveAdminLink(db, input.token);
  if (!loaded.ok) return loaded;
  const { link } = loaded;
  // One budget per LINK, spent before the code is looked at (so a right guess cannot be tried without paying for the
  // wrong ones) and shared by every challenge: asking for a fresh code does not buy fresh guesses.
  const attempt = await rateLimit(`admin-invite-code-verify:${link.id}`, ADMIN_CODE_ATTEMPTS_PER_LINK, ADMIN_CODE_ATTEMPT_WINDOW_MS);
  if (!attempt.ok) return attempt.unavailable ? fail(503, "Could not check the code. Try again later.") : fail(429, ADMIN_INVITE_LOCKED_ERROR);
  const code = input.code.trim();
  const [expRaw, signature] = input.challenge.split(".");
  const expiresAt = Number(expRaw);
  if (!/^\d{6}$/.test(code) || !Number.isFinite(expiresAt) || !signature) return fail(400, ADMIN_CODE_WRONG_ERROR);
  if ((input.now ?? Date.now()) > expiresAt) return fail(400, ADMIN_CODE_EXPIRED_ERROR);
  const expected = mac(link.id, link.email, expiresAt, code);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected ?? "");
  if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) return fail(400, ADMIN_CODE_WRONG_ERROR);

  if (input.password.length < 8) return fail(400, "Password must be at least 8 characters.");
  const fullName = input.fullName.trim().slice(0, 120);
  const phone = normalizeE164(input.phone);
  const created = await db.auth.admin.createUser({
    email: link.email,
    password: input.password,
    email_confirm: true,
    user_metadata: { ...(fullName ? { full_name: fullName } : {}), ...(phone ? { phone } : {}) },
    app_metadata: { admin_invite_proof: link.id },
  });
  if (created.error) {
    const exists = /already|registered/i.test(created.error.message);
    return exists ? fail(409, ADMIN_ACCOUNT_EXISTS_ERROR) : fail(400, "Could not create your account.");
  }
  return { ok: true, email: link.email };
}
