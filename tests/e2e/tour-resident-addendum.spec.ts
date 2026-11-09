/**
 * Addendum verification against a running dev server (e.g. localhost:3013).
 */
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { signInAsResident } from "../helpers/auth";
import { cleanupSyntheticPublicTourManager, createSyntheticPublicTourManager } from "../helpers/synthetic-public-tour-manager";
import { syntheticFixtureActorId } from "../helpers/synthetic-property-e2e";

const residentInboxScope = "axis_portal_inbox_resident_v1";
type TourFixture = { propertyId: string; propertyName: string; actorId: string; managerPage: Page; managerContext: BrowserContext; inquiryId?: string; residentThreadId?: string };
const tourFixtures = new WeakMap<object, TourFixture>();

test.describe("Tour-resident addendum verification", () => {
  test("req 5: signed-in resident application opens on routed detail page", async ({ page }) => {
    await signInAsResident(page);
    // The label comes from the SAME row the route is built from. It used to be hard-coded to
    // one seeded listing's name after picking an arbitrary approved application, so the test
    // passed or failed on which seed happened to come back first.
    const approved = await page.evaluate(async () => {
      const res = await fetch("/api/manager-applications?scope=self", { credentials: "include" });
      const body = (await res.json()) as { rows?: Array<{ id: string; bucket: string; property?: string; propertyName?: string }> };
      const row = (body.rows ?? []).find((item) => item.bucket === "approved");
      return row ? { id: row.id, property: (row.property ?? row.propertyName ?? "").trim() } : null;
    });
    expect(approved?.id).toBeTruthy();
    expect(approved?.property, "the approved application must name its property").toBeTruthy();

    await page.goto(`/resident/applications/approved/${encodeURIComponent(approved!.id)}`);
    await expect(page.getByText("Application not found.")).not.toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(approved!.property).first()).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(new RegExp(`/resident/applications/approved/${approved!.id}`));

    // The negative stays: an id that is not this resident's own is not found.
    await page.goto("/resident/applications/approved/AXIS-does-not-exist");
    await expect(page.getByText("Application not found.")).toBeVisible({ timeout: 20_000 });
  });

  test("resident Communication shows the thread for a linked tour request", async ({ browser, page }) => {
    test.setTimeout(180_000);
    test.skip(process.env.E2E_TESTS_ENABLED !== "1", "Requires the isolated dev/test E2E server.");
    const manager = await createSyntheticPublicTourManager(browser);
    const property = manager.property;
    const fixture: TourFixture = {
      propertyId: property.id,
      propertyName: property.name,
      actorId: manager.actorId,
      managerPage: manager.page,
      managerContext: manager.context,
    };
    tourFixtures.set(page, fixture);

    // The public owner must be a non-sandbox synthetic account so production-mode
    // localhost applies the same listing projection as the public site.
    await page.context().clearCookies();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await signInAsResident(page);
    await page.goto(`/rent/tours-contact?propertyId=${encodeURIComponent(property.id)}`);

    // An authenticated resident is routed to the embedded portal calendar,
    // whose month-grid buttons use the same offered-slot contract without the
    // public journey's `Open days` group.
    const offeredDay = page.getByRole("button", { name: /request a tour$/i }).first();
    await expect(offeredDay).toBeVisible({ timeout: 25_000 });
    await offeredDay.click();
    // The authenticated resident path renders the embedded portal calendar, not the public
    // `.ps-j-times` markup. Its actual offered slots are named buttons such as "8:00 AM".
    const firstTime = page.getByRole("button", { name: /^\d{1,2}:\d{2} [AP]M$/ }).first();
    await expect(firstTime).toBeVisible({ timeout: 10_000 });
    await firstTime.click();
    await page.getByRole("button", { name: "Continue", exact: true }).last().click();

    const booking = page.locator('[data-attr="tour-book-submit"]');
    await expect(booking).toBeVisible({ timeout: 15_000 });
    const marker = property.name;
    const createResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST" && url.pathname === "/api/public/partner-inquiries";
    }, { timeout: 30_000 });
    await booking.click();
    const result = await createResponse;
    expect(result.status()).toBe(200);
    const responseBody = await result.json() as { row?: { id?: string } };
    expect(responseBody.row?.id).toBeTruthy();
    fixture.inquiryId = responseBody.row!.id!;
    await expect(page.getByRole("heading", { name: "Your tour request is in", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-attr="tour-request-not-confirmed-notice"]')).toBeVisible();

    await page.goto("/resident/communication");
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 20_000 });
    const inbox = await page.request.get(`/api/portal-inbox-threads?scope=${residentInboxScope}`);
    expect(inbox.ok()).toBe(true);
    const inboxBody = await inbox.json() as { rows?: Array<{ id?: string; body?: string; messages?: Array<{ text?: string; body?: string }> }> };
    const matchingThread = (inboxBody.rows ?? []).find((row) =>
      row.body?.includes(marker) || row.messages?.some((message) => `${message.text ?? ""} ${message.body ?? ""}`.includes(marker)),
    );
    expect(matchingThread?.id).toBeTruthy();
    fixture.residentThreadId = matchingThread!.id!;
    const threadRow = page.locator(".portal-inbox-row").filter({ hasText: marker });
    await expect(threadRow).toHaveCount(1, { timeout: 20_000 });
    await expect(threadRow).toBeVisible({ timeout: 20_000 });
    await threadRow.click();
    await expect(page.getByText(marker, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  });

  test.afterEach(async ({ page }) => {
    const fixture = tourFixtures.get(page);
    if (!fixture) return;
    await page.context().clearCookies();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await signInAsResident(page);
    if (fixture.residentThreadId) {
      const deletedThread = await page.request.post(`/api/portal-inbox-threads?scope=${residentInboxScope}`, {
        data: { action: "delete", id: fixture.residentThreadId },
      });
      if (!deletedThread.ok()) throw new Error(`Linked tour inbox cleanup failed (HTTP ${deletedThread.status()}).`);
      const readback = await page.request.get(`/api/portal-inbox-threads?scope=${residentInboxScope}`);
      if (!readback.ok()) throw new Error("Linked tour inbox cleanup read failed.");
      const body = await readback.json() as { rows?: Array<{ id?: string }> };
      if ((body.rows ?? []).some((row) => row.id === fixture.residentThreadId)) throw new Error("Linked tour inbox thread remained after cleanup.");
    }
    const managerPage = fixture.managerPage;
    await managerPage.goto("/portal/properties", { waitUntil: "domcontentloaded" });
    if (fixture.actorId !== await syntheticFixtureActorId(managerPage) || !fixture.propertyId.startsWith("e2e-safe-") || !fixture.propertyName.startsWith("E2E Safe ")) {
      throw new Error("Linked tour fixture cleanup ownership mismatch.");
    }
    if (fixture.inquiryId) {
      const deletedInquiry = await managerPage.request.post("/api/portal-tour-inquiries/delete", {
        data: { id: fixture.inquiryId, notifyTenant: false, purge: true },
      });
      if (!deletedInquiry.ok()) throw new Error(`Linked tour inquiry cleanup failed (HTTP ${deletedInquiry.status()}).`);
      const deletedBody = await deletedInquiry.json() as { removedIds?: string[] };
      if (!deletedBody.removedIds?.includes(fixture.inquiryId)) throw new Error("Linked tour inquiry cleanup did not report the exact inquiry as removed.");
      const scheduleRead = await managerPage.request.get("/api/portal-schedule-records");
      if (!scheduleRead.ok()) throw new Error(`Linked tour inquiry readback failed (HTTP ${scheduleRead.status()}).`);
      const scheduleBody = await scheduleRead.json() as { rows?: Array<{ id?: string; payload?: Array<{ id?: string }> }> };
      const inquiryRows = scheduleBody.rows?.find((row) => row.id === "axis_admin_partner_inquiries_v1")?.payload ?? [];
      if (inquiryRows.some((row) => row.id === fixture.inquiryId)) throw new Error("Linked tour inquiry remained after cleanup.");
    }
    await cleanupSyntheticPublicTourManager({
      page: managerPage,
      context: fixture.managerContext,
      property: { id: fixture.propertyId, name: fixture.propertyName },
      actorId: fixture.actorId,
    });
    tourFixtures.delete(page);
  });
});
