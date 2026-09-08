/**
 * PRP-429 — Properties tab: no phantom draft, no false "Property not found."
 *
 * Drives the real portal against the dev/test project. Skipped unless
 * E2E_TESTS_ENABLED=1 (i.e. `npm run test:seed` has run), like every other
 * portal spec here.
 */
import { test, expect } from "@playwright/test";
import { signInAsManager } from "../helpers/auth";

const enabled = process.env.E2E_TESTS_ENABLED === "1";

test.describe("PRP-429 properties onboarding + detail routing", () => {
  test.skip(!enabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test("visiting Properties on an established portfolio lands on Listed and mints nothing", async ({
    page,
  }) => {
    const listedTab = page.locator('[data-attr="manager-properties-tab-listed"]');
    const draftsTab = page.locator('[data-attr="manager-properties-tab-drafts"]');
    const draftsCount = async () =>
      Number((await draftsTab.innerText()).replace(/\D/g, "") || "0");

    await signInAsManager(page);
    await page.goto("/portal/properties", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/portal\/properties\/listed$/);
    await expect(listedTab).toBeVisible({ timeout: 20_000 });

    // The chips render "0" until the portfolio sync lands, so wait for the real
    // count before reading anything — the seed decision is made at that moment.
    await expect
      .poll(async () => Number((await listedTab.innerText()).replace(/\D/g, "") || "0"), {
        timeout: 45_000,
      })
      .toBeGreaterThan(0);

    // The invariant is that VISITING creates nothing, not that this fixture
    // happens to hold zero drafts — assert the delta, so the spec survives a
    // seed that legitimately carries one.
    const before = await draftsCount();
    await page.goto("/portal/dashboard", { waitUntil: "domcontentloaded" });
    await page.goto("/portal/properties", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/portal\/properties\/listed$/);
    await expect(listedTab).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => Number((await listedTab.innerText()).replace(/\D/g, "") || "0"), {
        timeout: 45_000,
      })
      .toBeGreaterThan(0);
    expect(await draftsCount()).toBe(before);

    // And no first-listing wizard for an account that already has listings.
    await expect(page.getByRole("heading", { name: /^New listing/ })).toHaveCount(0);
  });

  test("a listing reached under the wrong stage resolves instead of 'Property not found.'", async ({
    page,
  }) => {
    await signInAsManager(page);
    await page.goto("/portal/properties/listed", { waitUntil: "domcontentloaded" });

    // Open the first listed property to learn its route key. The rows are
    // buttons with an onOpen handler, not anchors, so read the key off the URL
    // the click produces.
    const firstRow = page.locator('[data-attr="property-list-row"]').first();
    await expect(firstRow).toBeVisible({ timeout: 30_000 });
    await firstRow.click();
    await page.waitForURL(/\/portal\/properties\/listed\/[^/]+/, { timeout: 30_000 });
    const key = decodeURIComponent(
      new URL(page.url()).pathname.split("/portal/properties/listed/")[1]!.split("/")[0]!,
    );
    expect(key.length).toBeGreaterThan(0);
    await expect(page.getByText("Property not found.")).toHaveCount(0);

    // This is the post-publish URL shape: the record's id under the stage it has
    // just left. It used to render "Property not found."
    await page.goto(`/portal/properties/drafts/${key}/preview`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page).toHaveURL(
      new RegExp(`/portal/properties/listed/${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}/preview`),
      { timeout: 30_000 },
    );
    await expect(page.getByText("Property not found.")).toHaveCount(0);
  });
});
