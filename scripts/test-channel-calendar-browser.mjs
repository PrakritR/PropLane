/**
 * End-to-end channel calendar smoke via Playwright.
 * Usage: PLAYWRIGHT_BASE_URL=http://localhost:3010 node scripts/test-channel-calendar-browser.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.PLAYWRIGHT_BASE_URL?.trim() || "http://localhost:3010";
const PROPERTY_ID = "mgr-seed-5259-brooklyn-ave-ne";
const BOOKING_CALENDARS_PATH = `/portal/properties/listed/${encodeURIComponent(PROPERTY_ID)}/calendar/bookings`;
const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL?.trim() || "manager@test.proplane.local";
const MANAGER_PASSWORD = process.env.E2E_MANAGER_PASSWORD?.trim() || "TestManager123!";

async function signInManager(page) {
  await page.goto(`${BASE}/auth/sign-in?next=${encodeURIComponent("/portal/dashboard")}`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByPlaceholder("Email").fill(MANAGER_EMAIL);
  await page.getByPlaceholder("Password").fill(MANAGER_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForTimeout(3000);

  await page.goto(`${BASE}/auth/choose-portal?next=${encodeURIComponent(BOOKING_CALENDARS_PATH)}`, {
    waitUntil: "domcontentloaded",
  });
  const propertyPortal = page.getByRole("button", { name: /^Property/ });
  await propertyPortal.waitFor({ timeout: 45_000 });
  await propertyPortal.click();
  await page.waitForURL((url) => url.pathname.includes("/portal/"), { timeout: 45_000 });

  await page.goto(`${BASE}${BOOKING_CALENDARS_PATH}`, { waitUntil: "domcontentloaded" });
  const heading = page.getByRole("heading", { name: "Channel calendars" });
  if (!(await heading.isVisible().catch(() => false))) {
    await page.screenshot({ path: "/tmp/channel-calendar-debug.png", fullPage: true });
    console.log("Debug screenshot:", "/tmp/channel-calendar-debug.png");
    console.log("Landed on:", page.url());
    const bodySnippet = (await page.locator("main").innerText().catch(() => "")).slice(0, 500);
    console.log("Main snippet:", bodySnippet);
  }
  await heading.scrollIntoViewIfNeeded();
  await heading.waitFor({ timeout: 45_000 });
}

async function testProplaneFlow(page) {
  console.log("\n=== PropLane: Channel calendars ===");

  const saveBtn = page.locator('[data-attr^="channel-calendar-save-"]').first();
  await saveBtn.scrollIntoViewIfNeeded();

  const [saveRes] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/portal/channel-calendar/connections") && r.request().method() === "POST",
      { timeout: 20_000 },
    ),
    saveBtn.click(),
  ]);
  const saveBody = await saveRes.json();
  console.log("Save status:", saveRes.status(), saveBody.error ?? "ok");

  if (!saveRes.ok()) throw new Error(saveBody.error ?? "Save failed");

  const exportUrl = saveBody.connection?.exportUrl;
  console.log("Export URL:", exportUrl);

  const icsRes = await page.request.get(exportUrl);
  const icsText = await icsRes.text();
  console.log("Export feed status:", icsRes.status(), icsText.includes("BEGIN:VCALENDAR") ? "valid ICS" : icsText.slice(0, 80));

  return exportUrl;
}

async function findAirbnbCalendarTab(browser) {
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      const url = page.url();
      if (/airbnb\.(com|ca)/i.test(url) && /calendar|hosting|multicalendar/i.test(url)) {
        return page;
      }
      if (/airbnb\.(com|ca)/i.test(url)) {
        return page;
      }
    }
  }
  return null;
}

async function tryAirbnbExportUrl(airbnbPage) {
  console.log("\n=== Airbnb tab ===");
  console.log("Current URL:", airbnbPage.url());

  const exportSelectors = [
    'text=Export calendar',
    'text=Export Calendar',
    'button:has-text("Export")',
    '[data-testid*="export"]',
  ];

  for (const sel of exportSelectors) {
    const el = airbnbPage.locator(sel).first();
    if (await el.count()) {
      console.log("Found export control:", sel);
      try {
        await el.click({ timeout: 5000 });
        await airbnbPage.waitForTimeout(2000);
      } catch {
        /* continue */
      }
    }
  }

  const icalLink = airbnbPage.locator('a[href*="calendar/ical"], input[value*="calendar/ical"]').first();
  if (await icalLink.count()) {
    const href =
      (await icalLink.getAttribute("href")) ||
      (await icalLink.getAttribute("value")) ||
      (await icalLink.inputValue().catch(() => ""));
    if (href) {
      console.log("Airbnb iCal URL found:", href.slice(0, 80) + "...");
      return href;
    }
  }

  const bodyText = await airbnbPage.locator("body").innerText();
  const match = bodyText.match(/https:\/\/www\.airbnb\.com\/calendar\/ical\/[^\s]+/i);
  if (match) {
    console.log("Airbnb iCal URL in page text:", match[0].slice(0, 80) + "...");
    return match[0];
  }

  console.log("Could not auto-extract Airbnb export URL — navigate to Listing → Availability → Export calendar.");
  return null;
}

async function syncImportUrl(page, importUrl) {
  console.log("\n=== Sync Airbnb import ===");
  const input = page.locator('[data-attr^="channel-calendar-import-"]').first();
  await input.fill(importUrl);
  await page.locator('[data-attr^="channel-calendar-save-"]').first().click();
  await page.waitForResponse(
    (r) => r.url().includes("/api/portal/channel-calendar/connections") && r.request().method() === "POST",
    { timeout: 20_000 },
  );

  const [syncRes] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/portal/channel-calendar/sync") && r.request().method() === "POST",
      { timeout: 60_000 },
    ),
    page.locator('[data-attr^="channel-calendar-sync-"]').first().click(),
  ]);
  const syncBody = await syncRes.json();
  console.log("Sync status:", syncRes.status(), syncBody.error ?? syncBody.connection);
}

async function main() {
  let browser;
  let connectedCdp = false;

  try {
    browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
    connectedCdp = true;
    console.log("Connected to your Chrome via CDP.");
  } catch {
    console.log("CDP unavailable — launching headed Chromium (sign in to Airbnb manually if needed).");
    browser = await chromium.launch({ headless: false, slowMo: 100 });
  }

  const context = connectedCdp
    ? browser.contexts()[0] ?? (await browser.newContext())
    : await browser.newContext();

  const proplanePage = await context.newPage();
  await signInManager(proplanePage);
  const exportUrl = await testProplaneFlow(proplanePage);

  const airbnbPage = (await findAirbnbCalendarTab(browser)) ?? (connectedCdp ? null : await context.newPage());
  if (airbnbPage && !airbnbPage.url().includes("airbnb")) {
    await airbnbPage.goto("https://www.airbnb.com/hosting/calendar", { waitUntil: "domcontentloaded" });
  }

  let importUrl = null;
  if (airbnbPage) {
    importUrl = await tryAirbnbExportUrl(airbnbPage);
  }

  if (importUrl) {
    await syncImportUrl(proplanePage, importUrl);
    console.log("\n✅ Full round-trip attempted (save + export + Airbnb import + sync).");
  } else {
    console.log("\n⚠️ PropLane export works. Paste Airbnb export URL into Room 1 manually, then Sync now.");
    console.log("PropLane export URL for Airbnb Import calendar:\n", exportUrl);
  }

  if (!connectedCdp) {
    console.log("\nBrowser left open 30s for inspection…");
    await proplanePage.waitForTimeout(30_000);
    await browser.close();
  }
}

main().catch(async (e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
