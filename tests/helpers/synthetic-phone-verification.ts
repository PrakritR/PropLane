import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { lstatSync, realpathSync, statSync, writeFileSync } from "node:fs";
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
  if (!dir || !path.isAbsolute(dir)) throw new Error("Synthetic phone fixture requires an absolute private before-image directory.");
  let directory;
  try {
    directory = lstatSync(dir);
    const followed = statSync(dir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || !path.isAbsolute(realpathSync(dir)) ||
        followed.dev !== directory.dev || followed.ino !== directory.ino ||
        (directory.mode & 0o777) !== 0o700 || directory.uid !== process.getuid?.()) {
      throw new Error("Synthetic phone fixture before-image directory must be a private real directory owned by this user.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("before-image directory")) throw error;
    throw new Error("Synthetic phone fixture before-image directory is unavailable.");
  }
  const file = path.join(dir, `phone-fixture-${image.userId}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(image, null, 2), { flag: "wx", mode: 0o600 });
  const written = lstatSync(file);
  const followedFile = statSync(file);
  if (!written.isFile() || written.isSymbolicLink() || !path.isAbsolute(realpathSync(file)) ||
      followedFile.dev !== written.dev || followedFile.ino !== written.ino ||
      (written.mode & 0o777) !== 0o600 || written.uid !== process.getuid?.()) {
    throw new Error("Synthetic phone fixture before-image file is not private.");
  }
}

function sameInstant(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
}

async function readPhoneStamp(db: SupabaseClient, id: string, email: string, phone: string) {
  const { data, error } = await db.from("profiles")
    .select("id, email, phone, phone_verified_at")
    .eq("id", id)
    .maybeSingle();
  if (error || !data || data.id !== id || String(data.email ?? "").trim().toLowerCase() !== email ||
      String(data.phone ?? "").trim() !== phone) {
    throw new Error("Synthetic phone fixture could not confirm the exact profile during compensation.");
  }
  return data as { id: string; email: string; phone: string; phone_verified_at: string | null };
}

async function restoreAttemptedStamp(
  db: SupabaseClient,
  input: { id: string; email: string; phone: string; attemptedAt: string },
): Promise<void> {
  const current = await readPhoneStamp(db, input.id, input.email, input.phone);
  if (current.phone_verified_at === null) return;
  if (!sameInstant(current.phone_verified_at, input.attemptedAt)) {
    throw new Error("Synthetic phone fixture found a newer verification stamp and refused to overwrite it.");
  }
  const reverted = await db.from("profiles")
    .update({ phone_verified_at: null })
    .eq("id", input.id)
    .eq("email", input.email)
    .eq("phone", input.phone)
    .eq("phone_verified_at", input.attemptedAt)
    .select("id, email, phone, phone_verified_at");
  if (!reverted.error && reverted.data?.length === 1 && reverted.data[0]?.id === input.id) {
    const stamp = reverted.data[0]?.phone_verified_at;
    if (stamp === null) return;
  }
  // An update acknowledgement can be lost after commit. Confirm the exact before-state before
  // declaring compensation failed; never issue a second unconditional write.
  const after = await readPhoneStamp(db, input.id, input.email, input.phone);
  if (after.phone_verified_at !== null) {
    throw new Error("Synthetic phone fixture could not restore its attempted verification stamp.");
  }
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
  if (!auth.data.user.email_confirmed_at) {
    throw new Error("Synthetic phone fixture requires the exact Auth email to be confirmed.");
  }

  const { data: managerRole, error: roleError } = await db
    .from("profile_roles")
    .select("role")
    .eq("user_id", actor.id)
    .eq("role", "manager")
    .maybeSingle();
  if (roleError || !managerRole || managerRole.role !== "manager") {
    throw new Error("Synthetic phone fixture requires an authoritative manager role.");
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
  const verifiedAt = new Date().toISOString();
  // Persist the exact before-state and intended CAS value before the DB write, so a lost
  // acknowledgement has a private receipt and a bounded compensation target.
  writePrivateBeforeImage({ ...before, attemptedVerifiedAt: verifiedAt, recordedAt: new Date().toISOString() });
  let applied;
  try {
    applied = await db
      .from("profiles")
      .update({ phone_verified_at: verifiedAt })
      .eq("id", actor.id)
      .eq("email", profile.email)
      .eq("phone", input.phone)
      .is("phone_verified_at", null)
      .select("id, phone_verified_at");
  } catch (writeError) {
    try {
      await restoreAttemptedStamp(db, { id: actor.id, email, phone: input.phone, attemptedAt: verifiedAt });
    } catch (compensationError) {
      throw new AggregateError(
        [new Error("Synthetic phone fixture write acknowledgement was lost."), compensationError],
        "Synthetic phone fixture write rejected and exact compensation could not be confirmed.",
      );
    }
    throw new Error("Synthetic phone fixture write rejected; attempted write was compensated.", { cause: writeError });
  }
  if (applied.error || applied.data?.length !== 1 || applied.data[0]?.id !== actor.id ||
      !sameInstant(applied.data[0]?.phone_verified_at, verifiedAt)) {
    try {
      await restoreAttemptedStamp(db, { id: actor.id, email, phone: input.phone, attemptedAt: verifiedAt });
    } catch (compensationError) {
      throw new AggregateError(
        [new Error("Synthetic phone fixture could not confirm its compare-and-set acknowledgement."), compensationError],
        "Synthetic phone fixture write failed and exact compensation could not be confirmed.",
      );
    }
    throw new Error("Synthetic phone fixture could not compare-and-set the verification stamp; attempted write was compensated.");
  }

  let restored = false;
  return {
    userId: actor.id,
    phone: input.phone,
    restore: async () => {
      if (restored) return;
      try {
        await restoreAttemptedStamp(db, { id: actor.id, email, phone: input.phone, attemptedAt: verifiedAt });
      } catch (error) {
        // Reported, never swallowed: a left-behind verified flag is a fixture leak.
        throw new Error("Synthetic phone fixture could not restore the original verification state.", { cause: error });
      }
      restored = true;
    },
  };
}

/** Keep ownership of a phone fixture until later fallible setup has succeeded. */
export async function withSyntheticPhoneFixtureOwnership<T>(
  fixture: SyntheticPhoneVerification | null,
  setup: () => Promise<T>,
): Promise<{ value: T; fixture: SyntheticPhoneVerification | null }> {
  try {
    return { value: await setup(), fixture };
  } catch (error) {
    if (!fixture) throw error;
    try {
      await fixture.restore();
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], "Synthetic phone setup failed and fixture restoration also failed.");
    }
    throw error;
  }
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
  try {
    await page.goto(next && next.startsWith("/") ? next : "/portal/dashboard", { waitUntil: "domcontentloaded" });
  } catch (error) {
    try {
      await fixture.restore();
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], "Synthetic phone gate navigation failed and fixture restoration also failed.");
    }
    throw error;
  }
  return fixture;
}
