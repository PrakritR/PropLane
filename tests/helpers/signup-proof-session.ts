import type { SupabaseClient } from "@supabase/supabase-js";
import { readSignupJournal } from "./signup-proof-journal";

/** The JWT is used in memory only. A failed or ambiguous subject check never signs out. */
export async function revokeSignupSession(db: SupabaseClient, journalFile: string, jwt: string): Promise<void> {
  const manifest = readSignupJournal(journalFile);
  if ((db as unknown as { supabaseUrl?: string }).supabaseUrl !== manifest.target || !manifest.actorId || !jwt || jwt.length > 16384) throw new Error("Signup session revocation refused.");
  try {
    const result = await db.auth.getUser(jwt);
    const user = result.data.user;
    if (result.error || user?.id !== manifest.actorId || user.email?.toLowerCase() !== manifest.email || user.app_metadata?.proplane_email_onboarding !== true || !Number.isFinite(Date.parse(user.created_at)) || Date.parse(user.created_at) < Date.parse(manifest.startedAt)) throw new Error();
    const revoked = await db.auth.admin.signOut(jwt, "global");
    if (revoked.error) throw new Error();
  } catch { throw new Error("Signup session revocation refused."); }
}

/** Extract only this DEV project's SSR session cookie in memory; never log or persist it. */
export async function revokeSignupContext(db: SupabaseClient, journalFile: string, context: Pick<import("@playwright/test").BrowserContext, "cookies">): Promise<void> {
  const journal = readSignupJournal(journalFile);
  const name = "sb-emstjswhotsnyksqhqyf-auth-token";
  const cookies = await context.cookies();
  const selected = cookies.filter((cookie) => cookie.name === name || cookie.name.startsWith(`${name}.`));
  if (!selected.length) {
    // An account can exist before email verification creates a browser session.
    return;
  }
  try {
    const whole = selected.filter((cookie) => cookie.name === name);
    const chunks = selected.filter((cookie) => cookie.name !== name);
    if (whole.length > 1 || (whole.length && chunks.length)) throw new Error();
    let encoded: string;
    if (whole.length) encoded = whole[0]!.value;
    else {
      const ordered = chunks.map((cookie) => {
        const suffix = cookie.name.slice(name.length + 1);
        if (!/^(0|[1-9][0-9]*)$/.test(suffix)) throw new Error();
        return { index: Number(suffix), value: cookie.value };
      }).sort((a, b) => a.index - b.index);
      if (ordered.some((entry, index) => entry.index !== index)) throw new Error();
      encoded = ordered.map((entry) => entry.value).join("");
    }
    const serialized = encoded.startsWith("base64-") ? Buffer.from(encoded.slice(7), "base64url").toString("utf8") : encoded;
    const session = JSON.parse(serialized) as { access_token?: unknown };
    if (!journal.actorId || typeof session.access_token !== "string") throw new Error();
    await revokeSignupSession(db, journalFile, session.access_token);
  } catch { throw new Error("Signup context revocation refused."); }
}
