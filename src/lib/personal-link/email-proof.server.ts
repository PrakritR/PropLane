import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";

/**
 * Email proof for a phone-only account made from a personal account link. NOT a Supabase `token_hash` link: with secure
 * email change on, `email_change` needs a token sent to the account's OLD address, which here is a non-deliverable
 * placeholder. So PropLane mints its own proof, with the same properties the rule asks of an out-of-band link: 32 random
 * bytes, only the SHA-256 stored (`personal_email_proofs`, service role only), single use, 24 hours, bound to one user and
 * one email, opened in any browser (no PKCE, no session needed), mailed through Resend and never Supabase's mailer.
 *
 * Silent by design: a taken email, a failed insert or a failed send all return `false` and say nothing different, so the
 * person cannot learn whether an address belongs to someone (no existence oracle); a taken email sends no mail.
 */
export const EMAIL_PROOF_TTL_MS = 24 * 60 * 60 * 1000;

export const hashEmailProofToken = (token: string): string => createHash("sha256").update(token.trim(), "utf8").digest("hex");
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type EmailProofDeps = {
  emailTaken: (db: SupabaseClient, email: string) => Promise<boolean>;
  send?: (input: { to: string; href: string }) => Promise<boolean>;
  now?: () => Date;
};

async function sendViaResend({ to, href }: { to: string; href: string }): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM?.trim();
  if (!apiKey || !from) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        subject: "Verify your PropLane email",
        text: `Use this link to verify your email:\n\n${href}\n\nIf you did not request this, ignore this email.`,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function startEmailProof(db: SupabaseClient, input: { userId: string; email: string }, deps: EmailProofDeps): Promise<boolean> {
  const email = input.email.trim().toLowerCase();
  if (!email) return false;
  try {
    if (await deps.emailTaken(db, email).catch(() => true)) return false;
    const now = (deps.now ?? (() => new Date()))();
    // One live proof per account: a newer one replaces the older.
    await db.from("personal_email_proofs").update({ used_at: now.toISOString() }).eq("user_id", input.userId).is("used_at", null);
    const token = randomBytes(32).toString("base64url");
    const { error } = await db.from("personal_email_proofs").insert({
      user_id: input.userId,
      email,
      token_hash: hashEmailProofToken(token),
      expires_at: new Date(now.getTime() + EMAIL_PROOF_TTL_MS).toISOString(),
    });
    if (error) return false;
    const href = `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/auth/confirm-email?token=${encodeURIComponent(token)}`;
    return await (deps.send ?? sendViaResend)({ to: email, href });
  } catch {
    return false;
  }
}

export type VerifyEmailProofDeps = { emailTaken: EmailProofDeps["emailTaken"]; now?: () => Date };

/**
 * Open a proof. Unknown, malformed, used, expired and "email now belongs to someone else" all return the same
 * `false`. The claim is atomic (`used_at is null` -> now) before the account changes; a failed change gives it back.
 */
export async function verifyEmailProof(db: SupabaseClient, token: string, deps: VerifyEmailProofDeps): Promise<boolean> {
  const presented = String(token ?? "").trim();
  if (!TOKEN.test(presented)) return false;
  const now = (deps.now ?? (() => new Date()))();
  const hash = hashEmailProofToken(presented);
  const { data: claimed, error } = await db
    .from("personal_email_proofs")
    .update({ used_at: now.toISOString() })
    .eq("token_hash", hash)
    .is("used_at", null)
    .gt("expires_at", now.toISOString())
    .select("id, user_id, email");
  const row = (claimed ?? [])[0] as { id: string; user_id: string; email: string } | undefined;
  if (error || !row) return false;
  const release = () => db.from("personal_email_proofs").update({ used_at: null }).eq("id", row.id).then(() => undefined, () => undefined);
  try {
    if (await deps.emailTaken(db, row.email).catch(() => true)) return false;
    const { error: updateError } = await db.auth.admin.updateUserById(row.user_id, { email: row.email, email_confirm: true });
    if (updateError) {
      await release();
      return false;
    }
    await db.from("profiles").update({ email: row.email }).eq("id", row.user_id).then(() => undefined, () => undefined);
    return true;
  } catch {
    await release();
    return false;
  }
}
