#!/usr/bin/env node
/**
 * Reliable portal QA — one browser context per role, inline sign-in, screenshots.
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const BASE =
  process.env.QA_BASE_URL ??
  (process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "http://localhost:3011");
const OUT = join(process.cwd(), ".lavish/qa-screenshots-v3");
mkdirSync(OUT, { recursive: true });

const ROLES = {
  manager: {
    email: "manager@test.proplane.local",
    password: "TestManager123!",
    home: "/portal/dashboard",
    paths: [
      "/portal/dashboard", "/portal/properties/listed", "/portal/applications/pending",
      "/portal/leases", "/portal/residents/current", "/portal/payments/incoming/pending",
      "/portal/services/requests", "/portal/communication/active", "/portal/calendar/tours",
      "/portal/teams/vendors", "/portal/financials/income", "/portal/documents/library",
      "/portal/profile",
    ],
  },
  admin: {
    email: "admin@test.proplane.local",
    password: "TestAdmin123!",
    home: "/admin/dashboard",
    paths: [
      "/admin/dashboard", "/admin/properties", "/admin/events",
      "/admin/communication/inbox/unopened", "/admin/communication/inbox/schedule",
      "/admin/axis-users", "/admin/bugs-feedback", "/admin/profile",
    ],
  },
  resident: {
    email: "resident@test.proplane.local",
    password: "TestResident123!",
    home: "/resident/dashboard",
    paths: [
      "/resident/dashboard", "/resident/payments", "/resident/services",
      "/resident/lease", "/resident/communication/active", "/resident/documents/application",
      "/resident/profile",
    ],
  },
  vendor: {
    email: "vendor@test.proplane.local",
    password: "TestVendor123!",
    home: "/vendor/dashboard",
    paths: [
      "/vendor/dashboard", "/vendor/work-orders", "/vendor/calendar",
      "/vendor/communication/active", "/vendor/financials/income",
      "/vendor/payments", "/vendor/documents/tax", "/vendor/profile",
    ],
  },
};

async function login(page, email, password, next) {
  await page.goto(`${BASE}/auth/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/auth/sign-in"), { timeout: 120_000 });
  if (page.url().includes("/auth/continue")) {
    await page.waitForURL((u) => !u.pathname.startsWith("/auth/continue"), { timeout: 120_000 });
  }
}

function isAuthGatePath(pathname) {
  return pathname.startsWith("/auth/sign-in") || pathname.startsWith("/auth/continue");
}

const PUBLIC_PATHS = [
  { label: "Home", path: "/" },
  { label: "Browse legacy", path: "/browse" },
  { label: "Browse", path: "/rent/browse" },
  { label: "Pricing", path: "/pricing" },
  { label: "Sign in", path: "/auth/sign-in" },
];

const findings = [];
const browser = await chromium.launch();

for (const [role, cfg] of Object.entries(ROLES)) {
  for (const [w, h, tag] of [[1440, 900, "desktop"], [390, 844, "mobile"]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await login(page, cfg.email, cfg.password, cfg.home);
    } catch (e) {
      findings.push({ role, path: cfg.home, tag, severity: "high", kind: "runtime", summary: `Login failed: ${e.message}`, screenshot: null });
      await ctx.close();
      continue;
    }
    if (!page.url().includes(cfg.home.split("/").slice(0, 2).join("/"))) {
      findings.push({ role, path: cfg.home, tag, severity: "high", kind: "runtime", summary: `Login landed on ${page.url()}`, screenshot: null });
    }
    for (const path of cfg.paths) {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(2000);
      let url = new URL(page.url());
      if (url.pathname.startsWith("/auth/sign-in")) {
        try {
          await login(page, cfg.email, cfg.password, path);
          await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
          await page.waitForTimeout(1500);
          url = new URL(page.url());
        } catch {
          /* report below */
        }
      }
      const shot = join(OUT, `${role}-${path.replace(/\//g, "_")}-${tag}.png`);
      await page.screenshot({ path: shot, fullPage: false });
      const body = await page.locator("body").innerText();
      const issues = [];
      if (url.pathname.startsWith("/auth/sign-in")) issues.push("Session lost — redirected to auth");
      if (/404|not be found|application error|something went wrong/i.test(body)) issues.push("Error UI visible");
      if (errors.length) issues.push(`JS: ${errors[errors.length - 1].slice(0, 80)}`);
      if (role !== "manager" && /ADD PROPERTY|PortalRecordListSurface/i.test(body) === false && role === "vendor") {
        // vendor UI density check — flag sparse pages
        if (body.length < 100 && !/loading/i.test(body)) issues.push("Sparse/empty vendor page vs manager reference density");
      }
      if (issues.length) {
        findings.push({
          role,
          path,
          tag,
          label: path,
          viewport: tag,
          finalUrl: url.pathname,
          severity: issues[0].includes("404") ? "high" : "medium",
          kind: "ui",
          summary: issues.join("; "),
          screenshot: shot,
        });
      }
    }
    await ctx.close();
  }
}

for (const [w, h, tag] of [[1440, 900, "desktop"], [390, 844, "mobile"]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const { label, path } of PUBLIC_PATHS) {
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(1500);
    const shot = join(OUT, `public-${path.replace(/\//g, "_") || "home"}-${tag}.png`);
    await page.screenshot({ path: shot, fullPage: false });
    const url = new URL(page.url());
    const body = await page.locator("body").innerText();
    const issues = [];
    if (path === "/browse" && !url.pathname.startsWith("/rent/browse")) issues.push("Legacy /browse did not redirect to /rent/browse");
    if (/404|not be found/i.test(body) && !path.startsWith("/auth/")) issues.push("Error UI visible");
    if (errors.length) issues.push(`JS: ${errors[errors.length - 1].slice(0, 80)}`);
    if (issues.length) {
      findings.push({
        role: "public",
        path,
        tag,
        label,
        viewport: tag,
        finalUrl: url.pathname,
        severity: "high",
        kind: "ui",
        summary: issues.join("; "),
        screenshot: shot,
      });
    }
  }
  await ctx.close();
}

await browser.close();
writeFileSync(join(OUT, "findings.json"), JSON.stringify(findings, null, 2));
console.log(`v3: ${findings.length} findings -> ${OUT}/findings.json`);
findings.forEach((f) => console.log(`[${f.severity}] ${f.role} ${f.path} (${f.tag}): ${f.summary}`));
