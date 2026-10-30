import { expect, test, type Page, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { E2E_ACCOUNTS } from "../fixtures";
import { requestManagerEmailProof, finishManagerEmailProof } from "../helpers/email-onboarding-e2e";
import { reserveSyntheticManager, identifySyntheticManager, captureSyntheticManagerChildren, cleanupSyntheticManager } from "../helpers/synthetic-manager-cleanup";
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
    test.setTimeout(180_000);
    await signIn(page, E2E_ACCOUNTS.manager.email, E2E_ACCOUNTS.manager.password);

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
      await page.goto("/auth/create-account?mode=create&role=manager&tier=pro&billing=annual");
      await expectManagerCreateForm(page, { signedIn: true });
      await page.getByRole("button", { name: "Create a different property account" }).click();
      await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
      expect(await sessionUserFromCookies(page)).toBeNull();
      const href = await requestManagerEmailProof(page, newEmail);
      const pendingId = await identifySyntheticManager(db, supabaseUrl, manifest, manifestFile);
      secondContext = await page.context().browser()!.newContext();
      const secondPage = await secondContext.newPage();
      await finishManagerEmailProof(secondPage, href, newEmail, "Second Account Manager", "2065550199");
      const newUser = await sessionUserFromCookies(secondPage);
      expect(newUser?.email).toBe(newEmail);
      syntheticAccessToken = newUser?.accessToken ?? null;
      expect(newUser?.id).toBe(pendingId);
      expect(newUser?.id).not.toBe(oldUser!.id);
      await captureSyntheticManagerChildren(db, manifest, manifestFile);
      const newRoles = await db.from("profile_roles").select("role").eq("user_id", newUser!.id);
      const newProperties = await db.from("manager_property_records").select("id").eq("manager_user_id", newUser!.id);
      const oldRolesAfter = await db.from("profile_roles").select("role").eq("user_id", oldUser!.id);
      expect(newRoles.error).toBeNull(); expect(newProperties.error).toBeNull(); expect(oldRolesAfter.error).toBeNull();
      expect(newRoles.data).toContainEqual({ role: "manager" });
      expect(newProperties.data).toEqual([]);
      expect(oldRolesAfter.data).toEqual(oldRoles.data);
      await expect(secondPage.getByRole("button", { name: "Go to portal" })).toBeVisible();
      await secondPage.getByRole("button", { name: "Go to portal" }).click();
      await secondPage.waitForURL(/\/portal/, { timeout: 60_000 });
      await expect(secondPage.getByRole("heading", { name: "Dashboard" })).toBeVisible();
      await expect(secondPage.getByText("No properties yet.")).toBeVisible();
    } finally {
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
      if (secondContext) await secondContext.close();
      await page.context().close();
      if (revokeFailed) throw new Error("Synthetic session could not be revoked; cleanup was not attempted.");
      await cleanupSyntheticManager(db, supabaseUrl, manifest, manifestFile);
      fs.rmSync(path.join(dir, `${createHash("sha256").update(newEmail).digest("hex")}.json`), { force: true });
    }

  });
});
