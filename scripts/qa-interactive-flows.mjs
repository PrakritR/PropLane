#!/usr/bin/env node
/** Interactive flow QA — apply, browse listing, manager application review */
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
const SHOT = join(REPO, "docs/linear/qa-screenshots", DATE);
const FILE = process.argv.includes("--file-tickets");
mkdirSync(SHOT, { recursive: true });
const findings = [];
let n = 300;

function add(f) { findings.push(f); }
async function cap(page, slug) {
  const p = join(SHOT, `flow-${++n}-${slug}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function signIn(page, email, pw, role, home) {
  await page.goto(`${BASE}/auth/sign-in?next=${encodeURIComponent(home)}`);
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(pw);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForTimeout(3500);
  const L = { manager: "Property", resident: "Resident" };
  if (!page.url().includes(home.split("/")[1]) && L[role]) {
    await page.goto(`${BASE}/auth/choose-portal?next=${encodeURIComponent(home)}`);
    const b = page.getByRole("button", { name: new RegExp(`^${L[role]}\\b`) });
    if (await b.count()) await b.first().click();
    await page.waitForTimeout(2000);
  }
}

async function fileAll() {
  const open = await loadOpenIssueTitles();
  for (const f of findings) {
    if (isDuplicateFinding(f, open).duplicate) continue;
    let img = "";
    if (f.screenshot && existsSync(f.screenshot)) {
      try { img = `\n\n![screenshot](${await uploadFileToLinear(f.screenshot)})`; } catch { /* */ }
    }
    const proj = { manager: "02 — Manager Portal", resident: "03 — Resident Portal", public: "12 — Marketing & Growth" }[f.portal] || "02 — Manager Portal";
    const title = f.title.startsWith("[") ? f.title : `[${f.portal}] ${f.title}`;
    const input = {
      teamId: teamId(), title,
      description: `${f.detail}${img}\n\nPath: \`${f.path}\``,
      priority: inferPriority({ title, description: f.detail, project: { name: proj }, labels: { nodes: [{ name: "Improvement" }] } }),
      projectId: await resolveProjectId(proj),
      labelIds: await resolveLabelIds(["Improvement", `portal:${f.portal}`]),
      stateId: await resolveStateId("Backlog"),
    };
    const d = await linearGraphql(`mutation($i: IssueCreateInput!) { issueCreate(input: $i) { success issue { identifier url } } }`, { input });
    console.log(d.issueCreate.issue.identifier, title.slice(0, 65));
    open.push({ identifier: d.issueCreate.issue.identifier, title, description: "" });
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  // Public browse
  await page.goto(`${BASE}/rent/browse`);
  await page.waitForTimeout(2500);
  const browse = await page.locator("body").innerText();
  if (!/browse|rent|property|listing/i.test(browse)) {
    const s = await cap(page, "browse-empty");
    add({ portal: "public", path: "/rent/browse", category: "runtime", severity: "high", title: "Public browse: no listings visible", detail: browse.slice(0, 200), screenshot: s });
  }
  const cards = page.locator('[data-attr*="listing"], a[href*="/rent/listings/"]');
  if (await cards.count()) {
    await cards.first().click();
    await page.waitForTimeout(2000);
    const detail = await page.locator("body").innerText();
    if (!/apply|tour|rent/i.test(detail)) {
      const s = await cap(page, "listing-no-cta");
      add({ portal: "public", path: "/rent/listings", category: "ux", severity: "medium", title: "Listing detail: missing Apply/Tour CTAs", detail: "", screenshot: s });
    }
  }

  // Manager — open first application if any
  await signIn(page, "manager@test.proplane.local", "TestManager123!", "manager", "/portal/applications/pending");
  await page.goto(`${BASE}/portal/applications/pending`);
  await page.waitForTimeout(2000);
  const appRow = page.locator("[data-portal-record-row], tr").filter({ hasText: /AXIS|pending|applicant/i }).first();
  if (await appRow.count()) {
    await appRow.click();
    await page.waitForTimeout(1500);
    const approve = page.getByRole("button", { name: /approve/i });
    if ((await approve.count()) === 0) {
      const s = await cap(page, "app-no-approve");
      add({ portal: "manager", path: "/portal/applications", category: "ux", severity: "medium", title: "Application detail: Approve CTA not visible on expanded row", detail: "", screenshot: s });
    }
  }

  // Resident payments — Pay CTA
  await signIn(page, "resident@test.proplane.local", "TestResident123!", "resident", "/resident/payments");
  await page.goto(`${BASE}/resident/payments`);
  await page.waitForTimeout(2000);
  const pay = page.getByRole("button", { name: /^pay\b|make payment|pay now/i });
  if (await pay.count()) {
    await pay.first().click();
    await page.waitForTimeout(1500);
    const modal = await page.locator("body").innerText();
    if (/error|failed|something went wrong/i.test(modal)) {
      const s = await cap(page, "pay-flow-error");
      add({ portal: "resident", path: "/resident/payments", category: "runtime", severity: "high", title: "Resident Pay flow opens with error", detail: modal.slice(0, 250), screenshot: s });
    }
  }

  await browser.close();
  writeFileSync(join(REPO, "docs/linear/manifests", `qa-flows-${DATE}.json`), JSON.stringify(findings, null, 2));
  console.log(`Flow findings: ${findings.length}`);
  if (FILE) await fileAll();
}

main();
