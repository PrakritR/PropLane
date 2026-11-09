import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { chmodSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { syntheticFixtureActorId } from "./synthetic-property-e2e";
import { syntheticSignupDomain } from "./synthetic-signup-domain";

/**
 * Clear the MANDATORY phone gate for one freshly created synthetic manager, as test fixture
 * setup — never as proof that a phone was verified.
 *
 * `phone_required` sends every signed-in account without a verified phone to
 * `/auth/verify-phone?next=…` before it reaches a portal (`needsPhoneVerification` →
 * `readPhoneIdentity`, which reads `profiles.phone` + `profiles.phone_verified_at`). A synthetic
 * signup therefore lands on that screen, and no real code can be delivered to a synthetic
 * number. So this stamps `phone_verified_at` on that one profile and hands back the restore.
 *
 * It is NOT an OTP proof. Nothing here sends or receives a message, and no test may describe
 * phone verification as exercised because this ran.
 *
 * Every guard below is a refusal, not a warning:
 *  - the exact DEV project and a localhost port,
 *  - a `<prefix>-<13 digits>@example.invalid` mailbox and nothing else,
 *  - the browser's OWN `/api/profile` actor, matching the Auth user id and email exactly,
 *  - a manager role,
 *  - a profile phone already equal to the synthetic number the signup typed,
 *  - and a BEFORE state that is unverified.
 *
 * It writes one column, with a compare-and-set on the value it read. Nothing touches the Auth
 * user's password, its phone, its roles or any entitlement.
 */

const DEV_SUPABASE_URL = "https://emstjswhotsnyksqhqyf.supabase.co";

/** `<prefix>-<13 digits>@<the configured synthetic domain>` and nothing else. */
function syntheticMailbox(): RegExp {
  return new RegExp(`^[a-z0-9-]+-\\d{13}@${syntheticSignupDomain().replace(/\./g, "\\.")}$`);
}

export type SyntheticPhoneVerification = {
  /**
   * Put the profile back exactly as it was, under the same compare-and-set. Call it in a
   * `finally`, in every test and helper, even when the test failed — and report a conflict
   * rather than swallowing it: a left-behind verified flag is a fixture leak.
   */
  restore: () => Promise<void>;
  userId: string;
  phone: string;
};

function serviceRoleClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url !== DEV_SUPABASE_URL) throw new Error("Synthetic phone fixture requires the exact dev/test project.");
  if (!key) throw new Error("Synthetic phone fixture requires the dev/test service-role key.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function assertLocalDev(page: Page): void {
  const url = new URL(page.url());
  const port = Number(url.port);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) ||
      !Number.isInteger(port) || port < 3000 || port > 3014) {
    throw new Error("Synthetic phone fixture requires a localhost port from 3000 through 3014.");
  }
}

/**
 * The signed-in actor as the BROWSER sees it: the id from this context's own session cookie, and
 * the email and phone from the server's view of that same session. Both have to agree with the
 * Auth user, so the fixture can never reach another account.
 */
async function browserActor(page: Page): Promise<{ id: string; email: string; phone: string }> {
  const id = await syntheticFixtureActorId(page);
  const response = await page.request.get("/api/profile");
  if (!response.ok()) throw new Error("Synthetic phone fixture could not read the signed-in actor.");
  const body = await response.json() as { email?: unknown; phone?: unknown };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  if (!id || !email) throw new Error("Synthetic phone fixture needs an exact signed-in actor id and email.");
  return { id, email, phone };
}

function writePrivateBeforeImage(image: Record<string, unknown>): void {
  const dir = process.env.E2E_PRIVATE_FIXTURE_DIR;
  if (!dir || !path.isAbsolute(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((lstatSync(dir).mode & 0o777) !== 0o700) throw new Error("Synthetic phone fixture before-image directory must be private.");
  const file = path.join(dir, `phone-fixture-${image.userId}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(image, null, 2), { flag: "wx", mode: 0o600 });
  chmodSync(file, 0o600);
}

export async function verifySyntheticManagerPhone(
  page: Page,
  input: { email: string; phone: string },
): Promise<SyntheticPhoneVerification> {
  assertLocalDev(page);
  const email = input.email.trim().toLowerCase();
  if (!syntheticMailbox().test(email)) {
    throw new Error("Synthetic phone fixture only serves a <prefix>-<13 digits> synthetic mailbox.");
  }
  if (!/^\+1\d{10}$/.test(input.phone)) throw new Error("Synthetic phone fixture requires a normalized E.164 test number.");

  const db = serviceRoleClient();
  const actor = await browserActor(page);
  if (actor.email !== email) throw new Error("Synthetic phone fixture actor is not the synthetic mailbox.");
  if (actor.phone && actor.phone !== input.phone) {
    throw new Error("Synthetic phone fixture actor's phone is not the requested synthetic number.");
  }

  const auth = await db.auth.admin.getUserById(actor.id);
  if (auth.error || !auth.data.user) throw new Error("Synthetic phone fixture could not confirm the Auth user.");
  if (String(auth.data.user.email ?? "").trim().toLowerCase() !== email) {
    throw new Error("Synthetic phone fixture Auth user does not match the synthetic mailbox.");
  }

  const { data: profile, error } = await db
    .from("profiles")
    .select("id, email, role, phone, phone_verified_at")
    .eq("id", actor.id)
    .maybeSingle();
  if (error || !profile) throw new Error("Synthetic phone fixture could not read the profile.");
  if (String(profile.email ?? "").trim().toLowerCase() !== email) {
    throw new Error("Synthetic phone fixture profile does not match the synthetic mailbox.");
  }
  if (String(profile.role ?? "").trim().toLowerCase() !== "manager") {
    throw new Error("Synthetic phone fixture only serves a manager profile.");
  }
  if (String(profile.phone ?? "").trim() !== input.phone) {
    throw new Error("Synthetic phone fixture profile phone is not the requested synthetic number.");
  }
  if (profile.phone_verified_at) throw new Error("Synthetic phone fixture refuses an already-verified profile.");

  const before = { userId: actor.id, email, phone: input.phone, phone_verified_at: null as string | null };
  writePrivateBeforeImage({ ...before, at: new Date().toISOString() });

  const verifiedAt = new Date().toISOString();
  const applied = await db
    .from("profiles")
    .update({ phone_verified_at: verifiedAt })
    .eq("id", actor.id)
    .eq("email", profile.email)
    .eq("phone", input.phone)
    .is("phone_verified_at", null)
    .select("id, phone_verified_at");
  if (applied.error || applied.data?.length !== 1 || applied.data[0]?.phone_verified_at !== verifiedAt) {
    throw new Error("Synthetic phone fixture could not compare-and-set the verification stamp.");
  }

  let restored = false;
  return {
    userId: actor.id,
    phone: input.phone,
    restore: async () => {
      if (restored) return;
      const reverted = await db
        .from("profiles")
        .update({ phone_verified_at: before.phone_verified_at })
        .eq("id", actor.id)
        .eq("phone", input.phone)
        .eq("phone_verified_at", verifiedAt)
        .select("id, phone_verified_at");
      if (reverted.error || reverted.data?.length !== 1 || reverted.data[0]?.phone_verified_at !== null) {
        // Reported, never swallowed: a left-behind verified flag is a fixture leak and the run
        // must say so rather than pass quietly.
        throw new Error("Synthetic phone fixture could not restore the original verification state.");
      }
      restored = true;
    },
  };
}

/**
 * The gate, cleared where it actually appears: between `finishManagerEmailProof` (the real
 * mailbox proof) and `completeManagerSignupOnboarding`. Returns `null` when the gate did not
 * apply, so nothing is stamped on an account that never needed it.
 */
export async function clearManagerPhoneGate(
  page: Page,
  input: { email: string; phone: string },
): Promise<SyntheticPhoneVerification | null> {
  if (!new URL(page.url()).pathname.startsWith("/auth/verify-phone")) return null;
  const fixture = await verifySyntheticManagerPhone(page, input);
  const next = new URL(page.url()).searchParams.get("next");
  await page.goto(next && next.startsWith("/") ? next : "/portal/dashboard", { waitUntil: "domcontentloaded" });
  return fixture;
}
