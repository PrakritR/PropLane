import { test, expect } from "@playwright/test";
import { signInAsManager, signInAsResident } from "../helpers/auth";
import { ownedPublicProperty } from "../helpers/owned-public-property-e2e";
import { formatAvailabilitySlotLabel } from "../../src/lib/demo-admin-scheduling";
import { pacificCalendarDateYmd } from "../../src/lib/pacific-time";

const portalTestsEnabled = process.env.E2E_TESTS_ENABLED === "1";

test.describe("Tour scheduling", () => {
  test.skip(!portalTestsEnabled, "Set E2E_TESTS_ENABLED=1 after running npm run test:seed");

  test("signed-out tour selection reaches account choices with its exact return context", async ({ page, request }) => {
    const property = await ownedPublicProperty(request, { requiresTourSelection: true });
    await page.context().clearCookies();
    const writes: string[] = [];
    page.on("request", (outgoing) => {
      if (outgoing.method() !== "GET" && /\/api\/(public\/(?:partner-inquiries|property-lead-message)|portal-resident-tours)/.test(outgoing.url())) {
        writes.push(`${outgoing.method()} ${new URL(outgoing.url()).pathname}`);
      }
    });
    const availability = page.waitForResponse((response) =>
      response.url().includes("/api/public/property-tour-availability?") && response.request().method() === "GET",
    );
    await page.goto(`/rent/tours-contact?propertyId=${encodeURIComponent(property.id)}`);
    const response = await availability;
    expect(response.ok()).toBe(true);
    const { slotHosts } = await response.json() as { slotHosts: Record<string, unknown[]> };
    await expect(page.getByText(property.title, { exact: true }).first()).toBeVisible();
    await expect(page.locator('[data-attr="tour-account-step"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /schedule as a guest/i })).toHaveCount(0);

    const room = page.getByRole("combobox", { name: "Room" });
    await expect(room, "The owned fixture must offer a choice of rooms").toBeVisible();
    const roomValue = await room.locator("option").nth(1).getAttribute("value");
    expect(roomValue?.startsWith(`${property.id}::`)).toBe(true);
    await room.selectOption(roomValue!);
    const roomId = roomValue!.slice(`${property.id}::`.length);

    const day = page.getByRole("group", { name: "Open days" }).getByRole("button").first();
    await expect(day).toHaveAttribute("aria-label", /open for tours$/);
    const dayLabel = (await day.getAttribute("aria-label"))!.replace(" — open for tours", "");
    const matchingSlots = Object.entries(slotHosts).filter(([key, hosts]) => {
      const [date] = key.split(":");
      const [year, month, dateOfMonth] = date.split("-").map(Number);
      const label = new Date(year, month - 1, dateOfMonth, 12).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
      return hosts.length > 0 && date >= pacificCalendarDateYmd() && label === dayLabel;
    }).sort(([a], [b]) => a.split(":")[0].localeCompare(b.split(":")[0]) || Number(a.split(":")[1]) - Number(b.split(":")[1]));
    expect(matchingSlots.length, "The owned fixture must have a published open slot").toBeGreaterThan(0);
    const slotKey = matchingSlots[0][0];
    await day.click();
    await page.getByRole("button", { name: formatAvailabilitySlotLabel(Number(slotKey.split(":")[1])), exact: true }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const account = page.locator('[data-attr="tour-account-step"]');
    await expect(account).toBeVisible();
    for (const selector of ['[data-attr="tour-account-email"]', '[data-attr="tour-step-sign-in"]']) {
      const link = account.locator(selector);
      await expect(link).toBeVisible();
      const href = new URL((await link.getAttribute("href"))!, "http://localhost");
      const next = new URL(href.searchParams.get("next")!, "http://localhost");
      expect(next.pathname).toBe("/resident/tour/schedule");
      expect(Object.fromEntries(next.searchParams)).toEqual({ propertyId: property.id, slot: slotKey, room: roomId });
    }
    expect(writes).toEqual([]);
    const refused = await request.post("/api/public/partner-inquiries", { data: { row: { kind: "tour", propertyId: property.id } } });
    expect(refused.status()).toBe(401);
    expect((await refused.json()).reason).toBe("sign_in_required");
  });

  test("tours-contact message requires an account and opens the resident composer after sign-in", async ({ page, request }) => {
    const property = await ownedPublicProperty(request);
    const target = `/rent/tours-contact?propertyId=${encodeURIComponent(property.id)}&tab=message`;
    await page.context().clearCookies();
    await page.goto(target);
    await expect(page.getByRole("heading", { name: "Create your resident account", exact: true })).toBeVisible();
    await expect(page.locator('[data-attr="prospect-message-create-account"]')).toBeVisible();
    await expect(page.locator('[data-attr="property-lead-message-send"]')).toHaveCount(0);
    await signInAsResident(page);
    await page.goto(target);
    await expect(page).toHaveURL(/\/resident\/communication\/active/);
    const composer = page.getByRole("dialog", { name: "New message", exact: true });
    await expect(composer).toBeVisible();
    await expect(composer.getByPlaceholder("Write your message…")).toBeVisible();
    await composer.getByPlaceholder("Write your message…").fill("Question about this home's availability.");
    await expect(composer.locator('[data-attr="communication-compose-send"]')).toBeVisible();
  });

  test("signed-in resident reaches the valid listing tour form", async ({ page, request }) => {
    const property = await ownedPublicProperty(request);
    await signInAsResident(page);
    await page.goto(`/rent/tours-contact?propertyId=${encodeURIComponent(property.id)}`);
    await expect(page).toHaveURL((url) => url.pathname === "/resident/tour/schedule" && url.searchParams.get("propertyId") === property.id);
    await expect(page.getByRole("heading", { name: "Schedule tour", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
    await expect(page.getByText("This listing is not available to tour right now.", { exact: true })).toHaveCount(0);
  });

  test("an invalid public property link refuses tour and message entry", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/rent/tours-contact?propertyId=e2e-missing-public-property");
    await expect(page.getByText("Manager link required", { exact: true })).toBeVisible();
    await expect(page.locator('[data-attr="prospect-tour-create-account"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^continue$/i })).toHaveCount(0);
  });

  test("manager calendar page shows calendar controls", async ({ page }) => {
    await signInAsManager(page);
    await page.goto("/portal/calendar/tours");
    await expect(page).toHaveURL(/\/portal\/calendar\/tours/);
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Previous week" }).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("manager calendar shows upcoming events section", async ({ page }) => {
    await signInAsManager(page);
    await page.goto("/portal/calendar/tours");
    await expect(page).toHaveURL(/\/portal\/calendar\/tours/);
    await expect(page.getByRole("heading").first()).toBeVisible({ timeout: 15_000 });
    // Calendar grid or schedule view should be present
    const calEl = page
      .locator("table, .calendar, .fc, [data-testid='calendar']")
      .or(page.getByText(/schedule|upcoming|tour/i))
      .first();
    await expect(calEl).toBeVisible({ timeout: 15_000 });
  });

  test("public tours page renders", async ({ page, request }) => {
    const property = await ownedPublicProperty(request);
    await page.goto(`/rent/tours-contact?propertyId=${encodeURIComponent(property.id)}`);
    // Should not crash
    const errorEl = page.getByText(/something went wrong|500/i);
    await expect(errorEl).not.toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("heading").first()).toBeVisible();
  });
});
