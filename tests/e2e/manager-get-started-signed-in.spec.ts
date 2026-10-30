import { expect, test, type Page, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { E2E_ACCOUNTS } from "../fixtures";
import { requestManagerEmailProof, finishManagerEmailProof } from "../helpers/email-onboarding-e2e";
import { reserveSyntheticManager, identifySyntheticManager } from "../helpers/synthetic-manager-cleanup";
import { createHash } from "node:crypto";

/**
 * "Get started" must always open the manager create-account form — even when a
 * Supabase session already exists. The regression this covers: a signed-in user
 * used to get a single "Create property account" button that converted their
 * CURRENT session and bounced them to /portal/dashboard, so creating a second
 * account with a different email was impossible.
 *
 * Requires the dev/test Supabase project (see tests/fixtures) and a running app.
 */

const EVIDENCE_DIR =
  process.env.GET_STARTED_EVIDENCE_DIR ?? path.resolve(__dirname, "../../.get-started-evidence");

function shot(name: string) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  return path.join(EVIDENCE_DIR, `${name}.png`);
}

// Verification URLs contain single-use secrets; do not retain browser traces or videos.
test.use({ trace: "off", video: "off", screenshot: "off" });

const hasSupabase = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/auth/sign-in");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect
    .poll(
      async () =>
        (await page.context().cookies()).some((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name)),
      { timeout: 30_000 },
    )
    .toBe(true);
}

/** Every path the browser was routed through for the last navigation, in order. */
function redirectChain(response: Awaited<ReturnType<Page["goto"]>>, finalUrl: string): string[] {
  const chain: string[] = [];
  for (let req = response?.request() ?? null; req; req = req.redirectedFrom()) {
    chain.unshift(new URL(req.url()).pathname + new URL(req.url()).search);
  }
  const final = new URL(finalUrl).pathname + new URL(finalUrl).search;
  if (chain[chain.length - 1] !== final) chain.push(final);
  return chain;
}

/** Email on the Supabase session the browser currently holds (chunked auth cookie). */
async function sessionUserFromCookies(page: Page): Promise<{ id: string; email: string; accessToken: string } | null> {
  const cookies = await page.context().cookies();
  const chunks = cookies
    .filter((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => decodeURIComponent(c.value))
    .join("");
  if (!chunks) return null;
  const json = chunks.startsWith("base64-")
    ? Buffer.from(chunks.slice("base64-".length), "base64").toString("utf8")
    : chunks;
  try {
    const parsed = JSON.parse(json) as { access_token?: string; user?: { id?: string; email?: string } };
    const user = parsed.user;
    return user?.id && user.email && parsed.access_token ? { id: user.id, email: user.email, accessToken: parsed.access_token } : null;
  } catch {
    return null;
  }
}

async function expectManagerCreateForm(page: Page, opts: { signedIn: boolean }) {
  if (opts.signedIn) {
    await expect(page.getByText(/Verified email:/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Create a different property account" })).toBeVisible();
  } else {
    await expect(page.getByRole("heading", { name: "Create your property account" })).toBeVisible();
    await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with email" })).toBeVisible();
  }
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
}

async function closeContextIfOpen(context: BrowserContext | null) {
  if (!context) return;
  try {
    await context.close();
  } catch (error) {
    // Playwright closes fixture contexts when a test timeout fires. Do not let
    // that teardown error replace the original timeout/assertion failure.
    if (!/Target page, context or browser has been closed/i.test(String((error as Error).message))) {
      throw error;
    }
  }
}

async function boundedDiagnostic<T>(read: Promise<T>, fallback: T, timeoutMs = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    read.catch(() => fallback),
    new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

test.describe('"Get started" while signed in', () => {
  test.skip(!hasSupabase, "Requires the dev/test Supabase project");

  test("signed-in manager reaching Get started can still create another account", async ({ page }) => {
    await signIn(page, E2E_ACCOUNTS.manager.email, E2E_ACCOUNTS.manager.password);

    // Enter from the marketing home page exactly like an end user would.
    await page.goto("/");
    const cta = page.getByRole("link", { name: /start free/i }).first();
    // This manager CTA declares the role explicitly.
    await expect(cta).toHaveAttribute("href", "/auth/create-account?mode=create&role=manager");
    const [response] = await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      cta.click(),
    ]);

    const chain = redirectChain(response, page.url());
    // No silent bounce to a portal — the create surface always loads.
    expect(chain.join(" -> ")).not.toMatch(/\/portal/);
    expect(new URL(page.url()).pathname).toBe("/auth/create-account");

    // The declared manager intent opens the current account form directly.
    await expectManagerCreateForm(page, { signedIn: true });

    await page.screenshot({ path: shot("signed-in-get-started"), fullPage: true });
    console.log(`redirect chain (signed in): ${chain.join(" -> ")}`);
  });

  test("signed-out Get started is unchanged: manager trial signup form, no notice", async ({ page }) => {
    await page.goto("/auth/create-account?mode=create&role=manager");
    await expectManagerCreateForm(page, { signedIn: false });
    await expect(page.getByText(/you're signed in as/i)).toHaveCount(0);
    await page.screenshot({ path: shot("signed-out-get-started"), fullPage: true });
  });

  test("role=resident opens generic signup then portal chooser (no setup-link block)", async ({ page }) => {
    await page.goto("/auth/create-account?mode=create&role=resident");
    await expect(page.getByRole("heading", { name: "Create your resident account" })).toBeVisible();
    await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with email" })).toBeVisible();
    await expect(page.getByText(/setup link/i)).toHaveCount(0);
    await page.screenshot({ path: shot("resident-self-serve"), fullPage: true });
  });

  test("signed-in manager can create a SECOND account with a different email", async ({ page }) => {
    test.skip(process.env.AUTH_PROOF_TWO_PHASE_RUNNER !== "1", "Dedicated two-phase proof required");
    test.setTimeout(90_000);
    let phase = "sign-in";
    let lastHttpStatus: number | null = null;
    let completed = false;
    const setPhase = (next: string, httpStatus?: number) => {
      phase = next;
      if (httpStatus !== undefined) lastHttpStatus = httpStatus;
      console.log(`[synthetic-manager-e2e] phase=${next} last_http_status=${lastHttpStatus ?? "not-observed"}`);
    };
    setPhase("sign-in");
    await signIn(page, E2E_ACCOUNTS.manager.email, E2E_ACCOUNTS.manager.password);

    setPhase("inspect-current-account");
    const oldUser = await sessionUserFromCookies(page);
    expect(oldUser?.email).toBe(E2E_ACCOUNTS.manager.email);
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (supabaseUrl !== "https://emstjswhotsnyksqhqyf.supabase.co" || !serviceKey) throw new Error("This synthetic proof requires the DEV project and service role.");
    const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const oldRoles = await db.from("profile_roles").select("role").eq("user_id", oldUser!.id);
    const oldProperties = await db.from("manager_property_records").select("id").eq("manager_user_id", oldUser!.id);
    expect(oldRoles.error).toBeNull(); expect(oldProperties.error).toBeNull();
    const newEmail = `get-started-e2e-${Date.now()}@example.invalid`;
    const dir = process.env.AUTH_PROOF_CAPTURE_DIR;
    if (!dir || !path.isAbsolute(dir)) throw new Error("Private signup proof directory is required.");
    const manifestFile = path.join(dir, `manager-${createHash("sha256").update(newEmail).digest("hex")}.manifest.json`);
    const manifest = await reserveSyntheticManager(db, supabaseUrl, newEmail, manifestFile);
    let syntheticAccessToken: string | null = null;
    let secondContext: BrowserContext | null = null;
    try {
      setPhase("open-create-account");
      await page.goto("/auth/create-account?mode=create&role=manager&tier=pro&billing=annual");
      await expectManagerCreateForm(page, { signedIn: true });
      setPhase("sign-out-current-session");
      await page.getByRole("button", { name: "Create a different property account" }).click();
      await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
      expect(await sessionUserFromCookies(page)).toBeNull();
      const href = await requestManagerEmailProof(page, newEmail, setPhase);
      setPhase("identify-pending-auth-user");
      const pendingId = await identifySyntheticManager(db, supabaseUrl, manifest, manifestFile);
      setPhase("create-verification-context");
      secondContext = await page.context().browser()!.newContext();
      secondContext.setDefaultTimeout(20_000);
      secondContext.setDefaultNavigationTimeout(20_000);
      const secondPage = await secondContext.newPage();
      const authResponses: Array<{ path: string; status: number }> = [];
      secondPage.on("response", (response) => {
        const pathname = new URL(response.url()).pathname;
        if (["/auth/confirm", "/api/auth/email-onboarding/finish", "/api/auth/email-onboarding/continue"].includes(pathname)) {
          authResponses.push({ path: pathname, status: response.status() });
        }
      });
      try {
        await finishManagerEmailProof(secondPage, href, newEmail, "Second Account Manager", "2065550199", setPhase);
      } catch (error) {
        const pathname = new URL(secondPage.url()).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id");
        console.error(`[synthetic-manager-e2e] failure_snapshot phase=${phase} pathname=${pathname} last_http_status=${lastHttpStatus ?? "not-observed"}`);
        const knownHeadings = ["Create your property account", "Check your email", "Account ready", "Request a new verification link", "Could not complete verification", "Link invalid"];
        const headings = (await boundedDiagnostic(secondPage.getByRole("heading").allTextContents(), []))
          .map((value) => value.trim())
          .filter((value) => knownHeadings.includes(value));
        const knownAlerts = ["This link has expired", "This link is invalid", "Email verified", "Something went wrong", "Could not continue account setup. Refresh to try again."];
        const alerts = (await boundedDiagnostic(secondPage.locator('[role="alert"]').allTextContents(), []))
          .map((value) => value.trim())
          .filter((value) => knownAlerts.includes(value));
        const identity = manifest.authId ? await boundedDiagnostic(db.auth.admin.getUserById(manifest.authId), null) : null;
        const handoffs = manifest.authId
          ? await boundedDiagnostic(Promise.resolve(db.from("email_onboarding_handoffs").select("intent,status,expires_at").eq("user_id", manifest.authId).limit(3)), null)
          : null;
        const diag = {
          pathname,
          headings,
          alerts,
          authResponses,
          authUser: identity === null ? { read: "timeout-or-error" } : identity.data.user ? {
            exists: true,
            emailConfirmed: Boolean(identity.data.user.email_confirmed_at),
            lastSignInPresent: Boolean(identity.data.user.last_sign_in_at),
          } : { exists: false, errorCode: identity?.error?.code ?? null },
          handoffRows: handoffs === null ? { read: "timeout-or-error" } : handoffs.error
            ? { errorCode: handoffs.error.code ?? "unknown" }
            : (handoffs.data ?? []).map((row) => ({ intent: row.intent, status: row.status, expired: Date.parse(row.expires_at) <= Date.now() })),
        };
        console.error(`[synthetic-manager-e2e] callback_diagnostic=${JSON.stringify(diag)}`);
        throw error;
      }
      setPhase("verify-new-session-subject");
      const newUser = await sessionUserFromCookies(secondPage);
      expect(newUser?.email).toBe(newEmail);
      syntheticAccessToken = newUser?.accessToken ?? null;
      expect(newUser?.id).toBe(pendingId);
      expect(newUser?.id).not.toBe(oldUser!.id);
      setPhase("inspect-created-account");
      const newRoles = await db.from("profile_roles").select("role").eq("user_id", newUser!.id);
      const newProperties = await db.from("manager_property_records").select("id").eq("manager_user_id", newUser!.id);
      const oldRolesAfter = await db.from("profile_roles").select("role").eq("user_id", oldUser!.id);
      expect(newRoles.error).toBeNull(); expect(newProperties.error).toBeNull(); expect(oldRolesAfter.error).toBeNull();
      expect(newRoles.data).toContainEqual({ role: "manager" });
      expect(newProperties.data).toEqual([]);
      expect(oldRolesAfter.data).toEqual(oldRoles.data);
      setPhase("portal-continuation");
      await expect(secondPage.getByRole("button", { name: "Go to portal" })).toBeVisible();
      await secondPage.getByRole("button", { name: "Go to portal" }).click();
      await secondPage.waitForURL(/\/auth\/verify-phone/, { timeout: 60_000 });
      await expect(secondPage.getByRole("button", { name: /send.*code/i })).toBeVisible();
      completed = true;
    } finally {
      if (!completed) console.error(`[synthetic-manager-e2e] failed_phase=${phase} last_http_status=${lastHttpStatus ?? "not-observed"}`);
      setPhase("cleanup");
      try {
        let revokeFailed = false;
        if (!syntheticAccessToken && secondContext) {
          for (const candidate of secondContext.pages()) {
            const session = await sessionUserFromCookies(candidate);
            if (session?.id === manifest.authId && session.email === newEmail) syntheticAccessToken = session.accessToken;
            else if (session) revokeFailed = true;
          }
        }
        if (syntheticAccessToken) {
          const revoked = await db.auth.admin.signOut(syntheticAccessToken, "global");
          revokeFailed ||= Boolean(revoked.error);
        }
        await closeContextIfOpen(secondContext);
        await closeContextIfOpen(page.context());
        if (revokeFailed) throw new Error("Synthetic session could not be revoked; cleanup was not attempted.");
        // Dedicated runner stops its server before reviewing and cleaning this exact manifest.
      } catch {
        console.error("[synthetic-manager-e2e] failed_phase=cleanup");
        throw new Error("Synthetic manager cleanup failed; inspect the private manifest before any retry.");
      }
    }

  });
});
