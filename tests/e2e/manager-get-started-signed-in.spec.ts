import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { E2E_ACCOUNTS } from "../fixtures";

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

async function expectManagerCreateForm(page: Page) {
  await expect(page.getByPlaceholder("Full name")).toBeVisible();
  await expect(page.getByPlaceholder("Email")).toBeVisible();
  await expect(page.getByPlaceholder("Phone number")).toBeVisible();
  await expect(page.getByPlaceholder(/Password \(8\+/)).toBeVisible();
  await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /create property account/i })).toBeVisible();
}

test.describe('"Get started" while signed in', () => {
  test.skip(!hasSupabase, "Requires the dev/test Supabase project");

  test("signed-in manager reaching Get started can still create another account", async ({ page }) => {
    await signIn(page, E2E_ACCOUNTS.manager.email, E2E_ACCOUNTS.manager.password);

    // Enter from the marketing home page exactly like an end user would.
    await page.goto("/");
    const cta = page.getByRole("link", { name: /get started/i }).first();
    await expect(cta).toHaveAttribute("href", "/auth/create-account?mode=create&role=manager");
    const [response] = await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      cta.click(),
    ]);
    await page.waitForLoadState("networkidle").catch(() => {});

    const chain = redirectChain(response, page.url());
    // No silent bounce to a portal — the create surface always loads.
    expect(chain.join(" -> ")).not.toMatch(/\/portal/);
    expect(new URL(page.url()).pathname).toBe("/auth/create-account");

    // Generic account creation — no role toggle; signed-in users can still register a new email.
    await expectManagerCreateForm(page);

    await page.screenshot({ path: shot("signed-in-get-started"), fullPage: true });
    console.log(`redirect chain (signed in): ${chain.join(" -> ")}`);
  });

  test("signed-out Get started is unchanged: manager trial signup form, no notice", async ({ page }) => {
    await page.goto("/auth/create-account?mode=create&role=manager");
    await page.waitForLoadState("networkidle").catch(() => {});
    await expectManagerCreateForm(page);
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

    const newEmail = `get-started-e2e-${Date.now()}@test.proplane.local`;
    await page.goto("/auth/create-account?mode=create&role=manager");
    await expectManagerCreateForm(page);

    await page.getByPlaceholder("Full name").fill("Second Account Manager");
    await page.getByPlaceholder("Email").fill(newEmail);
    await page.getByPlaceholder("Phone number").fill("2065550199");
    await page.getByPlaceholder(/Password \(8\+/).fill("SecondAcct123!");
    await page.screenshot({ path: shot("signed-in-filled-new-account"), fullPage: true });

    await page.getByRole("button", { name: /create property account/i }).click();
    await page.waitForURL(/\/portal/, { timeout: 60_000 });
    await page.waitForLoadState("networkidle").catch(() => {});

    // The browser session is now the NEW account, not the one we signed in as.
    const sessionEmail = await sessionEmailFromCookies(page);
    expect(sessionEmail).toBe(newEmail);
    // ...and the portal it opened belongs to the new (empty) account.
    await expect(page.getByText(/welcome, second account manager/i)).toBeVisible();
    console.log(`created + signed in as new account: ${sessionEmail} at ${page.url()}`);
    await page.screenshot({ path: shot("new-account-portal"), fullPage: true });
  });
});
