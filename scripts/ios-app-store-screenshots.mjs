#!/usr/bin/env node
// Re-shoot and re-frame the App Store screenshots under app-store/screenshots/.
//
// Signs in to a LOCAL dev server as the showcase manager (npm run app-store:seed),
// captures each store screen at the device's own CSS size, and frames it: a brand
// blue / deep navy background (alternating by slot), the PropLane mark, a two-line
// headline in PropLane's own font, and a bezelled device that bleeds off the bottom
// edge. Slots 02 and 05 are a zoomed crop card instead (the one element that sells
// the slide, large enough to read at thumbnail size). Nothing is mocked: every frame
// holds a real capture. The output is exactly what scripts/ios-app-store-release.mjs
// uploads on the next production push, so run this whenever a screen on the list
// changes, look at the PNGs, and commit them.
//
//   npm run app-store:seed                                              # once: the showcase manager
//   npm run app-store:shots -- --base http://localhost:3000            # both devices
//   npm run app-store:shots -- --base http://localhost:3000 --device iphone
//   npm run app-store:shots -- --base … --only 07-tours,09-inbox      # redo a few slots
//
// SHOT_EMAIL / SHOT_PASSWORD come from the environment, else .env.local (where the seed
// writes them). It refuses a manager with fewer than three properties, and it fails the
// run if a captured page shows a test-fixture string (FORBIDDEN_TEXT) or a slot's route
// or element is missing, so a stale route or a dirty account can never reach the store.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright";

const REPO = resolve(new URL("..", import.meta.url).pathname);
const FONT = pathToFileURL(resolve(REPO, "src/app/fonts/schibsted-grotesk-variable.woff2")).href;
const OUT_ROOT = resolve(REPO, "app-store/screenshots");
const MIN_PROPERTIES = 3;

/** The product's own mark (the favicon tile), so the frame can never drift from the brand. */
const MARK_SVG = readFileSync(resolve(REPO, "src/app/icon.svg"), "utf8")
  .replace(/<\?xml[^>]*\?>/, "")
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/\swidth="32"\s+height="32"/, ' width="100%" height="100%"');

/**
 * Apple's display classes. The 6.9" and 13" sets are reused for every smaller device.
 * `viewport` x `scale` is the exact output size. `capture` is the size the app is shot at
 * (the iPad is shot at a real portrait CSS size so type is larger than at 1032 wide, then
 * framed onto the 2064x2752 canvas). `a` is the framed-device geometry, `b` the crop card;
 * every number is CSS px on the viewport.
 */
export const DEVICES = Object.freeze({
  iphone: {
    folder: "iphone-6.9",
    display: "APP_IPHONE_67",
    viewport: { width: 440, height: 956 },
    scale: 3,
    capture: { width: 440, height: 956, scale: 3 },
    isMobile: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    a: { brandTop: 40, tile: 28, brandFs: 17, hTop: 90, hFs: 42, hMax: 384, devTop: 246, devW: 480, pad: 8, radius: 54, screenRadius: 46, status: 34 },
    b: { card: 392, top: 236, radius: 30 },
  },
  ipad: {
    folder: "ipad-13",
    display: "APP_IPAD_PRO_3GEN_129",
    viewport: { width: 1032, height: 1376 },
    scale: 2,
    capture: { width: 834, height: 1112, scale: 3 },
    isMobile: false,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    a: { brandTop: 84, tile: 58, brandFs: 36, hTop: 190, hFs: 96, hMax: 900, devTop: 540, devW: 1090, pad: 18, radius: 62, screenRadius: 46, status: 0 },
    b: { card: 860, top: 420, radius: 44 },
  },
});

/**
 * The gallery, in store order. `route` is what gets shot (or a `kind:` opener below);
 * `headline` is the framed copy, two lines split by <br>, no subtext; `crop` swaps the
 * device frame for a zoomed card of that element. Apple shows at most ten, and the first
 * three are the install sheet. User-facing copy says "service", never "work order".
 * Every headline names a feature the app has today.
 */
export const GALLERY = Object.freeze([
  { file: "01-rent-by-the-room", route: "/portal/properties/listed", headline: "Rent by<br>the room." },
  { file: "02-dashboard", route: "/portal/dashboard", headline: "Every room,<br>every dollar.", crop: "dashboard" },
  { file: "03-applications", route: "/portal/applications/pending", headline: "Applications<br>for every room." },
  { file: "04-residents", route: "/portal/residents/current", headline: "Know who lives<br>in every room." },
  { file: "05-payments", route: "/portal/payments/incoming/paid", headline: "Rent collected,<br>room by room.", crop: "payments" },
  { file: "06-leases", route: "/portal/leases/completed", headline: "Leases signed<br>in the app." },
  { file: "07-tours", route: "/portal/tours/pending", headline: "Tours booked<br>for you." },
  // /portal/move-in/inspections/* redirects to the Residents list now: inspections live on a resident's own record.
  { file: "08-inspections", route: "resident:move-in", headline: "Move-in photos<br>from residents." },
  { file: "09-inbox", route: "/portal/communication/active", headline: "One inbox<br>for everyone." },
  // On a phone the listing editor has no side rail: the Rooms step is reached through the Steps picker.
  { file: "10-list-a-room", route: "wizard:rooms", headline: "Set up every room<br>in minutes." },
]);

/** Number of lines a gallery headline renders as (one per <br>-separated part). */
export function headlineLineCount(headline) {
  return headline.split(/<br\s*\/?>/i).length;
}

/** Strings no store shot may ever show: test fixtures, QA names, setup nags. */
export const FORBIDDEN_TEXT = Object.freeze([
  /test\.proplane\.local/i,
  /e2e/i,
  /mgr-test/i,
  /\bProof\b/,
  /\bWizard\b(?! step)/,
  /\bQA\b/,
  /work order/i,
  /Phone number not set up/i,
  /gmail\.com/i,
]);

const HIDE_CSS = [
  "nextjs-portal{display:none!important}",
  ".portal-banner-danger{display:none!important}",
  ".portal-mobile-nav-bar{display:none!important}",
  ".axis-assistant-fab{display:none!important}",
].join(" ");

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

function readEnvLocal(key) {
  const file = resolve(REPO, ".env.local");
  if (!existsSync(file)) return "";
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "") : "";
}

function parseArgs(argv) {
  const out = { base: "", device: "both", out: OUT_ROOT, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    if (arg === "--base") out.base = next();
    else if (arg.startsWith("--base=")) out.base = arg.slice(7);
    else if (arg === "--device") out.device = next();
    else if (arg.startsWith("--device=")) out.device = arg.slice(9);
    else if (arg === "--out") out.out = resolve(next());
    else if (arg.startsWith("--out=")) out.out = resolve(arg.slice(6));
    else if (arg === "--only") out.only = next().split(",");
    else if (arg.startsWith("--only=")) out.only = arg.slice(7).split(",");
  }
  if (!out.base) throw new Error("Pass --base <url of a running dev server>, e.g. --base http://localhost:3000");
  if (!["both", "iphone", "ipad"].includes(out.device)) throw new Error(`--device must be iphone, ipad or both (got ${out.device})`);
  return out;
}

// ── Framing ─────────────────────────────────────────────────────────────────

const BG = {
  blue: "radial-gradient(90% 46% at 18% 0%,#6f9bff 0%,rgba(111,155,255,0) 70%),linear-gradient(170deg,#2f6bff 0%,#2863f0 42%,#1e4fd6 100%)",
  navy: "radial-gradient(110% 52% at 50% 108%,#2863f0 0%,rgba(40,99,240,0) 62%),linear-gradient(180deg,#10204a 0%,#0a1230 100%)",
};

/** Blue on the first slot, navy on the second, alternating: the install sheet reads blue, navy, blue. */
export const backgroundForIndex = (index) => (index % 2 === 0 ? "blue" : "navy");

const baseCss = (w, h) => `
@font-face{font-family:Schibsted;src:url(${FONT}) format("woff2");font-weight:400 900}
*{box-sizing:border-box}
html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden}
body{font-family:Schibsted,-apple-system,sans-serif;position:relative;color:#fff}
.brand{position:absolute;left:0;right:0;display:flex;justify-content:center;align-items:center;gap:.5em;font-weight:800;letter-spacing:-.01em}
.tile{display:block;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.18)}
h1{position:absolute;left:0;right:0;margin:0 auto;text-align:center;font-weight:800;line-height:1.04;letter-spacing:-.025em}
`;

/** Shrink the headline until its widest line fits: two lines at most, never a third. */
const fitScript = (max) => `
for (const h of document.querySelectorAll("h1")) {
  const sp = h.querySelector(".hl");
  let fs = parseFloat(getComputedStyle(h).fontSize);
  while (sp.offsetWidth > ${max} && fs > 20) { fs -= 1; h.style.fontSize = fs + "px"; }
}`;

const brandHtml = (g) =>
  `<div class="brand" style="top:${g.brandTop}px;font-size:${g.brandFs}px"><span class="tile" style="width:${g.tile}px;height:${g.tile}px;border-radius:${Math.round(g.tile * 0.3)}px">${MARK_SVG}</span><span>PropLane</span></div>`;

const headlineHtml = (headline) =>
  `<h1><span class="hl" style="display:inline-block;white-space:nowrap">${headline}</span></h1>`;

const statusBar = (g) =>
  g.status
    ? `<div style="height:${g.status}px;display:flex;justify-content:space-between;align-items:center;padding:0 56px;font:700 14px Schibsted,sans-serif;color:#111;background:#fff"><span>9:41</span><span style="display:flex;gap:5px;align-items:center"><svg width="17" height="11" viewBox="0 0 17 11" fill="#111"><rect x="0" y="7" width="3" height="4" rx="1"/><rect x="4.5" y="5" width="3" height="6" rx="1"/><rect x="9" y="2.5" width="3" height="8.5" rx="1"/><rect x="13.5" y="0" width="3" height="11" rx="1"/></svg><svg width="25" height="12" viewBox="0 0 25 12"><rect x=".5" y=".5" width="21" height="11" rx="3.2" fill="none" stroke="#111" opacity=".45"/><rect x="2" y="2" width="18" height="8" rx="2" fill="#111"/><rect x="22.5" y="4" width="2" height="4" rx="1" fill="#111" opacity=".45"/></svg></span></div>`
    : "";

/** Direction A: the whole screen on a bezelled device that bleeds off the bottom edge. */
export function frameA({ shot, headline, variant, device }) {
  const { width, height } = device.viewport;
  const g = device.a;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss(width, height)}
body{background:${BG[variant]}}
h1{top:${g.hTop}px;font-size:${g.hFs}px;max-width:${g.hMax + 40}px}
.dev{position:absolute;left:50%;top:${g.devTop}px;width:${g.devW}px;transform:translateX(-50%);border-radius:${g.radius}px;background:#0b0f1a;padding:${g.pad}px;box-shadow:0 40px 80px rgba(3,10,40,.45),0 0 0 2px rgba(255,255,255,.12) inset,0 0 0 1.5px rgba(255,255,255,.18)}
.screen{border-radius:${g.screenRadius}px;overflow:hidden;background:#fff}
.screen img{display:block;width:100%}
</style></head><body>${brandHtml(g)}${headlineHtml(headline)}
<div class="dev"><div class="screen">${statusBar(g)}<img src="${shot}"></div></div>
<script>${fitScript(g.hMax)}</script></body></html>`;
}

/** Direction B: a zoomed crop of the one element that sells the slide, floated as a card. */
export function frameB({ shot, headline, variant, device, ratio }) {
  const { width, height } = device.viewport;
  const g = device.a;
  const b = device.b;
  const cardH = Math.round(b.card * ratio);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss(width, height)}
body{background:${BG[variant]}}
h1{top:${g.hTop}px;font-size:${g.hFs}px;max-width:${g.hMax + 40}px}
.card{position:absolute;left:50%;top:${b.top}px;width:${b.card}px;height:${cardH}px;transform:translateX(-50%);border-radius:${b.radius}px;overflow:hidden;background:#f6f7f9;box-shadow:0 40px 80px rgba(3,10,40,.45),0 0 0 1px rgba(255,255,255,.2)}
.card img{display:block;width:100%}
</style></head><body>${brandHtml(g)}${headlineHtml(headline)}
<div class="card"><img src="${shot}"></div>
<script>${fitScript(g.hMax)}</script></body></html>`;
}

// ── Capture ─────────────────────────────────────────────────────────────────

async function signIn(page, base, email, password) {
  await page.goto(`${base}/auth/sign-in`, { waitUntil: "load", timeout: 120_000 });
  await page.locator("input[type=email]").waitFor({ timeout: 120_000 });
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
  // A cold dev server compiles the portal on this first hit; give the rows a real chance to arrive.
  await page.locator("[data-attr=property-list-row]").first().waitFor({ timeout: 90_000 }).catch(() => {});
  await settle(page);
  const count = await page.locator("[data-attr=property-list-row]").count();
  if (count < MIN_PROPERTIES) {
    throw new Error(
      `The manager has ${count} properties; the store gallery needs at least ${MIN_PROPERTIES}. ` +
        "Run npm run app-store:seed and shoot as that manager (SHOT_EMAIL / SHOT_PASSWORD).",
    );
  }
}

/** The listing editor's Rooms step, reached the way a phone reaches it: the Steps picker. */
async function openWizardRooms(page, base) {
  await page.goto(`${base}/portal/properties/all?wizard=v2`, { waitUntil: "load", timeout: 120_000 });
  await page.waitForTimeout(6000);
  await page.locator("input").first().fill("4709 8th Ave NE, Seattle, WA 98105").catch(() => {});
  await page.locator("[data-attr=listing-v2-kind-house]").click().catch(() => {});
  await page.locator("[data-attr=listing-v2-rent-model-shared]").click().catch(() => {});
  for (let i = 0; i < 3; i += 1) {
    await page.locator("[data-attr=listing-v2-bedrooms] button").last().click().catch(() => {});
  }
  // Phone widths swap the tab strip for the Steps picker; iPad widths keep the strip's own Rooms tab.
  const tab = page.locator("[data-attr=workspace-step-rooms]:visible");
  if (await tab.count()) await tab.first().click({ timeout: 15_000 });
  else {
    await page.locator("[data-attr=phone-strip-picker-toggle]:visible").first().click({ timeout: 15_000 });
    await page.waitForTimeout(600);
    await page.locator("[data-attr=workspace-step-rooms-picker]").click({ timeout: 15_000 });
  }
  await settle(page);
}

/** A resident's own record, Move in section: where inspections live now. */
async function openResidentMoveIn(page, base) {
  await page.goto(`${base}/portal/residents/current`, { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  const row = page.locator("[data-attr=resident-list-row]").first();
  await row.waitFor({ timeout: 30_000 });
  await row.click();
  await page.waitForURL((u) => /\/residents\/current\/[^/]+/.test(u.pathname), { timeout: 30_000 });
  const recordUrl = page.url().replace(/\/(overview|move-in.*)?$/, "");
  await page.goto(`${recordUrl}/move-in`, { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  if (!/\/residents\/current\/[^/]+\/move-in/.test(page.url())) {
    throw new Error(`Slot 08 expected a resident's Move in section but landed on ${page.url()}.`);
  }
}

/** Union clip (CSS px) of the elements a crop slot wants; null when the page lacks them. */
async function cropClip(page, kind) {
  return page.evaluate((kind) => {
    const rect = (e) => e.getBoundingClientRect();
    if (kind === "dashboard") {
      const grid = document.querySelector("[data-attr=dashboard-metric-occupied]")?.parentElement;
      const att = document.querySelector("[data-attr=dashboard-attention-panel]");
      if (!grid || !att) return null;
      const a = rect(grid);
      const b = rect(att);
      return { x: Math.floor(a.x) - 4, y: Math.floor(a.y) - 4, width: Math.ceil(a.width) + 8, height: Math.ceil(b.bottom - a.y) + 8 };
    }
    if (kind === "payments") {
      const groups = document.querySelector("[data-attr=payments-resident-groups]");
      if (!groups) return null;
      // The ledger lists every charge a resident has had; the card shows one row per resident,
      // so hide the repeats (real rows, just not drawn twice).
      const seen = new Set();
      const rows = [];
      for (const row of Array.from(groups.children)) {
        const name = (row.innerText || "").trim().split("\n")[0];
        if (seen.has(name)) row.style.display = "none";
        else {
          seen.add(name);
          rows.push(row);
        }
      }
      if (rows.length < 3) return null;
      const first = rect(rows[0]);
      const last = rect(rows[2]);
      const g0 = rect(groups);
      return { x: Math.floor(g0.x) - 4, y: Math.floor(first.y) - 4, width: Math.ceil(g0.width) + 8, height: Math.ceil(last.bottom - first.y) + 8 };
    }
    return null;
  }, kind);
}

/**
 * A local dev server has no SMS runtime, so the inbox header says texting is off for this
 * deployment. Production never shows that line; it is not part of the product being sold.
 */
async function hideLocalDevNotices(page) {
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (el.children.length === 0 && /texting is off for this deployment/i.test(el.textContent || "")) el.style.display = "none";
    }
  });
}

/** Fail the run when the captured page shows a fixture string, a setup nag, or a skeleton. */
async function assertCleanText(page, entry) {
  const text = await page.evaluate(() => document.body.innerText);
  for (const pattern of FORBIDDEN_TEXT) {
    const hit = text.match(pattern);
    if (hit) throw new Error(`Slot ${entry.file} shows "${hit[0]}" (${pattern}). Fix the data (npm run app-store:seed), not the capture.`);
  }
}

async function shootDevice(browser, { base, email, password, device, outDir, rawDir, only }) {
  const cap = device.capture;
  const ctx = await browser.newContext({
    viewport: { width: cap.width, height: cap.height },
    deviceScaleFactor: cap.scale,
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
  const entries = only ? GALLERY.filter((entry) => only.includes(entry.file)) : GALLERY;
  if (entries.length === 0) throw new Error(`--only matched nothing; slots are ${GALLERY.map((e) => e.file).join(", ")}`);
  for (const entry of entries) {
    if (entry.route === "wizard:rooms") await openWizardRooms(page, base);
    else if (entry.route === "resident:move-in") await openResidentMoveIn(page, base);
    else {
      await page.goto(`${base}${entry.route}`, { waitUntil: "load", timeout: 120_000 });
      await settle(page);
      const landed = new URL(page.url()).pathname;
      if (!landed.startsWith(entry.route.split("/").slice(0, 3).join("/"))) {
        throw new Error(`Slot ${entry.file} asked for ${entry.route} but the app sent it to ${landed}. The route is stale.`);
      }
    }
    await page.addStyleTag({ content: HIDE_CSS }).catch(() => {});
    await hideLocalDevNotices(page);
    await page.waitForTimeout(400);
    await assertCleanText(page, entry);
    const raw = resolve(rawDir, `${entry.file}.png`);
    await page.screenshot({ path: raw });
    const record = { entry, raw };
    if (entry.crop) {
      const clip = await cropClip(page, entry.crop);
      if (!clip) throw new Error(`Slot ${entry.file}: the ${entry.crop} crop's elements are not on ${page.url()}.`);
      const cropPath = resolve(rawDir, `${entry.file}-crop.png`);
      await page.screenshot({ path: cropPath, clip });
      record.crop = { path: cropPath, ratio: clip.height / clip.width };
    }
    raws.push(record);
    console.log(`  shot ${device.folder}/${entry.file}  ← ${page.url().replace(base, "")}`);
  }
  await ctx.close();

  // Frame at the device's own viewport and scale so the PNG is exactly Apple's size.
  const frameCtx = await browser.newContext({ viewport: device.viewport, deviceScaleFactor: device.scale });
  const framePage = await frameCtx.newPage();
  for (const { entry, raw, crop } of raws) {
    const index = GALLERY.findIndex((e) => e.file === entry.file);
    const variant = backgroundForIndex(index);
    const html = resolve(rawDir, `${entry.file}.html`);
    writeFileSync(
      html,
      crop
        ? frameB({ shot: pathToFileURL(crop.path).href, headline: entry.headline, variant, device, ratio: crop.ratio })
        : frameA({ shot: pathToFileURL(raw).href, headline: entry.headline, variant, device }),
    );
    await framePage.goto(pathToFileURL(html).href);
    await framePage.evaluate(() => document.fonts.ready);
    await framePage.waitForTimeout(300);
    const lines = await framePage.evaluate(() => {
      const h = document.querySelector("h1");
      return Math.round(h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight || "1"));
    });
    if (lines > 2) throw new Error(`Headline of ${entry.file} needs ${lines} lines; shorten it.`);
    await framePage.screenshot({ path: resolve(outDir, `${entry.file}.png`) });
    console.log(`  framed ${device.folder}/${entry.file}${crop ? " (crop)" : ""}`);
  }
  await frameCtx.close();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = process.env.SHOT_EMAIL || readEnvLocal("SHOT_EMAIL") || "manager2@test.proplane.local";
  const password = process.env.SHOT_PASSWORD || readEnvLocal("SHOT_PASSWORD") || "TestManager123!";
  const devices = args.device === "both" ? ["iphone", "ipad"] : [args.device];

  const browser = await chromium.launch();
  try {
    for (const key of devices) {
      const device = DEVICES[key];
      const outDir = resolve(args.out, device.folder);
      const rawDir = resolve(args.out, ".raw", device.folder);
      if (!args.only) rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      mkdirSync(rawDir, { recursive: true });
      console.log(`${device.folder} (${device.viewport.width * device.scale}×${device.viewport.height * device.scale}) from ${args.base} as ${email}`);
      await shootDevice(browser, { base: args.base, email, password, device, outDir, rawDir, only: args.only });
    }
  } finally {
    await browser.close();
    rmSync(resolve(args.out, ".raw"), { recursive: true, force: true });
  }
  console.log(`\n✅ ${args.only ? args.only.length : GALLERY.length} screenshots per device written under ${args.out}. Look at them, then commit.`);
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`\n❌ App Store screenshots failed: ${error.message}`);
    process.exitCode = 1;
  });
}
