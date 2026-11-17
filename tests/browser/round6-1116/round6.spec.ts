/**
 * Round 6 (plan p0-fixes-1116) in a real browser with the real Tailwind CSS: the REAL dashboard
 * KPI tiles / Needs attention panel and the REAL tour confirm dialog are bundled and
 * screenshotted. Only routing, analytics, the assistant strip and the deliver-via / work-number
 * reads are stubbed (`stubs.tsx`).
 *
 * What is asserted and captured:
 *  - A read that has not answered draws no figure: a skeleton, never "0%" / "$0" / "0", and the
 *    attention panel never says "Nothing is waiting" yet.
 *  - A failed read draws "—" with "Unavailable · Retry", and Retry is a real control.
 *  - Once every source answered, the honest zero is drawn.
 *  - The tour confirm dialog names the guest and lists their email AND phone, where it used to
 *    show the raw address as the recipient.
 */
import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const SHOTS = process.env.ROUND6_SHOT_DIR ?? path.resolve("tests/browser/round6-1116/shots");
const DESKTOP = { width: 1280, height: 860 };

let javascript: string;
let css: string;

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
  const stubs = path.resolve("tests/browser/round6-1116/stubs.tsx");
  const aliases = Object.fromEntries(
    [
      "components/portal/modal-assistant-strip",
      "hooks/use-work-assignment-directory",
      "hooks/use-portal-session",
      "hooks/use-manager-user-id",
      "lib/analytics/track-client",
      "lib/axis-assistant/portal-assistant-context",
    ].map((name) => ["@/" + name, stubs]),
  );
  const bundle = await build({
    entryPoints: ["tests/browser/round6-1116/fixture.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    alias: { ...aliases, "posthog-js": stubs, "next/navigation": stubs },
    define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
  });
  javascript = bundle.outputFiles[0]!.text;
  const cssPath = path.resolve("src/app/globals.css");
  css = (await postcss([tailwind()]).process(await readFile(cssPath, "utf8"), { from: cssPath })).css;
});

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.log("pageerror:", error.message));
  await page.addInitScript(() => {
    if (!crypto.randomUUID)
      Object.defineProperty(crypto, "randomUUID", {
        value: () => "00000000-0000-4000-8000-" + String(Math.random()).slice(2, 14).padEnd(12, "0"),
      });
  });
  await page.route("http://round6.test/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/fixture.js")
      return route.fulfill({ contentType: "application/javascript", body: javascript });
    if (url.pathname === "/app.css") return route.fulfill({ contentType: "text/css", body: css });
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html data-theme="light"><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
    });
  });
  // Every other portal read answers "nothing here", in the shapes their callers expect.
  await page.route("**/api/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        rows: [], messages: [], items: [], threads: [], contacts: [], residents: [], vendors: [],
        properties: [], relationships: [], people: [], settings: {}, ok: true,
      }),
    }),
  );
});

async function open(page: Page, which: string, size = DESKTOP) {
  await page.setViewportSize(size);
  await page.goto(`http://round6.test/?case=${which}`);
  await page.waitForTimeout(400);
}

test("a dashboard read that has not answered draws no zero", async ({ page }) => {
  await open(page, "dash-loading");
  for (const zero of ["0%", "$0", "0"]) await expect(page.getByText(zero, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("status", { name: "Loading Occupancy" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading needs attention" })).toBeVisible();
  await expect(page.getByText(/Nothing is waiting/)).toHaveCount(0);
  await expect(page.locator('[data-attr="dashboard-kpi-occupancy"]')).toHaveAttribute("data-read-state", "loading");
  await page.screenshot({ path: `${SHOTS}/dashboard-loading.png` });
});

test("a failed dashboard read draws a dash with Unavailable and a working Retry", async ({ page }) => {
  await open(page, "dash-failed");
  for (const zero of ["0%", "$0", "0"]) await expect(page.getByText(zero, { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-attr="dashboard-kpi-collected"]').getByText("—")).toBeVisible();
  await expect(page.locator('[data-attr="dashboard-read-unavailable"]').first()).toBeVisible();
  // One per tile plus the attention panel.
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(5);
  await expect(page.getByText(/Nothing is waiting/)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/dashboard-failed-retry.png` });
});

test("an answered zero is drawn, and an answered empty queue says so", async ({ page }) => {
  await open(page, "dash-ready-empty");
  await expect(page.getByText("0%", { exact: true })).toBeVisible();
  await expect(page.getByText("$0", { exact: true })).toBeVisible();
  await expect(page.getByText("Nothing is waiting on you. Nice.")).toBeVisible();
  await expect(page.locator('[data-attr="dashboard-read-unavailable"]')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/dashboard-ready-honest-zero.png` });

  await open(page, "dash-ready");
  await expect(page.getByText("3 applications ready to review")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/dashboard-ready-rows.png` });
});

test("the tour confirm dialog names the guest and lists email and phone", async ({ page }) => {
  await open(page, "tour-before");
  const before = page.getByRole("dialog");
  await expect(before).toBeVisible();
  // Before: the raw address was the whole "Recipient" fact.
  await expect(before.getByText("Recipient")).toBeVisible();
  await expect(before.getByText("Gabriel Guest")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/tour-confirm-before.png` });

  await open(page, "tour-after");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Gabriel Guest").first()).toBeVisible();
  await expect(dialog.getByText("Email", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText("gabriel@example.com").first()).toBeVisible();
  await expect(dialog.getByText("+1 (206) 555-0100").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/tour-confirm-names-guest.png` });
});

/* ───────────────────────── manager inbox: Send is never silent ───────────────────────── */

const PHONE_THREAD = {
  id: "thread-sms-1",
  folder: "inbox",
  from: "+1 (206) 555-0100",
  email: "",
  subject: "Is the Brooklyn room still open?",
  preview: "Is the Brooklyn room still open?",
  body: "Is the Brooklyn room still open?",
  time: "Nov 16, 9:12 AM",
  unread: true,
  messages: [
    {
      id: "m1",
      direction: "in",
      body: "Is the Brooklyn room still open?",
      at: "2026-11-16T17:12:00.000Z",
      channel: "sms",
    },
  ],
};
const NO_CHANNEL_THREAD = {
  ...PHONE_THREAD,
  id: "thread-nochannel-1",
  from: "Walk-in guest",
  subject: "Left a note at the door",
  preview: "Left a note at the door",
  body: "Left a note at the door",
  messages: [{ id: "m1", direction: "in", body: "Left a note at the door", at: "2026-11-16T17:12:00.000Z" }],
};

async function openInbox(page: Page, which: string, rows: unknown[], sendStatus = 500) {
  await page.route("**/api/portal-inbox-threads**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ rows }) }),
  );
  // The real send routes (email/in-app and the work-number text), refusing the way an outage does.
  for (const url of ["**/api/portal/send-inbox-message**", "**/api/manager/sms-conversations**"]) {
    await page.route(url, (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: sendStatus, contentType: "application/json", body: JSON.stringify({ error: "The carrier rejected this text" }) })
        : route.fulfill({ contentType: "application/json", body: JSON.stringify({ rows: [], conversations: [] }) }),
    );
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`http://round6.test/portal/inbox?case=${which}`);
  await page.waitForTimeout(1200);
}

test("a reply the server refuses is answered on screen, never swallowed", async ({ page }) => {
  await openInbox(page, "inbox-phone", [PHONE_THREAD]);
  await page.getByText("Is the Brooklyn room still open?").first().click();
  await page.waitForTimeout(500);
  const composer = page.locator("textarea").first();
  await composer.fill("Yes — want to come see it Friday?");
  await page.screenshot({ path: `${SHOTS}/inbox-phone-only-composer.png` });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForTimeout(1500);
  // The reason is on screen (the toast beside the composer), and the draft stays.
  await expect(page.getByText(/The carrier rejected this text/).first()).toBeVisible();
  await expect(composer).toHaveValue("Yes — want to come see it Friday?");
  await page.screenshot({ path: `${SHOTS}/inbox-send-failure-is-visible.png` });
});

test("a conversation with no email and no phone says so instead of nothing", async ({ page }) => {
  await openInbox(page, "inbox-unreachable", [NO_CHANNEL_THREAD]);
  await page.getByText("Left a note at the door").first().click();
  await page.waitForTimeout(500);
  const composer = page.locator("textarea").first();
  await composer.fill("Stopping by at 4pm.");
  await page.getByRole("button", { name: /^Send$/ }).first().click();
  await page.waitForTimeout(900);
  await expect(page.getByText(/no email or phone yet/).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/inbox-unreachable-reason.png` });
});
