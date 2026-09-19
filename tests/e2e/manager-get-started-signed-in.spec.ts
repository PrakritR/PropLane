import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { E2E_ACCOUNTS } from "../fixtures";
import { completeManagerSignupOnboarding } from "../helpers/manager-onboarding-e2e";
import {
  createOwnedManagerSignup,
  submitOwnedManagerRegistration,
} from "../helpers/owned-manager-signup-e2e";

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
async function sessionEmailFromCookies(page: Page): Promise<string | null> {
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
    return (JSON.parse(json) as { user?: { email?: string } }).user?.email ?? null;
  } catch {
    return null;
  }
}

/**
 * The manager submit button names what the click will do, and that differs by
 * session: an anonymous visitor CREATES an account, while someone already
 * signed in is adding the property-manager role to the account they have
 * (`manager-trial-signup-form.tsx`: `signedInUser ? "Set up property manager" :
 * "Create property account"`). Asserting one label for both states is what made
 * the signed-in cases fail.
 */
function managerSubmitButton(page: Page) {
  return page.locator('[data-attr="manager-trial-signup-submit"]').filter({ visible: true });
}

async function expectManagerCreateForm(page: Page, opts: { signedIn: boolean }) {
  await expect(page.getByPlaceholder("Full name")).toBeVisible();
  await expect(page.getByPlaceholder("Email")).toBeVisible();
  await expect(page.getByPlaceholder("Phone number")).toBeVisible();
  await expect(page.getByPlaceholder("Phone number")).toBeRequired();
  await expect(page.getByPlaceholder(/Password \(8\+/)).toBeVisible();
  await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
  await expect(managerSubmitButton(page)).toHaveText(
    opts.signedIn ? "Set up property manager" : "Create property account",
  );
}

test.describe('"Get started" while signed in', () => {
  test.skip(!hasSupabase, "Requires the dev/test Supabase project");

  test("signed-in manager reaching Start free can still create another account", async ({ page }) => {
    await signIn(page, E2E_ACCOUNTS.manager.email, E2E_ACCOUNTS.manager.password);

    // Enter from the marketing home page exactly like an end user would.
    await page.goto("/");
    const cta = page.getByRole("link", { name: /start free/i }).first();
    // PRP-307: a plain "Start free" asks who you are instead of assuming a
    // manager, so the CTA points at the bare create surface and the role is
    // chosen on the next screen.
    await expect(cta).toHaveAttribute("href", "/auth/create-account");
    const [response] = await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      cta.click(),
    ]);
    await page.waitForLoadState("networkidle").catch(() => {});

    const chain = redirectChain(response, page.url());
    // No silent bounce to a portal — the create surface always loads.
    expect(chain.join(" -> ")).not.toMatch(/\/portal/);
    expect(new URL(page.url()).pathname).toBe("/auth/create-account");

    // The role chooser, then the manager form — signed-in users can still
    // register a new email, and no step bounces them into a portal.
    await expect(page.getByRole("heading", { name: /create your account/i })).toBeVisible();
    await page.getByRole("button", { name: /^property/i }).first().click();
    await expectManagerCreateForm(page, { signedIn: true });

    await page.screenshot({ path: shot("signed-in-get-started"), fullPage: true });
    console.log(`redirect chain (signed in): ${chain.join(" -> ")}`);
  });

  test("signed-out Start free is unchanged: manager trial signup form, no notice", async ({ page }) => {
    await page.goto("/auth/create-account?mode=create&role=manager");
    await page.waitForLoadState("networkidle").catch(() => {});
    await expectManagerCreateForm(page, { signedIn: false });
    await expect(page.getByText(/you're signed in as/i)).toHaveCount(0);
    await page.screenshot({ path: shot("signed-out-get-started"), fullPage: true });
  });

  test("role=resident opens generic signup then portal chooser (no setup-link block)", async ({ page }) => {
    await page.goto("/auth/create-account?mode=create&role=resident");
    await page.waitForLoadState("networkidle").catch(() => {});
    await expect(page.getByPlaceholder("Full name")).toBeVisible();
    await expect(page.getByPlaceholder("Email")).toBeVisible();
    await expect(page.getByRole("button", { name: /create account/i })).toBeVisible();
    await expect(page.getByText(/setup link/i)).toHaveCount(0);
    await page.screenshot({ path: shot("resident-self-serve"), fullPage: true });
  });

  test("signed-in manager can create a SECOND account with a different email", async ({ page }) => {
    await signIn(page, E2E_ACCOUNTS.manager.email, E2E_ACCOUNTS.manager.password);

    const account = await createOwnedManagerSignup("get-started-e2e");
    try {
      await page.goto("/auth/create-account?mode=create&role=manager");
      await expectManagerCreateForm(page, { signedIn: true });

      await page.getByPlaceholder("Full name").fill(account.fullName);
      await page.getByPlaceholder("Email").fill(account.email);
      await page.getByPlaceholder("Phone number").fill(account.phone);
      await page.getByPlaceholder(/Password \(8\+/).fill(account.password);
      await page.screenshot({ path: shot("signed-in-filled-new-account"), fullPage: true });

      await submitOwnedManagerRegistration(page, managerSubmitButton(page), account);
      await page.waitForURL(/\/auth\/(get-started|manager\/choose-plan|connect-google-services)|\/portal/, { timeout: 60_000 });
      await completeManagerSignupOnboarding(page);
      await page.waitForLoadState("networkidle").catch(() => {});

      // The browser session is now the NEW account, not the seeded manager.
      const sessionEmail = await sessionEmailFromCookies(page);
      expect(sessionEmail).toBe(account.email);
      await expect(page).toHaveURL(/\/portal/);
      await page.screenshot({ path: shot("new-account-portal"), fullPage: true });
    } finally {
      try {
        await page.close({ runBeforeUnload: false });
      } finally {
        await account.cleanup();
      }
    }
  });
});
