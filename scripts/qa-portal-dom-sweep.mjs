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
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
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
const ACCOUNT = arg("account", null);
const ROUTE_FILTER = (arg("routes", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const IGNORE_LEDGER = flag("all");
const OUT_ROOT = resolve(arg("out", join(REPO_ROOT, ".testmanager")));
const LEDGER_PATH = join(OUT_ROOT, "ledger.json");
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const RUN_DIR = join(OUT_ROOT, "runs", `${ROLE}-${RUN_ID}`);

// Off by default: it multiplies a pass's wall clock, and an overnight loop wants
// the cheap geometric sweep on every rotation with this on the deeper ones.
const ACTIONABILITY = flag("actionability");
const ACTIONABILITY_TIMEOUT = Number(arg("actionability-timeout", "1500"));
const ACTIONABILITY_LIMIT = Number(arg("actionability-limit", "45"));
// Crawl mode: sweep the registry's routes, then sweep everything they linked to.
const CRAWL = flag("crawl");
const CRAWL_LIMIT = Number(arg("crawl-limit", "25"));
const PORTAL_PREFIX = { manager: "/portal/", resident: "/resident/", admin: "/admin/", vendor: "/vendor/" }[ROLE];

const DIALOGS = flag("dialogs");
const DIALOG_LIMIT = Number(arg("dialog-limit", "6"));
const DIALOG_OPENER_SELECTOR = 'button:visible, [role="button"]:visible';
// Anything that counts as an open panel — dialogs, but also the filter dropdowns
// and listboxes, which are what actually opened during the first dialog pass.
const PANEL_SELECTOR = '[role="dialog"]:visible, .modal-panel:visible, [role="listbox"]:visible, [data-attr*="dropdown"]:visible';
const DIALOG_SAFE = /^(filter|settings|customize|view|open|manage|columns|sort|group|more|options|display)/i;
const DIALOG_UNSAFE = /(delete|remove|send|approve|deny|reject|pay|charge|refund|invite|publish|unlist|archive|cancel|sign|submit|confirm|create|add|new|generate|import|export|upload|disconnect|revoke)/i;

const ACTIONABLE_SELECTOR = 'button:visible, a[href]:visible, [role="button"]:visible, input:visible, select:visible, textarea:visible';

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

// The sweep's own failures are kept in a separate class from the product's, so a
// crashed server can never be filed as a defect in the pages it never reached.
class HarnessFault extends Error {}

function keyOf(f) {
  const anchor = f.detail?.el ?? f.detail?.culprits?.[0]?.el ?? f.summary.slice(0, 60);
  return createHash("sha1").update([f.role, f.path, f.viewport, f.check, anchor].join("|")).digest("hex").slice(0, 12);
}

// `kind` picks the Linear label in qa-file-findings-to-linear.mjs: `runtime` files
// as Bug, everything else as Improvement. A check that proves the page is broken
// (it errored, it 500'd, you cannot reach the content) is runtime; a measurement
// that a person still has to judge is ui.
const RUNTIME_CHECKS = new Set([
  "unclickable-control",
  "dialog-unscrollable",
  "dialog-offscreen",
  "dialog-escape-ignored",
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

// Sessions are SAVED and REUSED across viewports and runs. Every sign-in costs a
// call to Supabase auth, and the dev/test project rate-limits token refresh — a
// 429 there logs the sweep out mid-run and every route after it bounces to
// sign-in. A night of passes that each signed in twice is what produced that 429;
// one stored session per role, refreshed when it stops working, does not.
const AUTH_DIR = join(OUT_ROOT, "auth");
const AUTH_MAX_AGE_MS = 40 * 60_000;

function storedSessionPath(role) {
  // Keyed on the ACCOUNT, not the role — two accounts sharing one session file is
  // how a sweep signs in as one manager and measures the other one's portal.
  return join(AUTH_DIR, `${ACCOUNT ?? role}.json`);
}

function freshStoredSession(role) {
  const file = storedSessionPath(role);
  if (!existsSync(file)) return null;
  const age = Date.now() - statSync(file).mtimeMs;
  return age < AUTH_MAX_AGE_MS ? file : null;
}

async function sweepViewport(browser, viewport, routes, probeSource, discovered = new Set()) {
  // The role decides which portal and route table to sweep; ACCOUNT decides which
  // login to sweep it as. They are usually the same, but not always: tonight the
  // seeded portfolio ended up on `manager2` while `manager` owned nothing, and a
  // sweep of an empty portal measures nothing worth reporting (PRP-345).
  const account = QA_ACCOUNTS[ACCOUNT] ?? QA_ACCOUNTS[ROLE];
  if (!account?.email) throw new Error(`No QA account for "${ACCOUNT ?? ROLE}"`);
  const home = ACCOUNT_HOME[ROLE];

  const stored = freshStoredSession(ACCOUNT ?? ROLE);
  const context = await browser.newContext({
    ...(viewport.device ?? {}),
    viewport: { width: viewport.width, height: viewport.height },
    baseURL: BASE,
    ...(stored ? { storageState: stored } : {}),
  });
  await context.addInitScript({ content: probeSource });
  const page = await context.newPage();

  // A stored session is trusted only after it PROVES it still works — an expired
  // one that is merely present would silently sweep 23 sign-in pages.
  let authed = false;
  if (stored) {
    await page.goto(`${BASE}${home}`, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    authed = !new URL(page.url()).pathname.includes("/auth/");
    console.log(authed ? "  (reused stored session)" : "  (stored session expired)");
  }
  if (!authed) {
    await signInToPortal(page, { ...account, role: ROLE, home }, BASE);
    mkdirSync(AUTH_DIR, { recursive: true });
    await context.storageState({ path: storedSessionPath(ROLE) });
  }
  await dismissDevOverlay(page).catch(() => {});

  const findings = [];
  let rowsSeen = 0;
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
      // Wait for the layout to STOP MOVING, not merely for the network to go quiet.
      // These panels hydrate, then sync, then reflow — and a measurement taken
      // mid-reflow reports a row sitting under the command bar that is 84px clear
      // a second later. That produced a finding I could not reproduce by hand,
      // which is the most expensive kind: it survives every consistency check the
      // sweep has, because the sweep was consistently early.
      let lastFingerprint = "";
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const fingerprint = await page
          .evaluate(() => {
            const sample = [...document.querySelectorAll("main *")].slice(0, 40);
            return `${document.documentElement.scrollHeight}|${sample
              .map((n) => {
                const r = n.getBoundingClientRect();
                return `${Math.round(r.x)},${Math.round(r.y)}`;
              })
              .join(";")}`;
          })
          .catch(() => "");
        if (fingerprint && fingerprint === lastFingerprint) break;
        lastFingerprint = fingerprint;
        await page.waitForTimeout(400);
      }

      const landed = new URL(page.url()).pathname;
      // A bounce to sign-in mid-sweep is almost never a routing bug — it is the
      // session dying under the sweep (the dev/test Supabase project rate-limits
      // token refresh when several lanes hammer it, and a 429 there logs everyone
      // out). One re-sign-in tells the two apart: if the route renders afterwards,
      // the session was the problem and nothing is filed; if it bounces again, the
      // route really does refuse this account and that IS the finding.
      if (landed.includes("/auth/sign-in")) {
        console.log("(session lost — re-authenticating)");
        await signInToPortal(page, { ...account, role: ROLE, home: ACCOUNT_HOME[ROLE] }, BASE);
        mkdirSync(AUTH_DIR, { recursive: true });
        await page.context().storageState({ path: storedSessionPath(ROLE) }).catch(() => {});
        await page.goto(`${BASE}${route.path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForTimeout(1500);
        if (new URL(page.url()).pathname.includes("/auth/sign-in")) {
          throw new HarnessFault(`session cannot be re-established (bounced from ${route.path} to sign-in twice)`);
        }
      }
      const settled = new URL(page.url()).pathname;
      // A section that redirects to its own default tab (/portal/leases ->
      // /portal/leases/manager) has resolved correctly; the registry just names the
      // section rather than the tab. Only a landing OUTSIDE the requested path is a
      // routing finding.
      const isDefaultTab = settled.startsWith(route.path.replace(/\/$/, "") + "/");
      if (settled !== route.path && !isDefaultTab && !settled.includes("/auth/sign-in")) {
        push({
          check: "route-redirect",
          severity: settled === "/" ? "high" : "medium",
          summary: `${route.path} landed on ${settled} instead of rendering`,
          finalUrl: page.url(),
          detail: { requested: route.path, landed: settled },
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

      // Actionability pass. Measuring geometry finds a control that LOOKS covered;
      // this asks Playwright the question a person asks — can I click it? `trial:
      // true` runs the full actionability check (visible, stable, enabled, receives
      // the event) and then does NOT click, so a sweep can interrogate a whole
      // portal without changing a single row. This is what caught the admin search
      // box that a sibling span had swallowed.
      if (ACTIONABILITY) {
        const handles = await page.locator(ACTIONABLE_SELECTOR).all();
        let checked = 0;
        for (const handle of handles) {
          if (checked >= ACTIONABILITY_LIMIT) break;
          let name = "";
          try {
            if (!(await handle.isVisible())) continue;
            // A skip link is 1px and off-screen until it is focused — it is not a
            // control anyone clicks, and reporting it fires once per page for the
            // whole portal. Same for anything parked outside the viewport.
            const box = await handle.boundingBox();
            if (!box || box.width <= 4 || box.height <= 4) continue;
            if (box.x + box.width < 0 || box.y + box.height < 0) continue;
            if (await handle.getAttribute("aria-hidden") === "true") continue;
            // A DISABLED control is correct behaviour, not a blocked one — but
            // Playwright's actionability check waits for enabled and then times
            // out, which reads identically to "something is covering it". Every
            // greyed-out primary CTA on the portal came back as unclickable until
            // this was excluded. Whether a button SHOULD be disabled is a product
            // question a sweep cannot answer; whether it can be reached is not.
            if (await handle.isDisabled().catch(() => false)) continue;
            if (await handle.getAttribute("aria-disabled") === "true") continue;
            name = ((await handle.getAttribute("aria-label")) || (await handle.innerText().catch(() => "")) || (await handle.getAttribute("data-attr")) || "").trim().replace(/\s+/g, " ").slice(0, 60);
            checked += 1;
            await handle.click({ trial: true, timeout: ACTIONABILITY_TIMEOUT });
          } catch (err) {
            const message = String(err.message).split("\n")[0];
            // A control that scrolled out from under us, or a page that navigated
            // mid-pass, is the sweep's problem and not the product's.
            if (/not attached|Element is not attached|Execution context was destroyed|navigation/i.test(message)) continue;
            push({
              check: "unclickable-control",
              severity: "high",
              summary: `"${name || "(unnamed control)"}" cannot be clicked: ${message.replace(/^locator\.click: /, "").slice(0, 120)}`,
              detail: { name, error: message.slice(0, 220) },
            });
          }
        }
      }

      // How much data was actually on the page. A portal with no rows produces
      // clean pages, empty states and disabled primary CTAs — all of which look
      // exactly like defects, and none of which are. Tonight the whole dev
      // portfolio vanished mid-sweep and the pass reported "clean" the whole way
      // down; that must never read as good news again.
      // Every in-portal link this page offers. The registry's smoke paths are one
      // route per section; the portal actually has a tab under most of them, and
      // a defect that only exists on /portal/properties/drafts is invisible to a
      // sweep that only ever opens /portal/properties/listed.
      if (CRAWL) {
        const links = await page
          .evaluate(
            (prefix) =>
              [...document.querySelectorAll("a[href]")]
                .map((a) => a.getAttribute("href") || "")
                .filter((h) => h.startsWith(prefix) && !h.includes("#") && !h.includes("?")),
            PORTAL_PREFIX,
          )
          .catch(() => []);
        for (const l of links) discovered.add(l);
      }

      rowsSeen += await page
        .evaluate(() => document.querySelectorAll('[class*="-row"], tbody tr, [role="row"], [role="listitem"], li[data-attr]').length)
        .catch(() => 0);

      // Dialog pass. Route-level measurement saturates fast — the same handful of
      // layout defects, then nothing. The bugs that are left live one click in:
      // a settings modal whose body is cut off with no scrollbar, a filter popover
      // that opens off-screen. This opens the things that only OPEN, measures what
      // appears, and presses Escape.
      //
      // It NEVER touches a control that could change state. The allow-list is by
      // intent (filter, settings, customize, view, open, manage, columns) and the
      // deny-list is belt and braces over it, because a sweep that quietly sends a
      // message or approves an application is not a sweep, it is an incident.
      if (DIALOGS) {
        const openers = await page.locator(DIALOG_OPENER_SELECTOR).all();
        let opened = 0;
        for (const opener of openers) {
          if (opened >= DIALOG_LIMIT) break;
          let label = "";
          try {
            if (!(await opener.isVisible()) || (await opener.isDisabled().catch(() => false))) continue;
            label = ((await opener.getAttribute("aria-label")) || (await opener.innerText().catch(() => "")) || (await opener.getAttribute("data-attr")) || "").trim().replace(/\s+/g, " ").slice(0, 40);
            if (!DIALOG_SAFE.test(label) || DIALOG_UNSAFE.test(label)) continue;
            await opener.click({ timeout: 3000 });
            opened += 1;
            await page.waitForTimeout(900);
            const dialogFindings = await page.evaluate(() => {
              const panel = document.querySelector('[role="dialog"], .modal-panel, [data-state="open"][role="menu"], [role="listbox"]');
              if (!panel) return null;
              const out = [];
              const r = panel.getBoundingClientRect();
              // A dialog taller than the window with nothing to scroll it is the
              // "I can't scroll in task settings" shape.
              const scroller = [panel, ...panel.querySelectorAll("*")].find((n) => {
                const st = getComputedStyle(n);
                return /(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 4;
              });
              if (r.height > innerHeight + 4 && !scroller) {
                out.push({ check: "dialog-unscrollable", severity: "high", summary: `A dialog is ${Math.round(r.height - innerHeight)}px taller than the window with nothing to scroll it` });
              }
              if (r.left < -4 || r.right > innerWidth + 4 || r.top < -4) {
                out.push({ check: "dialog-offscreen", severity: "high", summary: `A dialog opens partly off-screen (left ${Math.round(r.left)}, right ${Math.round(r.right)}, top ${Math.round(r.top)}, window ${innerWidth}×${innerHeight})` });
              }
              const focusables = panel.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
              if (!focusables.length) {
                out.push({ check: "dialog-no-focusable", severity: "medium", summary: "A dialog opens with nothing focusable inside it" });
              }
              return out;
            });
            for (const f of dialogFindings ?? []) {
              push({ ...f, summary: `${f.summary} — opened by "${label}"`, detail: { opener: label } });
            }
            await page.keyboard.press("Escape").catch(() => {});
            await page.waitForTimeout(500);
            // If Escape did not close it, say so and stop opening things on this
            // route — a trapped dialog is both a finding and a reason not to keep
            // clicking underneath one.
            const stillOpen = await page.locator(PANEL_SELECTOR).count().catch(() => 0);
            // Escape not closing a panel is only a defect if there is no other way
            // out. The portal filter sheet opts out of Escape and outside-click on
            // purpose and offers a header X that works — so this check reported a
            // deliberate design as a bug on 15 surfaces (PRP-386, since corrected).
            const hasCloseControl = stillOpen
              ? await page
                  .locator(`${PANEL_SELECTOR} >> button[aria-label*="close" i], ${PANEL_SELECTOR} >> [data-attr*="close"]`)
                  .count()
                  .catch(() => 0)
              : 0;
            if (stillOpen && !hasCloseControl) {
              push({
                check: "dialog-escape-ignored",
                severity: "medium",
                summary: `A dialog opened by "${label}" does not close on Escape`,
                detail: { opener: label },
              });
              break;
            }
          } catch (err) {
            const message = String(err.message).split("\n")[0];
            if (/not attached|destroyed|navigation|Timeout/i.test(message)) continue;
            push({ check: "dialog-open-failed", severity: "medium", summary: `Opening "${label}" failed: ${message.slice(0, 110)}`, detail: { opener: label } });
          }
        }
      }

      // Leave nothing open. An open filter dropdown legitimately covers the rows
      // beneath it, so measuring the page underneath one reports the dropdown as
      // a defect — the dialog pass's first run did exactly that on Payments and
      // Tasks. If Escape did not clear it, reload rather than measure a page the
      // sweep itself disturbed.
      if (DIALOGS) {
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(300);
        if (await page.locator(PANEL_SELECTOR).count().catch(() => 0)) {
          await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
          await page.waitForTimeout(1500);
        }
      }

      const top = await page.evaluate(() => globalThis.__tmProbe?.());
      // Sticky chrome only collides once the page is scrolled — the floating bulk
      // bar meeting the phone tab bar is invisible from the top of the page.
      //
      // Scroll EVERY scrollable container, not just the window. The portal's lists
      // scroll inside `portal-list-page-scroll`, so a window-only scroll leaves the
      // list mid-way and measures rows that are passing under the fixed nav at that
      // moment. That is transient and expected, and reporting it as "the last row is
      // permanently unreachable" is a claim the measurement does not support — it
      // put a wrong comment on PRP-359 before this was fixed.
      await page.evaluate(() => {
        for (const n of document.querySelectorAll("*")) {
          const st = getComputedStyle(n);
          if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 4) n.scrollTop = n.scrollHeight;
        }
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
      await page.waitForTimeout(600);
      // The scrolled pass does NOT re-run obscured-control. Scrolling a list makes
      // its own header row slide under the page's sticky header — which is what
      // scrolling IS, not a defect — and reporting it produced 56 findings blaming
      // `header.hidden.h-14` for covering the very tab chips the user just scrolled
      // past. "Covered" is only meaningful where the page rests: if a control is
      // unreachable as the page presents itself, that is a bug; if it is under
      // chrome because you scrolled it there, that is a scrollbar.
      const bottom = await page.evaluate(() => globalThis.__tmProbe?.({ skip: ["duplicate-control", "tiny-tap-target"] }));
      // A control counts as unreachable only if it is covered BOTH where the page
      // rests AND once everything has been scrolled to its end. Covered at rest
      // alone just means "further down a long list"; covered after scrolling alone
      // means it slid under sticky chrome, which is what scrolling is. Only the
      // intersection is a control a person cannot get to — and that intersection
      // is what the two verified findings (the admin search box, the screening
      // toggle) sit in, while the false positives sit in exactly one side.
      const coveredAtRest = new Set(
        (top?.findings ?? []).filter((f) => f.check === "obscured-control").map((f) => f.detail?.el),
      );
      for (const f of top?.findings ?? []) {
        if (f.check === "obscured-control") continue;
        push(f);
      }
      // Geometry alone has been wrong every time it was checked by hand: a row
      // mid-reflow, a chip under a header, a checkbox that a trial click reaches
      // perfectly well. So geometry now only NOMINATES a control, and Playwright
      // decides — the same actionability question a person asks by clicking.
      // Both verified findings (the admin search box, the screening toggle) fail
      // that click; every false positive passed it.
      const nominated = (bottom?.findings ?? []).filter(
        (f) => f.check === "obscured-control" && coveredAtRest.has(f.detail?.el),
      );
      for (const f of bottom?.findings ?? []) {
        if (f.check === "obscured-control") continue;
        push(f);
      }
      for (const f of nominated) {
        const anchor = String(f.detail?.el ?? "");
        const attr = anchor.match(/\[data-attr="([^"]+)"\]/)?.[1];
        let confirmed = false;
        try {
          const locator = attr
            ? page.locator(`[data-attr="${attr}"]`).first()
            : page.getByText(String(f.summary.split('"')[1] ?? "").slice(0, 40), { exact: false }).first();
          await locator.click({ trial: true, timeout: 2000 });
        } catch (err) {
          confirmed = !/not attached|destroyed|navigation|strict mode|resolved to/i.test(String(err.message));
        }
        // Confirmed by the click: report it as measured. Not confirmed: keep it,
        // but marked and demoted. Dropping it outright silently lost the screening
        // toggle (PRP-383) on one run, and a sweep that can quietly discard a real
        // finding is worse than one that reports a soft one — the first failure is
        // invisible, the second is a line someone reads and dismisses.
        if (confirmed) push(f);
        else push({ ...f, severity: "low", suspected: true, summary: `${f.summary} (geometry only — a trial click reached it, so treat as unconfirmed)` });
      }

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
      // A dead server or a dead session is ONE fault, not one bug per remaining
      // route. Emitting a finding per route is how an unattended run turns a
      // crashed dev server into forty tickets nobody can act on, so the pass stops
      // here and says what actually happened.
      if (err instanceof HarnessFault || /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|Target page.*closed|browser has been closed/i.test(String(err.message))) {
        page.off("console", onConsole);
        page.off("pageerror", onPageError);
        page.off("response", onResponse);
        throw new HarnessFault(
          `${err instanceof HarnessFault ? err.message : `server unreachable at ${BASE}`} — stopped at ${route.path} after ${findings.length} finding(s)`,
        );
      }
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

    // A degraded session does not always bounce to /auth/sign-in. It can leave the
    // shell rendering as signed-in while every data call 401s, so the page shows
    // "Listed 0" and empty panels — and a sweep then measures the layout of an
    // empty portal and reports it as defects. If the app itself refused the
    // session on this route, the route's findings are marked and kept OUT of the
    // file used for filing; they stay in all-findings.json as evidence.
    const appOrigin = new URL(BASE).origin;
    const sessionRefused = badResponses.some(
      (r) => r.url.startsWith(appOrigin) && (r.status === 401 || r.status === 403),
    );
    if (sessionRefused) {
      for (const f of local) f.degraded = true;
      console.log("(session refused by the app here — findings marked unreliable)");
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
  findings.rowsSeen = rowsSeen;
  return findings;
}

async function main() {
  const routes = loadRoutes(ROLE).filter(
    (r) => !ROUTE_FILTER.length || ROUTE_FILTER.some((f) => r.path.includes(f) || r.label.toLowerCase().includes(f.toLowerCase())),
  );
  if (!routes.length) throw new Error(`No routes matched --routes "${ROUTE_FILTER.join(",")}"`);
  if (!SELECTED_VIEWPORTS.length) throw new Error(`--viewports matched none of: ${Object.keys(VIEWPORTS).join(", ")}`);

  const probeSource = readFileSync(join(__dirname, "qa-portal-dom-probe.js"), "utf8");
  console.log(`portal DOM sweep · ${ROLE} · ${BASE} · ${routes.length} routes × ${SELECTED_VIEWPORTS.length} viewports${ACTIONABILITY ? " · actionability on" : ""}${DIALOGS ? " · dialogs on" : ""}${CRAWL ? " · crawl on" : ""}`);

  const browser = await chromium.launch({ headless: !flag("headed") });
  const all = [];
  const faults = [];
  let totalRowsSeen = 0;
  const discovered = new Set();
  try {
    for (const viewport of SELECTED_VIEWPORTS) {
      try {
        const viewportFindings = await sweepViewport(browser, viewport, routes, probeSource, discovered);
        totalRowsSeen += viewportFindings.rowsSeen ?? 0;
        all.push(...viewportFindings);
      } catch (err) {
        if (!(err instanceof HarnessFault)) throw err;
        // Keep whatever the other viewports can still measure; report the fault
        // loudly at the end so it is never mistaken for a clean pass.
        console.log(`\n  !! ${viewport.name} pass aborted — ${err.message}`);
        faults.push(`${viewport.name}: ${err.message}`);
      }
    }
    // Second lap over what the first lap linked to, at one viewport — the point is
    // route coverage, not a third measurement of the same page at three widths.
    if (CRAWL) {
      const known = new Set(routes.map((r) => r.path));
      // Prefer routes that go DEEPER than a route already swept — those are the
      // status tabs and buckets (/portal/properties/drafts, /portal/tasks/overdue)
      // that the registry's one-path-per-section list never reaches. Sibling
      // sections are already in the registry, so they add nothing.
      const deepens = (p) => [...known].some((k) => p.startsWith(k.replace(/\/$/, "") + "/") || p.startsWith(k.split("/").slice(0, 3).join("/") + "/"));
      const candidates = [...discovered].filter((p) => !known.has(p));
      const extra = [...candidates.filter(deepens), ...candidates.filter((p) => !deepens(p))]
        .slice(0, CRAWL_LIMIT)
        .map((p) => ({ label: p.split("/").filter(Boolean).slice(1).join(" ") || p, path: p }));
      if (extra.length) {
        console.log(`\ncrawl: ${extra.length} route(s) the registry does not list`);
        try {
          const crawlFindings = await sweepViewport(browser, SELECTED_VIEWPORTS[0], extra, probeSource);
          totalRowsSeen += crawlFindings.rowsSeen ?? 0;
          all.push(...crawlFindings);
        } catch (err) {
          if (!(err instanceof HarnessFault)) throw err;
          console.log(`\n  !! crawl aborted — ${err.message}`);
          faults.push(`crawl: ${err.message}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  const ledger = loadLedger();
  const now = new Date().toISOString();
  const novel = [];
  const degraded = all.filter((f) => f.degraded);
  for (const f of all) {
    // Never offer a finding for filing that was measured while the app was
    // refusing the session — an empty portal's layout is not the product's layout.
    if (f.degraded) continue;
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

  if (totalRowsSeen === 0) {
    console.log(`\nTHIS PORTAL HAD NO DATA. Not one row on any route, at any viewport.`);
    console.log(`  A clean result here is not evidence of anything — an empty portal renders empty`);
    console.log(`  states and greys out its primary actions, which reads as defects either way.`);
    console.log(`  Seed it (npm run test:seed) and sweep again before believing this run.`);
  }
  if (degraded.length) {
    const routes = [...new Set(degraded.map((f) => f.route ?? f.path))];
    console.log(`\n${degraded.length} finding(s) on ${routes.length} route(s) were measured while the app refused the session (401/403) and are NOT offered for filing:`);
    console.log(`  ${routes.join(", ")}`);
    console.log(`  They are in all-findings.json. Re-run those routes with a good session before believing them.`);
  }
  const bySeverity = (list, s) => list.filter((f) => f.severity === s).length;
  console.log(`\n${all.length} finding(s) measured, ${novel.length} not seen before`);
  console.log(`  high ${bySeverity(novel, "high")} · medium ${bySeverity(novel, "medium")} · low ${bySeverity(novel, "low")}`);
  for (const f of novel.filter((x) => x.severity === "high").slice(0, 12)) {
    console.log(`  HIGH ${f.path} [${f.viewportClass}] ${f.summary.slice(0, 110)}`);
  }
  if (faults.length) {
    console.log(`\nHARNESS FAULTS — these are the sweep failing, NOT product defects. Do not file them:`);
    for (const f of faults) console.log(`  !! ${f}`);
    console.log(`  Fix the environment and re-run; the routes after the fault were never measured.`);
  }
  console.log(`\nNew findings : ${join(RUN_DIR, "findings.json")}`);
  console.log(`Ledger       : ${LEDGER_PATH}`);
  console.log(`Read them, delete the rows you do not agree with, then file:`);
  console.log(`  node scripts/qa-file-findings-to-linear.mjs ${join(RUN_DIR, "findings.json")}`);
}

await main().catch((err) => {
  console.error(`\nSweep could not run: ${err.message}`);
  process.exit(1);
});
