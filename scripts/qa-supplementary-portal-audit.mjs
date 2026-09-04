#!/usr/bin/env node
/** Supplementary QA — manager financials + admin/vendor UI depth */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { uploadFileToLinear } from "./linear/upload-file.mjs";
import { loadOpenIssueTitles, isDuplicateFinding } from "./linear/dedupe-issues.mjs";
import { inferPriority } from "./linear/triage-rules.mjs";
import { linearGraphql, resolveProjectId, resolveLabelIds, resolveStateId, teamId } from "./linear/graphql.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3010").replace(/\/$/, "");
const DATE = new Date().toISOString().slice(0, 10);
const SHOT_DIR = join(REPO, "docs/linear/qa-screenshots", DATE);
const FILE = process.argv.includes("--file-tickets");
mkdirSync(SHOT_DIR, { recursive: true });

const findings = [];
let shotN = 200;

async function signIn(page, email, password, role, home) {
  await page.goto(`${BASE}/auth/sign-in?next=${encodeURIComponent(home)}`);
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForTimeout(3000);
  const labels = { manager: "Property", admin: "Admin", vendor: "Vendor" };
  if (!page.url().includes(home.split("/")[1])) {
    await page.goto(`${BASE}/auth/choose-portal?next=${encodeURIComponent(home)}`);
    const b = page.getByRole("button", { name: new RegExp(`^${labels[role]}\\b`) });
    if (await b.count()) await b.first().click();
    await page.waitForTimeout(2000);
  }
}

function add(f) { findings.push(f); }

async function shot(page, portal, slug) {
  const p = join(SHOT_DIR, `${portal}-${++shotN}-${slug}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function fileOne(f, open) {
  const dup = isDuplicateFinding(f, open);
  if (dup.duplicate) { f.skipped = dup.match; return; }
  let img = "";
  if (f.screenshot && existsSync(f.screenshot)) {
    try { img = `![screenshot](${await uploadFileToLinear(f.screenshot)})`; } catch { /* */ }
  }
  const title = f.title.startsWith("[") ? f.title : `[${f.portal}] ${f.title}`;
  const proj = { manager: "02 — Manager Portal", admin: "05 — Admin Portal", vendor: "04 — Vendor Portal" }[f.portal];
  const input = {
    teamId: teamId(),
    title,
    description: `## ${f.category} (${f.severity})\n\nPath: \`${f.path}\`\n\n${f.detail}\n\n${img}`,
    priority: inferPriority({ title, description: f.detail, project: { name: proj }, labels: { nodes: [{ name: "Improvement" }] } }),
    projectId: await resolveProjectId(proj),
    labelIds: await resolveLabelIds(["Improvement", `portal:${f.portal}`]),
    stateId: await resolveStateId("Backlog"),
  };
  const d = await linearGraphql(`mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }`, { input });
  f.prp = d.issueCreate.issue.identifier;
  f.url = d.issueCreate.issue.url;
  open.push({ identifier: f.prp, title, description: "" });
  console.log(" ", f.prp, title.slice(0, 70));
}

async function main() {
  const browser = await chromium.launch({ headless: true });

  // Manager — all financial sub-tabs
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await signIn(page, "manager@test.proplane.local", "TestManager123!", "manager", "/portal/dashboard");
  const finTabs = [
    "income", "expenses", "trial-balance", "balance-sheet", "general-ledger",
    "cash-flow-statement", "payout-history", "trust-account-balance", "security-deposits",
    "financial-diagnostics", "ap-aging", "bills", "budget-vs-actual", "bank-reconciliation",
    "owner-statement", "owner-distributions",
  ];
  console.log("Manager financials…");
  for (const tab of finTabs) {
    const path = `/portal/financials/${tab}`;
    await page.goto(`${BASE}${path}`);
    await page.waitForTimeout(1200);
    const body = await page.locator("body").innerText();
    if (/something went wrong|404|not found/i.test(body)) {
      const s = await shot(page, "manager", `fin-${tab}-error`);
      add({ portal: "manager", path, category: "runtime", severity: "high", title: `Finances ${tab}: error page`, detail: body.slice(0, 200), screenshot: s });
    }
    if (body.length < 40 && !/no |empty|upgrade|paywall/i.test(body)) {
      const s = await shot(page, "manager", `fin-${tab}-blank`);
      add({ portal: "manager", path, category: "ui", severity: "low", title: `Finances ${tab}: blank screen`, detail: "", screenshot: s });
    }
  }

  // Applications — all status tabs
  for (const tab of ["pending", "approved", "denied", "withdrawn"]) {
    const path = `/portal/applications/${tab}`;
    await page.goto(`${BASE}${path}`);
    await page.waitForTimeout(1200);
    const body = await page.locator("body").innerText();
    if (body.length < 30 && tab === "pending") {
      const s = await shot(page, "manager", `apps-${tab}-blank`);
      add({ portal: "manager", path, category: "ui", severity: "medium", title: `Applications ${tab}: no empty-state copy`, detail: "", screenshot: s });
    }
  }

  await ctx.close();

  // Admin UI depth
  let actx;
  let ap;
  try {
  actx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  ap = await actx.newPage();
  await signIn(ap, "admin@test.proplane.local", "TestAdmin123!", "admin", "/admin/dashboard");
  console.log("Admin UI…");
  const adminChecks = [
    ["/admin/communication/inbox/unopened", "Admin inbox unopened", /unopened|inbox|email|no /i],
    ["/admin/axis-users", "Admin accounts", /manager|resident|vendor|create/i],
    ["/admin/properties", "Admin properties", /propert|address|no /i],
    ["/admin/events", "Admin meetings", /meeting|event|calendar|no /i],
  ];
  for (const [path, label, pattern] of adminChecks) {
    await ap.goto(`${BASE}${path}`);
    await ap.waitForTimeout(1500);
    const body = await ap.locator("body").innerText();
    const html = await ap.content();
    const hasFilterPills = /filter|status|pill|unopened|opened/i.test(body) || html.includes("PORTAL_TOOLBAR");
    if (path.includes("inbox") && !hasFilterPills) {
      const s = await shot(ap, "admin", "inbox-no-filters");
      add({ portal: "admin", path, category: "ui", severity: "medium", title: "Admin inbox missing status filter pills row", detail: "Reference: admin-bug-feedback + portal-ui-system admin table tabs", screenshot: s });
    }
    if (!pattern.test(body) && body.length < 50) {
      const s = await shot(ap, "admin", label.replace(/\s+/g, "-").toLowerCase());
      add({ portal: "admin", path, category: "ui", severity: "medium", title: `${label}: sparse/empty UI`, detail: body.slice(0, 150), screenshot: s });
    }
  }
  // Admin accounts — create manager CTA
  await ap.goto(`${BASE}/admin/axis-users`);
  await ap.waitForTimeout(1500);
  if ((await ap.getByRole("button", { name: /create|add manager/i }).count()) === 0) {
    const s = await shot(ap, "admin", "accounts-no-create");
    add({ portal: "admin", path: "/admin/axis-users", category: "ux", severity: "low", title: "Admin Accounts: no obvious Create manager/resident CTA", detail: "", screenshot: s });
  }
  await actx.close();
  } catch (e) {
    console.warn("Admin section error:", e.message);
    try { await actx?.close(); } catch { /* */ }
  }

  // Vendor mobile UI
  let vctx;
  try {
  vctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const vp = await vctx.newPage();
  await signIn(vp, "vendor@test.proplane.local", "TestVendor123!", "vendor", "/vendor/dashboard");
  console.log("Vendor mobile…");
  for (const [path, label] of [["/vendor/work-orders", "Services"], ["/vendor/financials/invoices", "Invoices"], ["/vendor/payments", "Payments"]]) {
    await vp.goto(`${BASE}${path}`);
    await vp.waitForTimeout(1500);
    const body = await vp.locator("body").innerText();
    // Manager uses record rows; vendor may use cramped mobile table
    if (htmlIncludesTableWithoutCards(await vp.content()) && path.includes("work-orders")) {
      const s = await shot(vp, "vendor", `mobile-${label}-table`);
      add({ portal: "vendor", path, category: "ui", severity: "medium", title: `Vendor ${label} (mobile): horizontal table — not manager-style cards`, detail: "390px width", screenshot: s });
    }
    if (/overflow|scroll/i.test(body) === false && (await vp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth))) {
      const s = await shot(vp, "vendor", `mobile-${label}-overflow`);
      add({ portal: "vendor", path, category: "ui", severity: "medium", title: `Vendor ${label} (mobile): horizontal overflow`, detail: "", screenshot: s });
    }
  }
  await vctx.close();
  } catch (e) {
    console.warn("Vendor mobile error:", e.message);
    try { await vctx?.close(); } catch { /* */ }
  }
  await browser.close();

  console.log(`Supplementary findings: ${findings.length}`);
  const out = join(REPO, "docs/linear/manifests", `qa-supplementary-${DATE}.json`);
  writeFileSync(out, JSON.stringify(findings, null, 2));

  if (FILE) {
    const open = await loadOpenIssueTitles();
    for (const f of findings) await fileOne(f, open);
  }
}

function htmlIncludesTableWithoutCards(html) {
  return /<table/i.test(html) && !/data-portal-record-row|PortalPropertyRecordRow/i.test(html);
}

main().catch((e) => { console.error(e); process.exit(1); });
