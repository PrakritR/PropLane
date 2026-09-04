import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { E2E_ACCOUNTS } from "../fixtures";
import { establishActivePortal, signIn } from "../helpers/auth";

/**
 * Legacy nav/redirect sweep.
 *
 * Every entry below is a URL a bookmark, push notification, or external link can
 * still hold. The contract is: it must never dead-end on a 404 — it either renders
 * or redirects to a tab that actually exists. Covers next.config.ts `redirects()`
 * (resident /home) and the legacy tab maps in src/lib/render-portal-section.tsx
 * (manager financials/documents), neither of which any other suite exercises.
 */

const EVIDENCE_DIR =
  process.env.NAV_SWEEP_EVIDENCE_DIR ?? path.resolve(__dirname, "../../.nav-sweep-evidence");

function shot(name: string) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  return path.join(EVIDENCE_DIR, `${name}.png`);
}

/**
 * Password sign-in, then pin the active portal so protected routes do not bounce
 * through /auth/continue mid-navigation.
 */
async function signInForNavSweep(
  page: Page,
  role: "manager" | "resident" | "admin" | "vendor",
  email: string,
  password: string,
  next: string,
) {
  await signIn(page, email, password, next);
  await establishActivePortal(page, role, next);
}

type Landing = {
  requested: string;
  status: number | null;
  /** Every path the browser was sent through, in order, including `requested`. */
  chain: string[];
  finalPath: string;
  isNotFound: boolean;
};

async function land(page: Page, requested: string, screenshotName?: string): Promise<Landing> {
  const response = await page.goto(requested, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.getByRole("heading").first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});

  const chain: string[] = [];
  for (let req = response?.request() ?? null; req; req = req.redirectedFrom()) {
    chain.unshift(new URL(req.url()).pathname);
  }
  const finalPath = new URL(page.url()).pathname;
  if (chain[chain.length - 1] !== finalPath) chain.push(finalPath);

  const isNotFound = await page
    .getByText(/This page could not be found/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (screenshotName) {
    await page.screenshot({ path: shot(screenshotName), fullPage: false, timeout: 10_000 }).catch(() => {});
  }
  return { requested, status: response?.status() ?? null, chain, finalPath, isNotFound };
}

test.describe("legacy nav redirects land on a real page", () => {
  test("resident /home legacy redirect lands on the resident dashboard", async ({ page }) => {
    await signInForNavSweep(
      page,
      "resident",
      E2E_ACCOUNTS.resident.email,
      E2E_ACCOUNTS.resident.password,
      "/resident/dashboard",
    );

    const bare = await land(page, "/resident/home", "resident-home-redirect");
    const deep = await land(page, "/resident/home/anything", "resident-home-deep-redirect");
    console.log("[resident] " + JSON.stringify([bare, deep], null, 2));

    for (const landing of [bare, deep]) {
      // The next.config redirect target itself: it must be the real resident home,
      // not the `properties` section that no longer exists. Anything after that hop
      // is the resident access gate, which is allowed to move an unapproved
      // applicant on to their application.
      expect
        .soft(landing.chain, `${landing.requested} must redirect to /resident/dashboard`)
        .toContain("/resident/dashboard");
      expect.soft(landing.chain, `${landing.requested} must not target the removed properties section`).not.toContain(
        "/resident/properties",
      );
      expect.soft(landing.isNotFound, `${landing.requested} must not 404`).toBe(false);
    }
  });

  test("manager legacy financials/documents tabs land on a real tab", async ({ page }) => {
    await signInForNavSweep(
      page,
      "manager",
      E2E_ACCOUNTS.manager.email,
      E2E_ACCOUNTS.manager.password,
      "/portal/dashboard",
    );

    const results: Landing[] = [];
    // Controls: legacy entries that already worked before this branch.
    results.push(await land(page, "/portal/financials/rent-roll", "manager-rent-roll"));
    results.push(await land(page, "/portal/documents/summary"));
    results.push(await land(page, "/portal/documents/profit-loss"));
    // The two entries this branch is supposed to fix.
    results.push(await land(page, "/portal/financials/delinquency", "manager-delinquency"));
    results.push(await land(page, "/portal/financials/lease-expiration", "manager-lease-expiration"));
    // Inherited Object.prototype keys must stay a 404, not a garbage redirect.
    results.push(await land(page, "/portal/financials/toString", "manager-tostring"));

    console.log("[manager] " + JSON.stringify(results, null, 2));

    const byPath = new Map(results.map((r) => [r.requested, r]));
    expect.soft(byPath.get("/portal/financials/rent-roll")!.finalPath).toBe("/portal/financials/income");
    expect.soft(byPath.get("/portal/documents/summary")!.finalPath).toBe("/portal/documents/tax-summary");
    expect.soft(byPath.get("/portal/documents/profit-loss")!.finalPath).toBe("/portal/financials/expenses");

    const delinquency = byPath.get("/portal/financials/delinquency")!;
    expect.soft(delinquency.isNotFound, "/portal/financials/delinquency must not 404").toBe(false);
    expect.soft(delinquency.finalPath).toBe("/portal/financials/income");

    const leaseExpiration = byPath.get("/portal/financials/lease-expiration")!;
    expect.soft(leaseExpiration.isNotFound, "/portal/financials/lease-expiration must not 404").toBe(false);
    expect.soft(leaseExpiration.finalPath).toBe("/portal/documents/income-documents");

    // Prototype keys are not legacy tabs.
    expect.soft(byPath.get("/portal/financials/toString")!.isNotFound).toBe(true);
  });

  /**
   * Tabs that stopped existing tonight.
   *
   * Admin Communication was five URL folder tabs over a panel that had already
   * stopped reading which one was in the URL, and vendor Documents was four
   * category tabs a vendor had to classify into before uploading. Both
   * collapsed. Every one of those URLs is still in somebody's bookmark bar or
   * an old email, so the contract is the same as every other entry here: it
   * renders or it redirects, it never dead-ends.
   */
  test("admin Communication folder tabs still resolve after collapsing to one inbox", async ({ page }) => {
    await signInForNavSweep(
      page,
      "admin",
      E2E_ACCOUNTS.admin.email,
      E2E_ACCOUNTS.admin.password,
      "/admin/dashboard",
    );

    const results: Landing[] = [];
    // The section's own path must RENDER, not bounce to a folder that is gone.
    results.push(await land(page, "/admin/communication", "admin-communication"));
    for (const legacy of ["unopened", "opened", "sent", "trash", "schedule"]) {
      results.push(await land(page, `/admin/communication/inbox/${legacy}`));
    }

    console.log("[admin] " + JSON.stringify(results, null, 2));

    for (const r of results) {
      expect.soft(r.isNotFound, `${r.requested} must not 404`).toBe(false);
    }
    // The bare section is the inbox now; it must not redirect away from itself.
    expect.soft(new Map(results.map((r) => [r.requested, r])).get("/admin/communication")!.finalPath).toBe(
      "/admin/communication",
    );
  });

  test("vendor Documents category tabs land on the one list", async ({ page }) => {
    await signInForNavSweep(
      page,
      "vendor",
      E2E_ACCOUNTS.vendor.email,
      E2E_ACCOUNTS.vendor.password,
      "/vendor/dashboard",
    );

    const results: Landing[] = [];
    results.push(await land(page, "/vendor/documents/mine", "vendor-documents-mine"));
    results.push(await land(page, "/vendor/documents/shared"));
    for (const legacy of ["tax", "insurance", "licensing"]) {
      results.push(await land(page, `/vendor/documents/${legacy}`));
    }

    console.log("[vendor] " + JSON.stringify(results, null, 2));

    const byPath = new Map(results.map((r) => [r.requested, r]));
    for (const r of results) {
      expect.soft(r.isNotFound, `${r.requested} must not 404`).toBe(false);
    }
    for (const legacy of ["tax", "insurance", "licensing"]) {
      expect
        .soft(byPath.get(`/vendor/documents/${legacy}`)!.finalPath, `${legacy} should land on Mine`)
        .toBe("/vendor/documents/mine");
    }
  });
});
