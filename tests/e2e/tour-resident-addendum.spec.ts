/**
 * Addendum verification against a running dev server (e.g. localhost:3013).
 */
import { test, expect } from "@playwright/test";
import { CANONICAL_RESIDENT_TOUR } from "../helpers/seed-canonical-resident-tour.mjs";
import { signInAsResident } from "../helpers/auth";
import { signInSeededStageResident } from "../helpers/seeded-resident-stage-e2e";

test.describe("Tour-resident addendum verification", () => {
  test("req 5: signed-in resident application opens on routed detail page", async ({ page }) => {
    const fixture = await signInSeededStageResident(page, "signed");
    const approved = await page.evaluate(async (expectedId) => {
      const res = await fetch("/api/manager-applications?scope=self", { credentials: "include" });
      if (!res.ok) throw new Error("Owned applications could not load.");
      const body = (await res.json()) as { rows?: { id: string; bucket: string; property: string }[] };
      return (body.rows ?? []).find((row) => row.id === expectedId && row.bucket === "approved") ?? null;
    }, fixture.axisId);
    expect(approved).toBeTruthy();
    expect(approved!.property).toBeTruthy();
    const approvedId = approved!.id;

    await page.goto(`/resident/applications/approved/${encodeURIComponent(approvedId!)}`);
    await expect(page.getByText("Application not found.")).not.toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(approved!.property, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(new RegExp(`/resident/applications/approved/${approvedId}`));
  });

  test("req 4: resident Communication shows tour/prospect thread after backfill", async ({ page }) => {
    await signInAsResident(page);
    // Derive the intended conversation from an actual subject-bound tour,
    // rather than prose left by a historical manual verification.
    const toursResponse = await page.request.get("/api/portal-resident-tours");
    expect(toursResponse.ok()).toBe(true);
    const toursPayload = await toursResponse.json() as { tours?: { inquiryId: string; propertyId: string; managerUserId: string }[] };
    expect(toursPayload.tours?.length, "Canonical resident must have a linked seeded tour").toBeGreaterThan(0);
    const tour = toursPayload.tours!.find((row) => row.inquiryId === CANONICAL_RESIDENT_TOUR.inquiryId);
    expect(tour, "Exact bounded canonical tour must be present alongside other tour history").toBeTruthy();
    expect(tour!.propertyId).toBe(CANONICAL_RESIDENT_TOUR.propertyId);
    expect(tour!.managerUserId).toBeTruthy();
    const threadResponse = await page.request.get(`/api/portal-resident-tours/thread?inquiryId=${encodeURIComponent(tour!.inquiryId)}`);
    expect(threadResponse.ok()).toBe(true);
    const { threadId } = await threadResponse.json() as { threadId: string | null };
    expect(threadId, "The linked tour must resolve its resident/manager conversation").toBe(CANONICAL_RESIDENT_TOUR.residentThreadId);
    const inboxResponse = await page.request.get("/api/portal-inbox-threads?scope=resident");
    expect(inboxResponse.ok()).toBe(true);
    const inbox = await inboxResponse.json() as { rows?: { id: string; messages?: { body: string }[] }[] };
    const thread = inbox.rows?.find((row) => row.id === threadId);
    expect(thread, "The resolved tour thread must be in this resident's scoped inbox").toBeTruthy();
    const message = thread!.messages?.find((item) => item.body?.trim());
    expect(message, "The tour conversation must contain a real stored turn").toBeTruthy();
    await page.goto(`/resident/communication/active/${encodeURIComponent(threadId!)}`);
    await expect(page).toHaveURL((url) => url.pathname.endsWith(encodeURIComponent(threadId!)) || decodeURIComponent(url.pathname).endsWith(threadId!));
    await expect(page.getByText(message!.body, { exact: true }).first()).toBeVisible();
  });
});
