#!/usr/bin/env node
/**
 * Portal DOM sweep — the MEASURED layer of the portal QA family (`/testmanager`).
 *
 *   node scripts/qa-portal-dom-sweep.mjs --base http://localhost:3000
 *   node scripts/qa-portal-dom-sweep.mjs --role resident --viewports phone
 *   node scripts/qa-portal-dom-sweep.mjs --routes properties,payments --all
 *
 * It walks every registered portal route at each viewport, injects `probe.js`,
 * and records what it MEASURED: clipped-but-unscrollable panels, controls buried
 * under sticky chrome, sideways page scroll, duplicated header actions, dead
 * images, console errors, failed requests, and routes that land somewhere else.
 *
 * Three deliberate choices:
 *
 * - **It reuses the repo's QA plumbing rather than growing a second harness.**
 *   Sign-in is `scripts/qa-portal-sign-in.mjs` (it already knows the
 *   choose-portal cookie trap), accounts come from `tests/fixtures/qa-accounts.mjs`
 *   (the one canonical list), and the findings it writes are in the exact shape
 *   `scripts/qa-file-findings-to-linear.mjs` consumes, so filing stays on one path
 *   with one duplicate check.
 * - **The route list is PARSED out of the portal registries**, never retyped. A
 *   section added to a portal is swept the night it lands. If the parse yields
 *   nothing it exits non-zero instead of cheerfully reporting a clean sweep of
 *   zero pages.
 * - **It keeps a durable ledger** (`.testmanager/ledger.json`) keyed on
 *   role+route+viewport-class+check+element. An overnight loop re-runs this every
 *   pass; without the ledger it would re-report the same clipped panel until
 *   morning and bury the one new defect that appeared at 3am.
 *
 * Exit code is 0 whenever the sweep completed — a finding is a result, not a
 * failure. Non-zero means the sweep itself could not run (no server, no routes,
 * sign-in refused), which is the only state that needs a person.
 */
import { chromium, devices } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const { signInToPortal, dismissDevOverlay } = await import(join(REPO_ROOT, "scripts/qa-portal-sign-in.mjs"));
const { QA_ACCOUNTS } = await import(join(REPO_ROOT, "tests/fixtures/qa-accounts.mjs"));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const BASE = (arg("base", process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000")).replace(/\/$/, "");
const ROLE = arg("role", "manager");
const ROUTE_FILTER = (arg("routes", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const IGNORE_LEDGER = flag("all");
const OUT_ROOT = resolve(arg("out", join(REPO_ROOT, ".testmanager")));
const LEDGER_PATH = join(OUT_ROOT, "ledger.json");
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const RUN_DIR = join(OUT_ROOT, "runs", `${ROLE}-${RUN_ID}`);

const VIEWPORTS = {
  desktop: { name: "desktop", width: 1280, height: 900, device: null },
  tablet: { name: "tablet", width: 820, height: 1100, device: null },
  phone: { name: "phone", width: 390, height: 844, device: devices["iPhone 13"] },
};
const SELECTED_VIEWPORTS = (arg("viewports", "desktop,phone") || "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => VIEWPORTS[s])
  .map((s) => VIEWPORTS[s]);

// The portal registries are TypeScript and this is a plain ESM script (the whole
// qa-* family is, deliberately — no TS loader). Parsing the smoke-path table out
// of the source keeps ONE list: editing the portal edits the sweep.
const ROUTE_SOURCES = {
  manager: ["src/lib/portals/pro.ts", "MANAGER_PORTAL_SMOKE_PATHS"],
  resident: ["src/lib/portals/resident-sections.ts", "RESIDENT_PORTAL_SMOKE_PATHS"],
  admin: ["src/lib/portals/admin.ts", "ADMIN_PORTAL_SMOKE_PATHS"],
  vendor: ["src/lib/portals/vendor.ts", "VENDOR_PORTAL_SMOKE_PATHS"],
};

function loadRoutes(role) {
  const entry = ROUTE_SOURCES[role];
  if (!entry) throw new Error(`No route source for role "${role}"`);
  const [file, constName] = entry;
  const src = readFileSync(join(REPO_ROOT, file), "utf8");
  const block = src.slice(src.indexOf(`export const ${constName}`));
  const end = block.indexOf("] as const");
  if (end < 0) throw new Error(`Could not parse ${constName} out of ${file}`);
  // Paths are written either as a plain string or as a template literal over a
  // base-path constant (`${RESIDENT_PORTAL_BASE_PATH}/lease`), so both shapes are
  // read and the constant is resolved from the same file.
  const consts = Object.fromEntries([...src.matchAll(/export const (\w+) = "([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const routes = [...block.slice(0, end).matchAll(/\{\s*label:\s*"([^"]+)",\s*path:\s*(?:"([^"]+)"|`([^`]+)`)\s*\}/g)].map((m) => ({
    label: m[1],
    path: (m[2] ?? m[3]).replace(/\$\{(\w+)\}/g, (whole, name) => consts[name] ?? whole),
  }));
  const unresolved = routes.find((r) => r.path.includes("${"));
  if (unresolved) throw new Error(`Unresolved path expression in ${constName}: ${unresolved.path}`);
  if (!routes.length) throw new Error(`${constName} in ${file} parsed to zero routes — the table's shape changed`);
  return routes;
}

const ACCOUNT_HOME = {
  manager: "/portal/dashboard",
  resident: "/resident/dashboard",
  admin: "/admin/dashboard",
  vendor: "/vendor/dashboard",
};

function loadLedger() {
  if (!existsSync(LEDGER_PATH)) return {};
  try {
    return JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
  } catch {
    // A truncated ledger (a pass killed mid-write) must not stop the sweep; the
    // cost is re-reporting known findings once, which the filer then dedupes.
    return {};
  }
}

function keyOf(f) {
  const anchor = f.detail?.el ?? f.detail?.culprits?.[0]?.el ?? f.summary.slice(0, 60);
  return createHash("sha1").update([f.role, f.path, f.viewport, f.check, anchor].join("|")).digest("hex").slice(0, 12);
}

// `kind` picks the Linear label in qa-file-findings-to-linear.mjs: `runtime` files
// as Bug, everything else as Improvement. A check that proves the page is broken
// (it errored, it 500'd, you cannot reach the content) is runtime; a measurement
// that a person still has to judge is ui.
const RUNTIME_CHECKS = new Set([
  "page-error",
  "console-error",
  "request-failed",
  "route-status",
  "route-redirect",
  "error-surface",
  "no-heading",
  "unreachable-overflow",
  "obscured-control",
  "broken-image",
]);

async function sweepViewport(browser, viewport, routes, probeSource) {
  const context = await browser.newContext({
    ...(viewport.device ?? {}),
    viewport: { width: viewport.width, height: viewport.height },
    baseURL: BASE,
  });
  await context.addInitScript({ content: probeSource });
  const page = await context.newPage();

  const account = QA_ACCOUNTS[ROLE];
  if (!account?.email) throw new Error(`No QA account for role "${ROLE}"`);
  await signInToPortal(page, { ...account, role: ROLE, home: ACCOUNT_HOME[ROLE] }, BASE);
  await dismissDevOverlay(page).catch(() => {});

  const findings = [];
  for (const route of routes) {
    process.stdout.write(`  ${viewport.name} ${route.label} … `);
    const consoleErrors = [];
    const pageErrors = [];
    const badResponses = [];
    const onConsole = (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 300));
    const onPageError = (e) => pageErrors.push(String(e.message).slice(0, 300));
    const onResponse = (r) => r.status() >= 400 && badResponses.push({ url: r.url().slice(0, 200), status: r.status() });
    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    page.on("response", onResponse);

    const local = [];
    const push = (raw) => {
      const f = {
        role: ROLE,
        label: route.label,
        path: route.path,
        viewport: `${viewport.name} ${viewport.width}×${viewport.height}`,
        viewportClass: viewport.name,
        runId: RUN_ID,
        ...raw,
        kind: RUNTIME_CHECKS.has(raw.check) ? "runtime" : "ui",
      };
      f.key = keyOf(f);
      if (!local.some((x) => x.key === f.key)) local.push(f);
    };

    try {
      // A `next dev` server compiles a route on its FIRST hit, which regularly
      // outruns any sane navigation budget and looks exactly like a hung page. The
      // second hit is served from the compiled route, so one retry separates "cold
      // compile" from "this page genuinely never loads" — and a real hang still
      // fails twice and gets reported.
      let response;
      try {
        response = await page.goto(`${BASE}${route.path}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      } catch (err) {
        if (!/Timeout/i.test(String(err.message))) throw err;
        process.stdout.write("(warming) ");
        response = await page.goto(`${BASE}${route.path}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
      }
      // Portal panels hydrate and then sync. Measuring before that settles reports
      // layout no person ever sees, which is how a sweep manufactures phantom bugs.
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(1200);

      const landed = new URL(page.url()).pathname;
      if (landed !== route.path) {
        push({
          check: "route-redirect",
          severity: landed.includes("sign-in") || landed === "/" ? "high" : "medium",
          summary: `${route.path} landed on ${landed} instead of rendering`,
          finalUrl: page.url(),
          detail: { requested: route.path, landed },
        });
      }
      if (response && response.status() >= 400) {
        push({
          check: "route-status",
          severity: "high",
          summary: `${route.path} responded ${response.status()}`,
          detail: { status: response.status() },
        });
      }

      const top = await page.evaluate(() => globalThis.__tmProbe?.());
      // Sticky chrome only collides once the page is scrolled — the floating bulk
      // bar meeting the phone tab bar is invisible from the top of the page.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(600);
      const bottom = await page.evaluate(() => globalThis.__tmProbe?.());
      for (const pass of [top, bottom]) for (const f of pass?.findings ?? []) push(f);

      for (const e of pageErrors.slice(0, 5)) {
        push({ check: "page-error", severity: "high", summary: `Uncaught error: ${e}`, detail: { error: e } });
      }
      for (const e of consoleErrors.slice(0, 5)) {
        push({ check: "console-error", severity: "medium", summary: `Console error: ${e}`, detail: { error: e } });
      }
      for (const r of badResponses.slice(0, 8)) {
        push({
          check: "request-failed",
          severity: r.status >= 500 ? "high" : "medium",
          summary: `${r.status} from ${r.url}`,
          detail: r,
        });
      }
    } catch (err) {
      push({
        check: "sweep-error",
        severity: "high",
        summary: `Sweep could not complete ${route.path}: ${err.message}`.slice(0, 200),
        detail: { error: String(err.message) },
      });
    } finally {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("response", onResponse);
    }

    if (local.length) {
      mkdirSync(RUN_DIR, { recursive: true });
      const shot = join(RUN_DIR, `${viewport.name}-${route.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      for (const f of local) f.screenshot = shot;
    }
    findings.push(...local);
    console.log(local.length ? `${local.length} finding(s)` : "clean");
  }

  await context.close();
  return findings;
}

async function main() {
  const routes = loadRoutes(ROLE).filter(
    (r) => !ROUTE_FILTER.length || ROUTE_FILTER.some((f) => r.path.includes(f) || r.label.toLowerCase().includes(f.toLowerCase())),
  );
  if (!routes.length) throw new Error(`No routes matched --routes "${ROUTE_FILTER.join(",")}"`);
  if (!SELECTED_VIEWPORTS.length) throw new Error(`--viewports matched none of: ${Object.keys(VIEWPORTS).join(", ")}`);

  const probeSource = readFileSync(join(__dirname, "qa-portal-dom-probe.js"), "utf8");
  console.log(`portal DOM sweep · ${ROLE} · ${BASE} · ${routes.length} routes × ${SELECTED_VIEWPORTS.length} viewports`);

  const browser = await chromium.launch({ headless: !flag("headed") });
  const all = [];
  try {
    for (const viewport of SELECTED_VIEWPORTS) {
      all.push(...(await sweepViewport(browser, viewport, routes, probeSource)));
    }
  } finally {
    await browser.close();
  }

  const ledger = loadLedger();
  const now = new Date().toISOString();
  const novel = [];
  for (const f of all) {
    const seen = ledger[f.key];
    if (seen) {
      seen.lastSeen = now;
      seen.count = (seen.count ?? 1) + 1;
      if (IGNORE_LEDGER) novel.push(f);
      continue;
    }
    ledger[f.key] = { firstSeen: now, lastSeen: now, count: 1, role: f.role, path: f.path, check: f.check, summary: f.summary };
    novel.push(f);
  }

  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(join(RUN_DIR, "findings.json"), JSON.stringify(novel, null, 2));
  writeFileSync(join(RUN_DIR, "all-findings.json"), JSON.stringify(all, null, 2));
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));

  const bySeverity = (list, s) => list.filter((f) => f.severity === s).length;
  console.log(`\n${all.length} finding(s) measured, ${novel.length} not seen before`);
  console.log(`  high ${bySeverity(novel, "high")} · medium ${bySeverity(novel, "medium")} · low ${bySeverity(novel, "low")}`);
  for (const f of novel.filter((x) => x.severity === "high").slice(0, 12)) {
    console.log(`  HIGH ${f.path} [${f.viewportClass}] ${f.summary.slice(0, 110)}`);
  }
  console.log(`\nNew findings : ${join(RUN_DIR, "findings.json")}`);
  console.log(`Ledger       : ${LEDGER_PATH}`);
  console.log(`Read them, delete the rows you do not agree with, then file:`);
  console.log(`  node scripts/qa-file-findings-to-linear.mjs ${join(RUN_DIR, "findings.json")}`);
}

await main();
