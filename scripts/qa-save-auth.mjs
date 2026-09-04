#!/usr/bin/env node
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE =
  process.env.QA_BASE_URL ??
  (process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "http://localhost:3011");

const ROLES = [
  ["manager", "manager@test.proplane.local", "TestManager123!", "/portal/dashboard"],
  ["admin", "admin@test.proplane.local", "TestAdmin123!", "/admin/dashboard"],
  ["resident", "resident@test.proplane.local", "TestResident123!", "/resident/dashboard"],
  ["vendor", "vendor@test.proplane.local", "TestVendor123!", "/vendor/dashboard"],
];

const OUT = join(process.cwd(), ".lavish/qa-auth");
mkdirSync(OUT, { recursive: true });

function isAuthGatePath(pathname) {
  return pathname.startsWith("/auth/sign-in") || pathname.startsWith("/auth/continue");
}

const browser = await chromium.launch();
for (const [role, email, pass, next] of ROLES) {
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  await page.goto(`/auth/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(pass);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/auth/sign-in"), { timeout: 120_000 });
  if (page.url().includes("/auth/continue")) {
    await page.waitForURL((u) => !u.pathname.startsWith("/auth/continue"), { timeout: 120_000 });
  }
  const destPath = next.split("?")[0];
  const portalPrefix = `/${destPath.split("/").filter(Boolean)[0]}`;
  await page.waitForURL((u) => u.pathname.startsWith(portalPrefix), { timeout: 120_000 });
  const warmPath =
    next.startsWith("/portal/") ? "/portal/properties/listed"
    : next.startsWith("/resident/") ? "/resident/payments"
    : next.startsWith("/vendor/") ? "/vendor/work-orders"
    : next.startsWith("/admin/") ? "/admin/properties"
    : next;
  if (warmPath !== destPath) {
    await page.goto(warmPath, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForURL((u) => u.pathname.startsWith(portalPrefix), { timeout: 45_000 });
  }
  const finalUrl = page.url();
  const ok = new URL(finalUrl).pathname.startsWith(portalPrefix);
  await ctx.storageState({ path: join(OUT, `${role}.json`) });
  console.log(role, "->", finalUrl, ok ? "OK" : "WARN");
  await ctx.close();
}
await browser.close();
