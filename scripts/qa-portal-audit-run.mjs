#!/usr/bin/env node
/**
 * Full portal QA sweep — screenshots + console errors.
 * Usage: node scripts/qa-portal-audit-run.mjs [--base http://localhost:3000]
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MANAGER_PATHS = [
  { label: "Dashboard", path: "/portal/dashboard" },
  { label: "Properties listed", path: "/portal/properties/listed" },
  { label: "Properties drafts", path: "/portal/properties/drafts" },
  { label: "Tours pending", path: "/portal/tours/pending" },
  { label: "Applications pending", path: "/portal/applications/pending" },
  { label: "Background checks", path: "/portal/background-checks/pending_review" },
  { label: "Leases", path: "/portal/leases" },
  { label: "Residents", path: "/portal/residents/current" },
  { label: "Payments incoming", path: "/portal/payments/incoming/pending" },
  { label: "Payments outgoing", path: "/portal/payments/outgoing/pending" },
  { label: "Services", path: "/portal/services/requests" },
  { label: "Tasks", path: "/portal/tasks" },
  { label: "Communication", path: "/portal/communication/active" },
  { label: "Calendar", path: "/portal/calendar/tours" },
  { label: "Bookings", path: "/portal/bookings" },
  { label: "Teams managers", path: "/portal/teams/managers" },
  { label: "Teams vendors", path: "/portal/teams/vendors" },
  { label: "Promotion", path: "/portal/promotion" },
  { label: "Finances income", path: "/portal/financials/income" },
  { label: "Finances expenses", path: "/portal/financials/expenses" },
  { label: "Documents library", path: "/portal/documents/library" },
  { label: "Documents leases", path: "/portal/documents/leases" },
  { label: "Feedback", path: "/portal/bugs-feedback" },
  { label: "App", path: "/portal/app" },
  { label: "Settings", path: "/portal/profile" },
];

const RESIDENT_PATHS = [
  { label: "Dashboard", path: "/resident/dashboard" },
  { label: "Tour", path: "/resident/tour" },
  { label: "Applications", path: "/resident/applications" },
  { label: "Lease", path: "/resident/lease" },
  { label: "Services", path: "/resident/services" },
  { label: "Payments", path: "/resident/payments" },
  { label: "Payments pending", path: "/resident/payments/pending" },
  { label: "House details", path: "/resident/move-in" },
  { label: "Communication", path: "/resident/communication/active" },
  { label: "Documents application", path: "/resident/documents/application" },
  { label: "Documents lease", path: "/resident/documents/lease" },
  { label: "Documents receipts", path: "/resident/documents/receipts" },
  { label: "Settings", path: "/resident/profile" },
];

const ADMIN_PATHS = [
  { label: "Dashboard", path: "/admin/dashboard" },
  { label: "Properties", path: "/admin/properties" },
  { label: "Meetings", path: "/admin/events" },
  { label: "Communication unopened", path: "/admin/communication/inbox/unopened" },
  { label: "Communication schedule", path: "/admin/communication/inbox/schedule" },
  { label: "Communication sent", path: "/admin/communication/inbox/sent" },
  { label: "Accounts", path: "/admin/axis-users" },
  { label: "Feedback", path: "/admin/bugs-feedback" },
  { label: "Settings", path: "/admin/profile" },
];

const PUBLIC_PATHS = [
  { label: "Home", path: "/" },
  { label: "Pricing", path: "/pricing" },
  { label: "Browse", path: "/browse" },
  { label: "Sign in", path: "/auth/sign-in" },
  { label: "Create account", path: "/auth/create-account?mode=create&role=manager" },
  { label: "Support", path: "/support" },
  { label: "Privacy", path: "/privacy" },
];

const VENDOR_PATHS = [
  { label: "Dashboard", path: "/vendor/dashboard" },
  { label: "Services", path: "/vendor/work-orders" },
  { label: "Tasks", path: "/vendor/tasks" },
  { label: "Calendar", path: "/vendor/calendar" },
  { label: "Communication", path: "/vendor/communication/active" },
  { label: "Finances income", path: "/vendor/financials/income" },
  { label: "Finances invoices", path: "/vendor/financials/invoices" },
  { label: "Payments", path: "/vendor/payments" },
  { label: "Documents tax", path: "/vendor/documents/tax" },
  { label: "Documents insurance", path: "/vendor/documents/insurance" },
  { label: "Documents licensing", path: "/vendor/documents/licensing" },
  { label: "Documents shared", path: "/vendor/documents/shared" },
  { label: "Settings", path: "/vendor/profile" },
];

const BASE = process.argv.includes("--base")
  ? process.argv[process.argv.indexOf("--base") + 1]
  : "http://localhost:3000";

const OUT = join(process.cwd(), ".lavish/qa-screenshots-2026-09-04");
mkdirSync(OUT, { recursive: true });

const ACCOUNTS = {
  manager: { email: "manager@test.proplane.local", password: "TestManager123!" },
  resident: { email: "resident@test.proplane.local", password: "TestResident123!" },
  vendor: { email: "vendor@test.proplane.local", password: "TestVendor123!" },
  admin: { email: "admin@test.proplane.local", password: "TestAdmin123!" },
};

const EXTRA_PATHS = { manager: [], resident: [], vendor: [] };

const ERROR_PATTERNS = [
  /application error/i,
  /something went wrong/i,
  /failed to load/i,
  /unauthorized/i,
  /403 forbidden/i,
  /404/,
  /this page could not be found/i,
  /error:/i,
];

function slug(s) {
  return s.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60).toLowerCase();
}

async function signIn(page, role, nextPath) {
  await page.goto(`${BASE}/auth/sign-in?next=${encodeURIComponent(nextPath)}`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByPlaceholder("Email").fill(ACCOUNTS[role].email);
  await page.getByPlaceholder("Password").fill(ACCOUNTS[role].password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/auth/sign-in"), { timeout: 90_000 });
  if (page.url().includes("/auth/continue")) {
    await page.waitForURL((u) => !u.pathname.startsWith("/auth/continue"), { timeout: 90_000 }).catch(() => {});
  }
}

async function auditRole(browser, role, paths, viewport) {
  const authPath = join(process.cwd(), `.lavish/qa-auth/${role}.json`);
  const storageState = existsSync(authPath) ? authPath : undefined;
  const ctx = await browser.newContext({ baseURL: BASE, viewport, storageState });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const defaultNext =
    role === "manager"
      ? "/portal/dashboard"
      : role === "resident"
        ? "/resident/dashboard"
        : role === "admin"
          ? "/admin/dashboard"
          : "/vendor/dashboard";

  if (!storageState) {
    await signIn(page, role, defaultNext);
  } else {
    await page.goto(defaultNext, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(1500);
    if (page.url().includes("/auth/sign-in")) {
      await signIn(page, role, defaultNext);
    }
  }

  const findings = [];

  for (const { label, path } of paths) {
    const consoleBefore = consoleErrors.length;
    const pageErrBefore = pageErrors.length;
    try {
      await page.goto(path, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(2000);
    } catch (e) {
      findings.push({
        role,
        label,
        path,
        viewport: `${viewport.width}x${viewport.height}`,
        kind: "runtime",
        severity: "high",
        summary: `Navigation failed: ${e.message?.slice(0, 120)}`,
        screenshot: null,
      });
      continue;
    }

    const url = new URL(page.url());
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const pathBase = path.split("?")[0].replace(/\/$/, "");
    const landed = url.pathname.replace(/\/$/, "");
    const redirected =
      !landed.startsWith(pathBase) &&
      !pathBase.startsWith(landed) &&
      !(pathBase.includes(landed) || landed.includes(pathBase.split("/").slice(0, 3).join("/")));
    const matchedError = ERROR_PATTERNS.find((re) => re.test(bodyText));
    const newConsole = consoleErrors.slice(consoleBefore);
    const newPageErr = pageErrors.slice(pageErrBefore);

    const issues = [];
    if (redirected && /sign-in|get-started/.test(url.pathname)) issues.push("Redirected to auth");
    if (matchedError) issues.push(`Visible error text: ${matchedError}`);
    if (newPageErr.length) issues.push(`Page error: ${newPageErr[0]?.slice(0, 100)}`);
    if (newConsole.some((c) => !/favicon|posthog|hydration/i.test(c)))
      issues.push(`Console: ${newConsole.find((c) => !/favicon|posthog|hydration/i.test(c))?.slice(0, 100)}`);

    // UI consistency: resident/vendor should use portal list chrome like manager
    if ((role === "resident" || role === "vendor") && viewport.width >= 1024) {
      const hasListSurface = await page.locator("[data-portal-list-surface], .portal-record-list, [class*='PortalRecord']").count();
      const hasTableOnly = await page.locator("table").count();
      const bodyLower = bodyText.toLowerCase();
      if (hasTableOnly > 0 && hasListSurface === 0 && /pending|overdue|paid|income|invoice/.test(bodyLower)) {
        issues.push("Uses raw table layout — inconsistent with manager Properties list pattern");
      }
      if (bodyText.length < 80 && !/loading|sign in/i.test(bodyText)) {
        issues.push("Nearly blank main content — possible empty render");
      }
    }

    const shotName = `${role}-${slug(label)}-${viewport.width}.png`;
    const shotPath = join(OUT, shotName);
    await page.screenshot({ path: shotPath, fullPage: false });

    if (issues.length) {
      findings.push({
        role,
        label,
        path,
        finalUrl: url.pathname,
        viewport: `${viewport.width}x${viewport.height}`,
        kind: matchedError ? "ui" : newPageErr.length ? "runtime" : "ux",
        severity: /403|404|application error/i.test(issues.join(" ")) ? "high" : "medium",
        summary: issues.join(" | "),
        screenshot: shotPath,
      });
    }
  }

  // Modal / CTA probes (manager)
  if (role === "manager" && viewport.width >= 1024) {
    await page.goto("/portal/properties/listed", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const addBtn = page.getByRole("button", { name: /add property/i }).first();
    if (await addBtn.isVisible().catch(() => false)) {
      await addBtn.click();
      await page.waitForTimeout(2000);
      const modalText = await page.locator("body").innerText();
      const shotPath = join(OUT, "manager-add-property-modal.png");
      await page.screenshot({ path: shotPath });
      if (/plan limit|upgrade|dead|nothing/i.test(modalText) || !(await page.getByPlaceholder(/address|property/i).count())) {
        const dead = !(await page.getByPlaceholder(/address|street|property/i).count()) && !/wizard|step/i.test(modalText);
        if (dead || /plan limit/i.test(modalText)) {
          findings.push({
            role: "manager",
            label: "Add property modal",
            path: "/portal/properties/listed",
            kind: "ux",
            severity: "high",
            summary: dead ? "ADD PROPERTY opens but no wizard/form visible" : "ADD PROPERTY blocked at plan limit",
            screenshot: shotPath,
          });
        }
      }
      await page.keyboard.press("Escape");
    }

    await page.goto("/portal/teams/vendors", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const addVendor = page.getByRole("button", { name: /add vendor|invite/i }).first();
    if (await addVendor.isVisible().catch(() => false)) {
      await addVendor.click();
      await page.waitForTimeout(1500);
      const shotPath = join(OUT, "manager-add-vendor-modal.png");
      await page.screenshot({ path: shotPath });
      const t = await page.locator("body").innerText();
      if (!/email|vendor|invite/i.test(t)) {
        findings.push({
          role: "manager",
          label: "Add vendor",
          path: "/portal/teams/vendors",
          kind: "ux",
          severity: "medium",
          summary: "Add vendor CTA did not surface invite form",
          screenshot: shotPath,
        });
      }
      await page.keyboard.press("Escape");
    }
  }

  await ctx.close();
  return findings;
}

async function auditPublic(browser, paths, viewport) {
  const ctx = await browser.newContext({ baseURL: BASE, viewport });
  const page = await ctx.newPage();
  const findings = [];
  for (const { label, path } of paths) {
    await page.goto(path, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(1500);
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const issues = [];
    const matchedError = ERROR_PATTERNS.find((re) => re.test(bodyText));
    if (matchedError) issues.push(`Visible error: ${matchedError}`);
    const shotPath = join(OUT, `public-${slug(label)}-${viewport.width}.png`);
    await page.screenshot({ path: shotPath });
    if (issues.length) {
      findings.push({
        role: "public",
        label,
        path,
        viewport: `${viewport.width}x${viewport.height}`,
        kind: "ui",
        severity: "medium",
        summary: issues.join(" | "),
        screenshot: shotPath,
      });
    }
  }
  await ctx.close();
  return findings;
}

const managerPaths = MANAGER_PATHS;
const residentPaths = RESIDENT_PATHS;
const vendorPaths = VENDOR_PATHS;

const browser = await chromium.launch();
const allFindings = [];

allFindings.push(...(await auditPublic(browser, PUBLIC_PATHS, { width: 1440, height: 900 })));
allFindings.push(...(await auditPublic(browser, PUBLIC_PATHS, { width: 390, height: 844 })));
allFindings.push(...(await auditRole(browser, "manager", managerPaths, { width: 1440, height: 900 })));
allFindings.push(...(await auditRole(browser, "admin", ADMIN_PATHS, { width: 1440, height: 900 })));
allFindings.push(...(await auditRole(browser, "resident", residentPaths, { width: 1440, height: 900 })));
allFindings.push(...(await auditRole(browser, "resident", residentPaths, { width: 390, height: 844 })));
allFindings.push(...(await auditRole(browser, "vendor", vendorPaths, { width: 1440, height: 900 })));
allFindings.push(...(await auditRole(browser, "vendor", vendorPaths, { width: 390, height: 844 })));

await browser.close();

writeFileSync(join(OUT, "findings.json"), JSON.stringify(allFindings, null, 2));
console.log(`Wrote ${allFindings.length} findings to ${join(OUT, "findings.json")}`);
for (const f of allFindings) {
  console.log(`[${f.severity}] ${f.role} ${f.label}: ${f.summary}`);
}
