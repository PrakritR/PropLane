import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { phoneOwners } from "@/lib/auth/phone-auth.server";
import { rateLimit } from "@/lib/rate-limit";
import { guestSignInConfirmUrl } from "@/lib/short-stay/guest-login.server";

export const SIGN_IN_LINKS_PER_PHONE_PER_HOUR = 5;

/**
 * A one-tap sign-in link for the account that owns this VERIFIED phone, to be texted to that same phone and nowhere else.
 *
 * It is the `token_hash` link the guest portal already uses (`/auth/confirm?token_hash=...&type=magiclink`, never a PKCE
 * `code`): Supabase stores only the token's hash, the link is single use and short lived, and `/auth/confirm` derives its
 * destination from `type` alone. It is bound to the phone twice over: the account is re-derived from the phone's verified
 * owner here (never from a request value), and the text goes only to that number. No second link service is invented.
 * Capped per phone per hour; returns null on any refusal.
 */
export async function mintPhoneSignInLink(db: SupabaseClient, input: { phoneE164: string; userId: string }): Promise<string | null> {
  try {
    const owners = await phoneOwners(db, input.phoneE164);
    if (owners.length !== 1 || owners[0] !== input.userId) return null;
    const limited = await rateLimit(
      `sms-signin-link:${createHash("sha256").update(input.phoneE164).digest("hex").slice(0, 32)}`,
      SIGN_IN_LINKS_PER_PHONE_PER_HOUR,
      60 * 60 * 1000,
    );
    if (!limited.ok) return null;
    const { data: auth, error } = await db.auth.admin.getUserById(input.userId);
    const email = auth?.user?.email?.trim();
    if (error || !email) return null;
    const { data, error: linkError } = await db.auth.admin.generateLink({ type: "magiclink", email });
    const tokenHash = data?.properties?.hashed_token;
    if (linkError || !tokenHash) return null;
    return guestSignInConfirmUrl(resolveEmailLinkBaseUrl(), tokenHash);
  } catch {
    return null;
  }
}
