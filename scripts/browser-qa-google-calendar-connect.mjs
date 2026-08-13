#!/usr/bin/env node
/**
 * Browser QA: manager Google Calendar connect starts OAuth with a registered redirect URI.
 *
 *   node scripts/browser-qa-google-calendar-connect.mjs
 *   BASE_URL=http://localhost:3011 node scripts/browser-qa-google-calendar-connect.mjs
 */
import { chromium } from "playwright";

const BASE_URL = (process.env.BASE_URL || "http://localhost:3011").replace(/\/$/, "");
const EMAIL = process.env.E2E_MANAGER_EMAIL || "manager@test.proplane.local";
const PASSWORD = process.env.E2E_MANAGER_PASSWORD || "TestManager123!";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(`${BASE_URL}/auth/sign-in?next=${encodeURIComponent("/auth/connect-google-services")}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.getByRole("textbox", { name: /email/i }).fill(EMAIL, { timeout: 60_000 });
  await page.getByRole("textbox", { name: /password/i }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/auth\/connect-google-services/, { timeout: 60_000 });

  const connectBtn = page.getByRole("button", { name: /Connect Calendar/i });
  await connectBtn.waitFor({ state: "visible", timeout: 30_000 });
  const disabled = await connectBtn.isDisabled();
  if (disabled) {
    throw new Error("Connect Calendar is disabled — Google OAuth not configured on this server.");
  }

  await Promise.all([
    page.waitForURL(/accounts\.google\.com/, { timeout: 30_000 }),
    connectBtn.click(),
  ]);
  const url = new URL(page.url());
  const redirectUri = url.searchParams.get("redirect_uri");
  console.log("Google OAuth redirect_uri:", redirectUri);

  if (!redirectUri) {
    throw new Error("Google authorize URL missing redirect_uri");
  }

  if (BASE_URL.includes("prop-lane.space")) {
    const allowed = [
      "https://prop-lane.space/api/portal/google-calendar/callback",
      "https://www.prop-lane.space/api/portal/google-calendar/callback",
      "https://www.axis-seattle-housing.com/api/portal/google-calendar/callback",
      "https://axis-seattle-housing.com/api/portal/google-calendar/callback",
    ];
    if (!allowed.includes(redirectUri)) {
      throw new Error(`Unexpected production redirect_uri: ${redirectUri}`);
    }
  } else if (redirectUri.includes("prop-lane.space") && BASE_URL.includes("localhost")) {
    throw new Error(`Local dev must not send prop-lane.space redirect_uri: ${redirectUri}`);
  }

  console.log("OK — Google Calendar connect reached Google with a valid redirect_uri.");
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
