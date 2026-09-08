import { chromium } from "playwright";
import { QA_ACCOUNTS as E2E_ACCOUNTS } from "../../tests/fixtures/qa-accounts.mjs";

const BASE = process.env.BASE || "http://localhost:3000";
const ROUTES = [
  ["dashboard", "/resident/dashboard"], ["tour", "/resident/tour"],
  ["applications", "/resident/applications"], ["lease", "/resident/lease"],
  ["payments", "/resident/payments"], ["services", "/resident/services"],
  ["move-in", "/resident/move-in"], ["documents", "/resident/documents"],
  ["communication", "/resident/communication/active"], ["profile", "/resident/profile"],
];
const ALIASES = ["/resident/inbox", "/resident/financials", "/resident/finances", "/resident/bugs-feedback"];
const findings = [];
let rateLimitedFlagPlaceholder;
const add = (sev, where, title, detail) => {
  if (rateLimited) { console.log(`  [skipped-after-429] ${where}: ${title}`); return; }
  findings.push({ sev, where, title, detail }); console.log(`  [${sev}] ${where}: ${title} — ${detail}`);
};

const ctxOpts = (w, h) => ({ viewport: { width: w, height: h }, ...(w < 500 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });

async function signIn(page, acct) {
  await page.goto(`${BASE}/auth/sign-in?next=%2Fresident%2Fdashboard`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("Email").waitFor({ timeout: 20000 });
  await page.getByPlaceholder("Email").fill(acct.email);
  await page.getByPlaceholder("Password").fill(acct.password);
  await page.getByRole("button", { name: /sign in/i }).first().click();
  await page.waitForURL(u => !/\/auth\/sign-in/.test(new URL(u).pathname), { timeout: 45000 }).catch(() => {});
  // A multi-role account passes through /auth/continue or the portal chooser.
  if (/\/auth\/(continue|choose-portal)/.test(new URL(page.url()).pathname)) {
    await page.goto(`${BASE}/auth/choose-portal?next=%2Fresident%2Fdashboard`, { waitUntil: "domcontentloaded" });
    const btn = page.getByRole("button", { name: /^Resident\b/ });
    await btn.first().waitFor({ timeout: 30000 }).catch(() => {});
    if (await btn.count()) {
      await btn.first().click();
      await page.waitForURL(u => /\/resident\//.test(new URL(u).pathname), { timeout: 45000 }).catch(() => {});
    }
  }
  return new URL(page.url()).pathname;
}

const browser = await chromium.launch();
let rateLimited = false;

// Sign in ONCE and reuse the storage state. Re-authenticating per viewport (or per
// path) burns the shared dev project's auth budget and evicts the session mid-walk,
// which fabricates "session lost" findings — see PRP-364.
const bootCtx = await browser.newContext(ctxOpts(1280, 900));
const bootPage = await bootCtx.newPage();
bootPage.on("response", r => { if (r.status() === 429 && /auth\/v1\/token/.test(r.url())) rateLimited = true; });
const bootLanded = await signIn(bootPage, E2E_ACCOUNTS.resident);
console.log(`bootstrap sign-in -> ${bootLanded}`);
const STATE = await bootCtx.storageState();
await bootCtx.close();
if (rateLimited || /\/auth\//.test(bootLanded)) {
  console.log("ABORT: shared Supabase auth budget exhausted (429 on /auth/v1/token). Findings would be artifacts — see PRP-364.");
  await browser.close();
  process.exit(2);
}

for (const [w, h] of [[1280, 900], [390, 844]]) {
  const label = w < 500 ? "390x844" : "1280x900";
  console.log(`\n===== VIEWPORT ${label} =====`);
  const ctx = await browser.newContext({ ...ctxOpts(w, h), storageState: STATE });
  const page = await ctx.newPage();
  const errs = [];
  page.on("console", m => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); });
  page.on("pageerror", e => errs.push("pageerror: " + String(e).slice(0, 160)));
  page.on("response", r => {
    if (r.status() === 429) { rateLimited = true; console.log(`      HTTP 429  ${r.url().replace(BASE, "")}`); }
    else if (r.status() >= 400) {
      console.log(`      HTTP ${r.status()}  ${r.url().replace(BASE, "").slice(0, 110)}`);
      if (r.status() === 400) r.text().then(t => console.log(`         body: ${t.slice(0, 200)}`)).catch(() => {});
    }
  });
  page.on("requestfailed", r => {
    const err = r.failure()?.errorText ?? "?";
    if (err.includes("ERR_ABORTED")) return; // our own navigation cancelling a pending request
    console.log(`      FAILED  ${err}  ${r.url().replace(BASE, "").slice(0, 110)}`);
  });

  await page.goto(`${BASE}/resident/dashboard`, { waitUntil: "domcontentloaded" }).catch(() => {});
  const landed = new URL(page.url()).pathname;
  console.log(`  reusing session -> ${landed}`);

  for (const [name, path] of ROUTES) {
    errs.length = 0;
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" }).catch(() => {});
    // Wait for the page to stop fetching before judging it. Navigating while
    // requests are in flight aborts them, and an aborted request surfaces as
    // "TypeError: Failed to fetch" — an artifact of the walker, not a defect.
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);
    const final = new URL(page.url()).pathname;
    const bodyLen = (await page.locator("body").innerText().catch(() => "")).trim().length;
    const redirectedHome = final !== path && /\/resident\/dashboard$/.test(final) && !/dashboard/.test(path);
    if (/\/auth\//.test(final)) add("high", `${name}@${label}`, "bounced to auth while signed in", `${path} -> ${final}`);
    else if (redirectedHome) add("high", `${name}@${label}`, "locked route silently redirects home", `${path} -> ${final} (a locked row must be inert, not a live link that bounces)`);
    else if (bodyLen < 200) add("medium", `${name}@${label}`, "renders almost nothing", `${path} -> ${final}, ${bodyLen} chars of text`);
    // scroll reachability: can we reach the document end?
    const scroll = await page.evaluate(() => {
      const el = document.querySelector("#portal-main-content") || document.scrollingElement;
      if (!el) return null;
      return { sh: el.scrollHeight, ch: el.clientHeight };
    }).catch(() => null);
    if (scroll && scroll.sh > scroll.ch + 40) {
      await page.evaluate(() => { const el = document.querySelector("#portal-main-content") || document.scrollingElement; el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(300);
      const reached = await page.evaluate(() => { const el = document.querySelector("#portal-main-content") || document.scrollingElement; return el.scrollTop + el.clientHeight >= el.scrollHeight - 8; }).catch(() => true);
      if (!reached) add("high", `${name}@${label}`, "content is unreachable by scrolling", `${path} scrollHeight ${scroll.sh} > clientHeight ${scroll.ch} but scrollTop pinned`);
    }
    const real = errs.filter(e => !/favicon|ERR_BLOCKED_BY_CLIENT|Download the React|Failed to fetch|ERR_ABORTED/i.test(e));
    if (real.length) add("medium", `${name}@${label}`, "console error", real.slice(0, 2).join(" | "));
    console.log(`   ${name.padEnd(14)} ${final}${bodyLen < 200 ? "  (EMPTY)" : ""}`);
  }

  for (const alias of ALIASES) {
    await page.goto(`${BASE}${alias}`, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(800);
    const final = new URL(page.url()).pathname;
    if (final === alias) add("medium", `alias@${label}`, "legacy alias did not redirect", `${alias} stayed put`);
    else if (/\/auth\//.test(final)) add("high", `alias@${label}`, "legacy alias bounced to auth", `${alias} -> ${final}`);
    console.log(`   alias ${alias.padEnd(28)} -> ${final}`);
  }
  await ctx.close();
}
await browser.close();
console.log(`\n===== ${findings.length} FINDINGS =====`);
for (const f of findings) console.log(`[${f.sev}] ${f.where} :: ${f.title} :: ${f.detail}`);
