#!/usr/bin/env node
// Re-shoot and re-frame the App Store screenshots under app-store/screenshots/.
//
// Signs in to a LOCAL dev server as the seeded manager, screenshots each store
// screen on the iPhone 6.9" and iPad 13" viewports, and frames every shot with
// its headline in PropLane's own font. The output is exactly what
// scripts/ios-app-store-release.mjs uploads on the next production push, so run
// this whenever a screen on the list changes, look at the PNGs, and commit them.
//
//   npm run app-store:shots -- --base http://localhost:3000            # both devices
//   npm run app-store:shots -- --base http://localhost:3000 --device iphone
//   SHOT_EMAIL=… SHOT_PASSWORD=… npm run app-store:shots -- --base …    # another manager
//
// It refuses a manager with fewer than three properties: an empty gallery on the
// store is worse than a stale one, and the assets test refuses a wrong pixel size.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright";

const REPO = resolve(new URL("..", import.meta.url).pathname);
const FONT = pathToFileURL(resolve(REPO, "src/app/fonts/schibsted-grotesk-variable.woff2")).href;
const OUT_ROOT = resolve(REPO, "app-store/screenshots");
const MIN_PROPERTIES = 3;

/** Apple's display classes. The 6.9" and 13" sets are reused for every smaller device. */
export const DEVICES = Object.freeze({
  iphone: {
    folder: "iphone-6.9",
    display: "APP_IPHONE_67",
    viewport: { width: 440, height: 956 },
    scale: 3,
    isMobile: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    frame: { copyTop: 54, h1: 31, p: 16, pMax: 350, phoneTop: 194, phoneWidth: 376, radius: 46, pad: 9, screenRadius: 38 },
  },
  ipad: {
    folder: "ipad-13",
    display: "APP_IPAD_PRO_3GEN_129",
    viewport: { width: 1032, height: 1376 },
    scale: 2,
    isMobile: false,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    frame: { copyTop: 96, h1: 64, p: 30, pMax: 760, phoneTop: 360, phoneWidth: 900, radius: 54, pad: 18, screenRadius: 38 },
  },
});

/**
 * The gallery, in store order. `route` is what gets shot; `headline`/`sub` is the
 * framed copy; `dark` picks the blue background. Apple shows at most ten, and the
 * first three are the install sheet.
 */
export const GALLERY = Object.freeze([
  { file: "01-rent-by-the-room", route: "/portal/properties/listed", headline: "Rent by the room.", sub: "List a whole home or each room — see 3 of 4 open at a glance.", dark: true },
  { file: "02-dashboard", route: "/portal/dashboard", headline: "Your rooms, your rent, one screen.", sub: "Occupancy, rent collected, and what needs you today." },
  { file: "03-applications", route: "/portal/applications/pending", headline: "Applications for every room.", sub: "Screen, approve, and place applicants room by room." },
  { file: "04-residents", route: "/portal/residents/current", headline: "Every resident, every room.", sub: "Who lives where — from move-in to move-out." },
  { file: "05-payments", route: "/portal/payments/incoming/pending", headline: "Rent collected per room.", sub: "Move-in totals, automatic reminders, every charge tracked." },
  { file: "06-leases", route: "/portal/leases", headline: "Leases signed in-app.", sub: "Draft, send, and countersign — one lease per room." },
  { file: "07-tours", route: "/portal/tours/pending", headline: "Tours booked for you.", sub: "Prospects pick a time. You just show up." },
  { file: "08-inspections", route: "/portal/inspections/move-in", headline: "Move-in photos, per room.", sub: "Residents document their room. You keep the record." },
  { file: "09-inbox", route: "/portal/communication/active", headline: "One inbox for everyone.", sub: "Residents, applicants, and your PropLane assistant." },
  { file: "10-list-a-room", route: "wizard:rooms", headline: "Set up every room in minutes.", sub: "Residents, bathroom, furnishing — set once, then per room.", dark: true },
]);

const HIDE_CSS =
  "nextjs-portal{display:none!important} .portal-banner-danger{display:none!important}";

/**
 * A portal page paints its shell first and its rows a moment later (skeletons
 * while the store syncs). Shooting on a fixed pause captured skeletons on a cold
 * server, so wait for the network to go quiet and the skeletons to leave.
 */
async function settle(page, { maxMs = 20_000 } = {}) {
  await page.waitForLoadState("networkidle", { timeout: maxMs }).catch(() => {});
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxMs) {
    const busy = await page.locator(".animate-pulse, [aria-busy=true]").count();
    if (busy === 0) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1500);
}

function parseArgs(argv) {
  const out = { base: "", device: "both", out: OUT_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    if (arg === "--base") out.base = next();
    else if (arg.startsWith("--base=")) out.base = arg.slice(7);
    else if (arg === "--device") out.device = next();
    else if (arg.startsWith("--device=")) out.device = arg.slice(9);
    else if (arg === "--out") out.out = resolve(next());
    else if (arg.startsWith("--out=")) out.out = resolve(arg.slice(6));
  }
  if (!out.base) throw new Error("Pass --base <url of a running dev server>, e.g. --base http://localhost:3000");
  if (!["both", "iphone", "ipad"].includes(out.device)) throw new Error(`--device must be iphone, ipad or both (got ${out.device})`);
  return out;
}

export function frameHtml({ shot, headline, sub, dark, device }) {
  const f = device.frame;
  const { width, height } = device.viewport;
  const bg = dark
    ? "linear-gradient(180deg,#1e4fd6 0%,#2863f0 55%,#5a8cff 100%)"
    : "linear-gradient(180deg,#e9f0ff 0%,#f7f9ff 45%,#ffffff 100%)";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Schibsted;src:url(${FONT}) format("woff2");font-weight:400 900}
html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}
body{font-family:Schibsted,-apple-system,sans-serif;background:${bg};position:relative}
.copy{position:absolute;left:28px;right:28px;top:${f.copyTop}px;text-align:center}
h1{margin:0;font-size:${f.h1}px;line-height:1.08;font-weight:800;letter-spacing:-0.02em;color:${dark ? "#fff" : "#0b1220"}}
p{margin:${Math.round(f.p * 0.75)}px auto 0;max-width:${f.pMax}px;font-size:${f.p}px;line-height:1.3;font-weight:500;color:${dark ? "rgba(255,255,255,.85)" : "#4b5563"}}
.phone{position:absolute;left:50%;top:${f.phoneTop}px;width:${f.phoneWidth}px;transform:translateX(-50%);border-radius:${f.radius}px;background:#0b0f1a;padding:${f.pad}px;box-shadow:0 30px 60px rgba(11,18,32,.28),0 0 0 1px rgba(255,255,255,.08) inset}
.screen{border-radius:${f.screenRadius}px;overflow:hidden;background:#fff}
.screen img{display:block;width:100%}
</style></head><body><div class="copy"><h1>${headline}</h1><p>${sub}</p></div>
<div class="phone"><div class="screen"><img src="${shot}"></div></div></body></html>`;
}

async function signIn(page, base, email, password) {
  await page.goto(`${base}/auth/sign-in`, { waitUntil: "load", timeout: 120_000 });
  await page.fill("input[type=email]", email);
  await page.fill("input[type=password]", password);
  await page.keyboard.press("Enter");
  // A freshly started dev server compiles the portal on first hit; wait for the
  // navigation itself, not a fixed pause.
  await page.waitForURL((url) => /\/portal\/|choose-portal/.test(url.pathname), { timeout: 120_000 }).catch(() => {});
  if (page.url().includes("choose-portal")) {
    await page.getByText("Property", { exact: true }).first().click();
    await page.waitForURL((url) => url.pathname.includes("/portal/"), { timeout: 120_000 }).catch(() => {});
  }
  await page.waitForTimeout(3000);
  if (!page.url().includes("/portal/")) {
    throw new Error(`Sign-in as ${email} did not reach the manager portal (landed on ${page.url()}).`);
  }
}

async function assertSeeded(page, base) {
  await page.goto(`${base}/portal/properties/all`, { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  const count = await page.locator("[data-attr=property-list-row]").count();
  if (count < MIN_PROPERTIES) {
    throw new Error(
      `The manager has ${count} properties; the store gallery needs at least ${MIN_PROPERTIES}. ` +
        "Seed the e2e portfolio (npm run test:seed) or sign in as a manager who has one.",
    );
  }
}

/** The listing editor's Rooms step, with enough filled in to look like a real house. */
async function openWizardRooms(page, base) {
  await page.goto(`${base}/portal/properties/all?wizard=v2`, { waitUntil: "load", timeout: 120_000 });
  await page.waitForTimeout(6000);
  await page.locator("input").first().fill("4709 8th Ave NE, Seattle, WA 98105").catch(() => {});
  await page.locator("[data-attr=listing-v2-kind-house]").click().catch(() => {});
  await page.locator("[data-attr=listing-v2-rent-model-shared]").click().catch(() => {});
  for (let i = 0; i < 3; i += 1) {
    await page.locator("[data-attr=listing-v2-bedrooms] button").last().click().catch(() => {});
  }
  await page.locator("[data-attr=listing-v2-rail-rooms]").click();
  await settle(page);
}

async function shootDevice(browser, { base, email, password, device, outDir, rawDir }) {
  const ctx = await browser.newContext({
    viewport: device.viewport,
    deviceScaleFactor: device.scale,
    isMobile: device.isMobile,
    hasTouch: true,
    userAgent: device.userAgent,
  });
  const page = await ctx.newPage();
  await page.addInitScript((css) => {
    try {
      localStorage.setItem("proplane.messaging-setup-notice.dismissed", "1");
    } catch {
      /* private mode */
    }
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = css;
      document.head.appendChild(style);
    });
  }, HIDE_CSS);

  await signIn(page, base, email, password);
  await assertSeeded(page, base);

  const raws = [];
  for (const entry of GALLERY) {
    if (entry.route === "wizard:rooms") await openWizardRooms(page, base);
    else {
      await page.goto(`${base}${entry.route}`, { waitUntil: "load", timeout: 120_000 });
      await settle(page);
    }
    await page.addStyleTag({ content: HIDE_CSS }).catch(() => {});
    const raw = resolve(rawDir, `${entry.file}.png`);
    await page.screenshot({ path: raw });
    raws.push([entry, raw]);
    console.log(`  shot ${device.folder}/${entry.file}  ← ${page.url().replace(base, "")}`);
  }
  await ctx.close();

  // Frame at the device's own viewport and scale so the PNG is exactly Apple's size.
  const frameCtx = await browser.newContext({ viewport: device.viewport, deviceScaleFactor: device.scale });
  const framePage = await frameCtx.newPage();
  for (const [entry, raw] of raws) {
    const html = resolve(rawDir, `${entry.file}.html`);
    writeFileSync(html, frameHtml({ shot: pathToFileURL(raw).href, headline: entry.headline, sub: entry.sub, dark: !!entry.dark, device }));
    await framePage.goto(pathToFileURL(html).href);
    await framePage.evaluate(() => document.fonts.ready);
    await framePage.waitForTimeout(300);
    await framePage.screenshot({ path: resolve(outDir, `${entry.file}.png`) });
    console.log(`  framed ${device.folder}/${entry.file}`);
  }
  await frameCtx.close();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = process.env.SHOT_EMAIL || "manager2@test.proplane.local";
  const password = process.env.SHOT_PASSWORD || "TestManager123!";
  const devices = args.device === "both" ? ["iphone", "ipad"] : [args.device];

  const browser = await chromium.launch();
  try {
    for (const key of devices) {
      const device = DEVICES[key];
      const outDir = resolve(args.out, device.folder);
      const rawDir = resolve(args.out, ".raw", device.folder);
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      mkdirSync(rawDir, { recursive: true });
      console.log(`${device.folder} (${device.viewport.width * device.scale}×${device.viewport.height * device.scale}) from ${args.base} as ${email}`);
      await shootDevice(browser, { base: args.base, email, password, device, outDir, rawDir });
    }
  } finally {
    await browser.close();
    rmSync(resolve(args.out, ".raw"), { recursive: true, force: true });
  }
  console.log(`\n✅ ${GALLERY.length} screenshots per device written under ${args.out}. Look at them, then commit.`);
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`\n❌ App Store screenshots failed: ${error.message}`);
    process.exitCode = 1;
  });
}
