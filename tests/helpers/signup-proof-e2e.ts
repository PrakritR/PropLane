import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, realpathSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { residentApplicationDestination } from "./signup-ui-contract";

import { identifySignupActor, persistSignupJournal, type SignupJournal } from "./signup-proof-journal";

export type SignupProofManifest = SignupJournal;

export function signupProofEnvironment() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const dir = process.env.AUTH_PROOF_CAPTURE_DIR;
  const origin = process.env.NEXT_PUBLIC_APP_URL;
  const runNonce = process.env.SIGNUP_PROOF_RUN_NONCE;
  const runnerPid = Number(process.env.SIGNUP_PROOF_RUNNER_PID);
  if (!Number.isSafeInteger(runnerPid) || runnerPid <= 1 || !runNonce || !/^[a-f0-9]{32}$/.test(runNonce) || process.env.SIGNUP_PROOF_ENABLED !== "1" || url !== "https://emstjswhotsnyksqhqyf.supabase.co" || !key || !dir || !path.isAbsolute(dir) || !origin || !["http://localhost:3000", "http://localhost:3007", "http://localhost:3008", "http://localhost:3010"].includes(origin) || process.env.PLAYWRIGHT_BASE_URL !== origin) throw new Error("Signup proof environment refused.");
  const stat = lstatSync(dir);
  const actual = realpathSync(dir);
  const repo = realpathSync(process.cwd());
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || actual === repo || actual.startsWith(`${repo}${path.sep}`)) throw new Error("Signup proof requires a private directory outside the repository.");
  const marker = path.join(dir, "server-ready.json");
  const markerStat = lstatSync(marker);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || (markerStat.mode & 0o777) !== 0o600) throw new Error("Guarded signup server proof is unavailable.");
  const ready = JSON.parse(readFileSync(marker, "utf8")) as { origin?: string; pid?: number; wrapperPid?: number; runNonce?: string; runnerPid?: number };
  if (ready.runnerPid !== runnerPid || ready.runNonce !== runNonce || ready.origin !== origin || !Number.isInteger(ready.pid) || !Number.isInteger(ready.wrapperPid)) throw new Error("Guarded signup server proof is invalid.");
  try { process.kill(ready.pid!, 0); process.kill(ready.wrapperPid!, 0); process.kill(runnerPid, 0); } catch { throw new Error("Guarded signup server is not running."); }
  return { db: createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }), dir };
}

export async function allUsers(db: SupabaseClient): Promise<User[]> {
  const users: User[] = [];
  for (let page = 1; page <= 1000; page++) {
    const result = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (result.error) throw new Error("Auth preflight failed.");
    users.push(...result.data.users);
    if (result.data.users.length < 1000) return users;
  }
  throw new Error("Auth preflight pagination exceeded its bound.");
}

export async function rows(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<Record<string, unknown>[]> {
  const result = await query;
  if (result.error || !Array.isArray(result.data)) throw new Error("Signup proof preflight read failed.");
  return result.data as Record<string, unknown>[];
}

export async function reserveSignupProof(caseName: "draft" | "listing" | "resident"): Promise<{ manifest: SignupProofManifest; file: string }> {
  const { expect } = await import("@playwright/test");
  const captureDir = process.env.AUTH_PROOF_CAPTURE_DIR;
  if (!captureDir || !path.isAbsolute(captureDir)) throw new Error("Signup proof capture directory is unavailable.");
  await expect.poll(() => existsSync(path.join(captureDir, "server-ready.json"))).toBe(true);
  const { db, dir } = signupProofEnvironment();
  const nonce = randomBytes(16).toString("hex");
  const email = `p8-${caseName === "resident" ? "resident" : "manager"}-${nonce}-${caseName}@example.invalid`;
  const users = await allUsers(db);
  if (users.some((user) => user.email?.toLowerCase() === email)) throw new Error("Synthetic mailbox already exists.");
  const profiles = await rows(db.from("profiles").select("id").ilike("email", email));
  const purchases = await rows(db.from("manager_purchases").select("id").ilike("email", email));
  if (profiles.length || purchases.length) throw new Error("Synthetic mailbox already has records.");
  const profilePhones: string[] = [];
  for (let offset = 0; offset < 100_000; offset += 1000) {
    const batch = await rows(db.from("profiles").select("phone").range(offset, offset + 999));
    profilePhones.push(...batch.map((item) => String(item.phone ?? "").replace(/\D/g, "")));
    if (batch.length < 1000) break;
    if (offset === 99_000) throw new Error("Phone preflight pagination exceeded its bound.");
  }
  let phone = "";
  for (let number = 100; number <= 199; number++) {
    const candidate = `+12065550${number}`;
    if (users.some((user) => user.phone?.replace(/\D/g, "") === candidate.slice(1))) continue;
    const owners = await db.rpc("phone_auth_owners", { p_phone: candidate });
    if (owners.error || !Array.isArray(owners.data)) throw new Error("Phone owner preflight failed.");
    const contacts = await rows(db.from("sms_phone_contacts").select("phone_e164").eq("phone_e164", candidate));
    const digits = candidate.slice(1);
    if (!owners.data.length && !contacts.length && !profilePhones.some((value) => value === digits || value === digits.slice(1))) { phone = candidate; break; }
  }
  if (!phone) throw new Error("Reserved fictional phone range is exhausted.");
  const manifest: SignupProofManifest = { schemaVersion: 1, phase: "reserved", target: "https://emstjswhotsnyksqhqyf.supabase.co", nonce, absentBeforeSignup: true, email, phone, fullName: `P8 ${caseName} manager`, tier: caseName === "resident" ? "resident" : "pro", startedAt: new Date().toISOString() };
  const file = path.join(dir, `p8-${nonce}.manifest.json`);
  if (existsSync(file)) throw new Error("Signup proof journal already exists.");
  persistSignupJournal(file, manifest);
  return { manifest, file };
}

/** Private fail-stop inventory. Unresolved entries require investigation; they never authorize deletion. */
export function recordSignupInventory(reservation: { manifest: SignupProofManifest; file: string }, entry: NonNullable<SignupProofManifest["inventory"]>[number]): void {
  const { dir } = signupProofEnvironment();
  const { manifest, file } = reservation;
  const nonce = path.basename(file).match(/^p8-([a-f0-9]{32})\.manifest\.json$/)?.[1];
  if (!nonce || path.dirname(file) !== dir || !manifest.actorId || entry.actorId !== manifest.actorId || !entry.marker.includes(nonce) || (entry.state === "resolved" && !entry.id && !(entry.namespace === "resident-threads" && Array.isArray(entry.ids))) || (entry.state === "unresolved" && entry.id)) throw new Error("Signup inventory identity refused.");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) throw new Error("Signup inventory manifest refused.");
  manifest.inventory ??= [];
  const index = manifest.inventory.findIndex((item) => item.namespace === entry.namespace);
  if (index >= 0) {
    const existing = manifest.inventory[index]!;
    if (existing.actorId !== entry.actorId || existing.marker !== entry.marker || existing.state === "resolved") throw new Error("Signup inventory replacement refused.");
    manifest.inventory[index] = entry;
  } else manifest.inventory.push(entry);
  persistSignupJournal(file, manifest);
}

/** Complete real email registration, then exercise a captured phone challenge in a guarded subprocess. */
export async function completeSignupProof(page: import("@playwright/test").Page, reservation: { manifest: SignupProofManifest; file: string }): Promise<string> {
  const { requestManagerEmailProof, finishManagerEmailProof } = await import("./email-onboarding-e2e");
  const { reachManagerPortal } = await import("./manager-onboarding-e2e");
  const { manifest } = reservation;
  if (manifest.tier !== "pro") throw new Error("Manager proof requires a manager reservation.");
  let href: string;
  try { href = await requestManagerEmailProof(page, manifest.email, undefined, manifest.tier); }
  finally { await identifySignupActor(signupProofEnvironment().db, reservation); }
  await finishManagerEmailProof(page, href, manifest.email, manifest.fullName, manifest.phone, undefined, manifest.tier);
  manifest.registered = true; manifest.phase = "registered"; persistSignupJournal(reservation.file, manifest);
  const actorId = await captureSignupPhone(page, reservation, "manager");
  await page.goto("/portal/dashboard", { waitUntil: "domcontentloaded" });
  await reachManagerPortal(page);
  const workspaces = await page.request.get("/api/workspaces");
  if (!workspaces.ok()) throw new Error("New manager workspace could not be verified.");
  const payload = await workspaces.json() as { activeWorkspaceId?: string; workspaces?: Array<{ id: string; ownerUserId: string; owned: boolean }>; plan?: { tier?: string; unknown?: boolean } };
  if (payload.plan?.unknown !== false || payload.plan.tier !== manifest.tier || !payload.workspaces?.some((workspace) => workspace.id === payload.activeWorkspaceId && workspace.ownerUserId === manifest.actorId && workspace.owned)) throw new Error("New manager workspace or entitlement refused.");
  return actorId;
}

export async function captureSignupPhone(page: import("@playwright/test").Page, reservation: { manifest: SignupProofManifest; file: string }, continuation: "manager" | "resident"): Promise<string> {
  const { expect } = await import("@playwright/test");
  const { spawn } = await import("node:child_process");
  const { stopOwnedChild } = await import("../e2e/support/signup-proof-process.mjs");
  const { db, dir } = signupProofEnvironment();
  const { manifest, file } = reservation;
  const actorId = await identifySignupActor(db, reservation);
  if (!actorId) throw new Error("New signup identity could not be resolved exactly.");
  if (continuation === "manager") await page.getByRole("button", { name: "Go to portal", exact: true }).click();
  await expect(page).toHaveURL(/\/auth\/verify-phone(?:\?|$)/);
  const preload = path.resolve("tests/e2e/support/signup-phone-no-delivery.mjs");
  const child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", "tests/e2e/support/signup-phone-vitest.config.ts", "--maxWorkers=1"], {
    env: { ...process.env, SIGNUP_PROOF_MANIFEST: file, NODE_OPTIONS: `--import=${preload}` }, stdio: "ignore", detached: true,
  });
  let workerMarker: string | undefined;
  let markerWritten = false;
  let interrupted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => undefined;
  const stop = () => { interrupted = true; abort(); };
  try {
    // Install listeners before any operation that can fail after spawn.
    const completion = new Promise<number | null>((resolve, reject) => {
      abort = () => reject(new Error("Guarded synthetic phone proof failed."));
      child.once("error", reject); child.once("exit", resolve);
    });
    // Avoid an unhandled rejection if marker creation fails first.
    void completion.catch(() => undefined);
    if (!child.pid) throw new Error("Guarded synthetic phone process failed to start.");
    workerMarker = path.join(dir, `phone-worker-${child.pid}.json`);
    try { writeFileSync(workerMarker, JSON.stringify({ pid: child.pid, actorId, runNonce: process.env.SIGNUP_PROOF_RUN_NONCE }), { flag: "wx", mode: 0o600 }); markerWritten = true; }
    catch { throw new Error("Guarded synthetic phone process journal refused."); }
    process.on("SIGTERM", stop); process.on("SIGINT", stop);
    timer = setTimeout(stop, 60_000);
    let status: number | null;
    try { status = await completion; } catch { throw new Error("Guarded synthetic phone proof failed."); }
    if (status !== 0 || interrupted) throw new Error("Guarded synthetic phone proof failed.");
  } finally {
    if (timer) clearTimeout(timer);
    process.off("SIGTERM", stop); process.off("SIGINT", stop);
    await stopOwnedChild(child);
    if (markerWritten && workerMarker) unlinkSync(workerMarker);
  }
  manifest.phoneBound = true; manifest.phase = "phone-bound"; persistSignupJournal(file, manifest);
  return actorId;
}

export async function completeResidentSignupProof(page: import("@playwright/test").Page, reservation: { manifest: SignupProofManifest; file: string }, propertyId: string): Promise<void> {
  const { expect } = await import("@playwright/test");
  const { requestManagerEmailProof, expectVerifiedSignupEmail } = await import("./email-onboarding-e2e");
  const { manifest } = reservation;
  if (manifest.tier !== "resident") throw new Error("Resident proof requires a resident reservation.");
  let href: string;
  try { href = await requestManagerEmailProof(page, manifest.email, undefined, undefined, propertyId); }
  finally { await identifySignupActor(signupProofEnvironment().db, reservation); }
  try { await page.goto(href, { waitUntil: "domcontentloaded" }); } catch { throw new Error("Resident verification callback navigation failed."); }
  await expectVerifiedSignupEmail(page, manifest.email);
  await page.getByLabel("Full name").fill(manifest.fullName);
  await page.getByRole("textbox", { name: /phone/i }).fill(manifest.phone.slice(2));
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/auth/resident-register" && item.request().method() === "POST");
  await page.getByRole("button", { name: "Complete account" }).click();
  const result = await response;
  if (!result.ok()) throw new Error("Resident registration failed.");
  const body = result.request().postDataJSON() as { email?: string; fullName?: string; phone?: string };
  if (body.email !== manifest.email || body.fullName !== manifest.fullName || body.phone !== manifest.phone) throw new Error("Resident registration identity refused.");
  manifest.registered = true; manifest.phase = "registered"; persistSignupJournal(reservation.file, manifest);
  // Residents navigate directly; unlike managers they never render Account ready.
  await expect(page).toHaveURL(/\/auth\/verify-phone(?:\?|$)/);
  residentApplicationDestination(page.url(), process.env.NEXT_PUBLIC_APP_URL ?? "", propertyId);
  await captureSignupPhone(page, reservation, "resident");
  // Reload the observed gate with the original email-authenticated browser session.
  // Its server checks the real phone binding before continuing to the same listing.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL((url) => url.pathname === "/resident/applications/apply" && url.searchParams.get("propertyId") === propertyId);
  const roles = await page.request.get("/api/auth/portal-roles");
  const payload = await roles.json() as { roles?: string[] };
  if (!roles.ok() || payload.roles?.length !== 1 || payload.roles[0] !== "resident") throw new Error("Resident browser role proof failed.");
}
