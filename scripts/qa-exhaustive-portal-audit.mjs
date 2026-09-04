#!/usr/bin/env node
/**
 * Exhaustive portal QA — manager, resident, vendor, admin.
 * Screenshots → docs/linear/qa-screenshots/<date>/
 * Findings → docs/linear/manifests/qa-exhaustive-<date>.json
 *
 *   PLAYWRIGHT_BASE_URL=http://localhost:3010 node scripts/qa-exhaustive-portal-audit.mjs
 *   ... --file-tickets   # dedupe + create Linear issues with screenshot embeds
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { uploadFileToLinear } from "./linear/upload-file.mjs";
import { loadOpenIssueTitles, isDuplicateFinding } from "./linear/dedupe-issues.mjs";
import { inferPriority } from "./linear/triage-rules.mjs";
import {
  linearGraphql,
  resolveProjectId,
  resolveProjectMilestoneId,
  resolveLabelIds,
  resolveStateId,
  teamId,
} from "./linear/graphql.mjs";
import { signInToPortal } from "./qa-portal-sign-in.mjs";
import { qaPortalAccounts } from "../tests/fixtures/qa-accounts.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const BASE = (process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3010").replace(/\/$/, "");
const DATE = new Date().toISOString().slice(0, 10);
const FILE_TICKETS = process.argv.includes("--file-tickets");
const SHOT_DIR = join(REPO, "docs/linear/qa-screenshots", DATE);
const OUT_JSON = join(REPO, "docs/linear/manifests", `qa-exhaustive-${DATE}.json`);
const OUT_MD = join(REPO, "docs/linear/manifests", `qa-exhaustive-${DATE}.md`);

mkdirSync(SHOT_DIR, { recursive: true });

// Hardcoding these is how an audit ends up signing in as an account that does
// not exist and filing every authenticated page as a product bug. One source:
// tests/fixtures/qa-accounts.mjs, checked by `npm run test:accounts:check`.
const ACCOUNTS = qaPortalAccounts();

/** @type {import('./qa-exhaustive-types').Finding[]} */
const findings = [];
let shotSeq = 0;
let findingSeq = 0;

function portalProject(portal) {
  const map = {
    manager: "02 — Manager Portal",
    resident: "03 — Resident Portal",
    vendor: "04 — Vendor Portal",
    admin: "05 — Admin Portal",
  };
  return map[portal] || "02 — Manager Portal";
}

function addFinding(f) {
  findings.push({
    id: `EX-${++findingSeq}`,
    ...f,
  });
}

async function screenshot(page, portal, slug) {
  const name = `${portal}-${String(++shotSeq).padStart(3, "0")}-${slug}.png`;
  const path = join(SHOT_DIR, name);
  await page.screenshot({ path, fullPage: false });
  return path;
}

async function signIn(page, account) {
  await signInToPortal(page, account, BASE);
}

async function visit(page, portal, path, label, account) {
  const consoleErrors = [];
  const pageErrors = [];
  const onConsole = (m) => { if (m.type() === "error") consoleErrors.push(m.text()); };
  const onPageError = (e) => pageErrors.push(String(e));
  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  const res = await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => null);
  await page.waitForTimeout(1500);

  if (page.url().includes("/auth/sign-in")) {
    await signIn(page, account);
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(1500);
  }

  const body = await page.locator("body").innerText();
  const pathname = new URL(page.url()).pathname;

  if (pathname.includes("/auth/sign-in")) {
    const shot = await screenshot(page, portal, `${label}-signin-bounce`.replace(/\s+/g, "-").toLowerCase());
    addFinding({ portal, path, category: "runtime", severity: "high", title: `${label}: session lost`, detail: `Bounced to sign-in from ${path}`, screenshot: shot });
  }
  if (res && res.status() >= 400) {
    const shot = await screenshot(page, portal, `${label}-http-${res.status()}`.replace(/\s+/g, "-").toLowerCase());
    addFinding({ portal, path, category: "runtime", severity: "high", title: `${label}: HTTP ${res.status()}`, detail: page.url(), screenshot: shot });
  }
  if (/something went wrong|unexpected error/i.test(body)) {
    const shot = await screenshot(page, portal, `${label}-error-copy`.replace(/\s+/g, "-").toLowerCase());
    addFinding({ portal, path, category: "runtime", severity: "high", title: `${label}: error message on page`, detail: body.slice(0, 300), screenshot: shot });
  }

  for (const err of [...new Set(consoleErrors)].slice(0, 3)) {
    if (/favicon|hydration|devtools|posthog|ResizeObserver|Failed to fetch.*auth-js/i.test(err)) continue;
    if (/403.*Forbidden/i.test(err) && portal === "vendor") {
      const shot = await screenshot(page, portal, `${label}-403`.replace(/\s+/g, "-").toLowerCase());
      addFinding({ portal, path, category: "runtime", severity: "medium", title: `${label}: 403 in console`, detail: err.slice(0, 400), screenshot: shot });
      continue;
    }
    if (/403|401|500|TypeError|ReferenceError/i.test(err)) {
      const shot = await screenshot(page, portal, `${label}-console`.replace(/\s+/g, "-").toLowerCase());
      addFinding({ portal, path, category: "runtime", severity: "medium", title: `${label}: console error`, detail: err.slice(0, 400), screenshot: shot });
    }
  }
  for (const err of pageErrors) {
    const shot = await screenshot(page, portal, `${label}-exception`.replace(/\s+/g, "-").toLowerCase());
    addFinding({ portal, path, category: "runtime", severity: "high", title: `${label}: uncaught exception`, detail: err.slice(0, 400), screenshot: shot });
  }

  page.off("console", onConsole);
  page.off("pageerror", onPageError);
  return { body, pathname };
}

/** Resident/vendor should mirror manager list density — flag obvious gaps */
async function checkListSurfaceUI(page, portal, path, label, reference = "manager") {
  if (portal === "manager") return;
  const body = await page.locator("body").innerText();
  const hasTableOnly = /thead|tbody/.test(await page.content()) && !/ADD|add/i.test(body);
  const barePage = body.length < 80 && !/no |empty|get started/i.test(body);
  if (barePage) {
    const shot = await screenshot(page, portal, `${label}-bare-ui`.replace(/\s+/g, "-").toLowerCase());
    addFinding({
      portal, path, category: "ui", severity: "medium",
      title: `[${portal}] ${label}: page looks empty — not manager-style empty state`,
      detail: `Compare to ${reference} portal list surfaces (Properties reference). len=${body.length}`,
      screenshot: shot,
    });
  }
  if (portal !== "admin" && hasTableOnly && /resident|vendor/.test(portal)) {
    const shot = await screenshot(page, portal, `${label}-table-not-cards`.replace(/\s+/g, "-").toLowerCase());
    addFinding({
      portal, path, category: "ui", severity: "low",
      title: `[${portal}] ${label}: raw table layout — inconsistent with manager Properties rows`,
      detail: "Manager portal uses PortalRecordListSurface / flat rows; this tab may still be legacy table.",
      screenshot: shot,
    });
  }
}

async function managerFlows(page, account) {
  console.log("\n=== Manager flows ===");
  const paths = [
    ["/portal/dashboard", "Dashboard"],
    ["/portal/properties/listed", "Properties listed"],
    ["/portal/properties/drafts", "Properties drafts"],
    ["/portal/properties/unlisted", "Properties unlisted"],
    ["/portal/tours/pending", "Tours pending"],
    ["/portal/tours/confirmed", "Tours confirmed"],
    ["/portal/applications/pending", "Applications pending"],
    ["/portal/applications/approved", "Applications approved"],
    ["/portal/background-checks/pending_review", "Background checks"],
    ["/portal/leases", "Leases"],
    ["/portal/residents/current", "Residents"],
    ["/portal/payments/incoming/pending", "Payments incoming"],
    ["/portal/payments/outgoing/pending", "Payments outgoing"],
    ["/portal/services/requests", "Services"],
    ["/portal/tasks", "Tasks"],
    ["/portal/calendar", "Calendar"],
    ["/portal/bookings", "Bookings"],
    ["/portal/communication/active", "Communication"],
    ["/portal/teams/managers", "Teams managers"],
    ["/portal/teams/vendors", "Teams vendors"],
    ["/portal/promotion", "Promotion"],
    ["/portal/financials/income", "Finances income"],
    ["/portal/financials/expenses", "Finances expenses"],
    ["/portal/financials/general-ledger", "Finances GL"],
    ["/portal/financials/cash-flow-statement", "Finances cash flow"],
    ["/portal/documents/library", "Documents library"],
    ["/portal/documents/templates", "Documents templates"],
    ["/portal/documents/applications", "Documents applications"],
    ["/portal/bugs-feedback", "Feedback"],
    ["/portal/app", "App"],
    ["/portal/profile", "Settings"],
  ];
  for (const [path, label] of paths) {
    process.stdout.write(`  ${label}… `);
    await visit(page, "manager", path, label, account);
    console.log("ok");
  }

  // Add property
  await page.goto(`${BASE}/portal/properties/listed`);
  await page.waitForTimeout(1500);
  const addProp = page.getByRole("button", { name: /add property/i });
  if (await addProp.count()) {
    await addProp.first().click();
    await page.waitForTimeout(2000);
    const w = await page.locator("body").innerText();
    if (!/address|property|listing|wizard|step|pricing/i.test(w)) {
      const shot = await screenshot(page, "manager", "add-property-no-wizard");
      addFinding({ portal: "manager", path: "/portal/properties", category: "ux", severity: "high", title: "Add property does not open wizard", detail: w.slice(0, 300), screenshot: shot });
    }
    await page.keyboard.press("Escape").catch(() => {});
  }

  // Invite vendor
  await page.goto(`${BASE}/portal/teams/vendors`);
  await page.waitForTimeout(1500);
  const inviteVendor = page.getByRole("button", { name: /invite|add vendor/i });
  if ((await inviteVendor.count()) === 0) {
    const shot = await screenshot(page, "manager", "teams-vendors-no-invite");
    addFinding({ portal: "manager", path: "/portal/teams/vendors", category: "ux", severity: "low", title: "Teams vendors: no Invite/Add vendor CTA visible", detail: "", screenshot: shot });
  }

  // Residents add
  await page.goto(`${BASE}/portal/residents/current`);
  await page.waitForTimeout(1500);
  const addRes = page.getByRole("button", { name: /add resident|invite/i });
  if ((await addRes.count()) === 0 && !/no resident/i.test(await page.locator("body").innerText())) {
    const shot = await screenshot(page, "manager", "residents-no-add");
    addFinding({ portal: "manager", path: "/portal/residents/current", category: "ux", severity: "low", title: "Residents: no Add/Invite affordance on list", detail: "", screenshot: shot });
  }

  // Leases — expand first row
  await page.goto(`${BASE}/portal/leases`);
  await page.waitForTimeout(1500);
  const leaseRow = page.locator("[data-portal-record-row], tr").first();
  if (await leaseRow.count()) {
    await leaseRow.click().catch(() => {});
    await page.waitForTimeout(800);
  } else if (!/no lease|pipeline|empty/i.test(await page.locator("body").innerText())) {
    const shot = await screenshot(page, "manager", "leases-no-empty-state");
    addFinding({ portal: "manager", path: "/portal/leases", category: "ui", severity: "medium", title: "Leases: no rows and no empty-state copy", detail: "", screenshot: shot });
  }
}

async function residentFlows(page, account) {
  console.log("\n=== Resident flows ===");
  const paths = [
    ["/resident/dashboard", "Dashboard"],
    ["/resident/tour", "Tour"],
    ["/resident/applications", "Applications"],
    ["/resident/lease", "Lease"],
    ["/resident/payments", "Payments"],
    ["/resident/payments/pending", "Payments pending"],
    ["/resident/services", "Services"],
    ["/resident/move-in", "House details"],
    ["/resident/communication/active", "Communication"],
    ["/resident/documents/application", "Documents application"],
    ["/resident/documents/lease", "Documents lease"],
    ["/resident/documents/receipts", "Documents receipts"],
    ["/resident/documents/other", "Documents other"],
    ["/resident/profile", "Settings"],
  ];
  for (const [path, label] of paths) {
    process.stdout.write(`  ${label}… `);
    await visit(page, "resident", path, label, account);
    await checkListSurfaceUI(page, "resident", path, label);
    console.log("ok");
  }

  await page.goto(`${BASE}/resident/payments`);
  await page.waitForTimeout(1000);
  if (/summary|statements/i.test(await page.locator("body").innerText())) {
    const shot = await screenshot(page, "resident", "payments-legacy-tabs");
    addFinding({ portal: "resident", path: "/resident/payments", category: "ui", severity: "medium", title: "Resident payments still shows Summary/Statements tabs", detail: "Should be charges-only per portal redesign", screenshot: shot });
  }

  await page.goto(`${BASE}/resident/services`);
  await page.waitForTimeout(1000);
  if (/work order/i.test(await page.locator("body").innerText()) && !/add-on service/i.test(await page.locator("body").innerText())) {
    const shot = await screenshot(page, "resident", "services-work-order-copy");
    addFinding({ portal: "resident", path: "/resident/services", category: "ux", severity: "low", title: 'Resident Services tab still says "work order" not Add-on services', detail: "", screenshot: shot });
  }
}

async function vendorFlows(page, account) {
  console.log("\n=== Vendor flows ===");
  const paths = [
    ["/vendor/dashboard", "Dashboard"],
    ["/vendor/work-orders", "Services"],
    ["/vendor/tasks", "Tasks"],
    ["/vendor/calendar", "Calendar"],
    ["/vendor/communication/active", "Communication"],
    ["/vendor/financials/income", "Finances income"],
    ["/vendor/financials/invoices", "Invoices"],
    ["/vendor/payments", "Payments"],
    ["/vendor/documents/tax", "Documents tax"],
    ["/vendor/documents/insurance", "Documents insurance"],
    ["/vendor/documents/licensing", "Documents licensing"],
    ["/vendor/documents/shared", "Documents from managers"],
    ["/vendor/profile", "Settings"],
  ];
  for (const [path, label] of paths) {
    process.stdout.write(`  ${label}… `);
    await visit(page, "vendor", path, label, account);
    await checkListSurfaceUI(page, "vendor", path, label);
    console.log("ok");
  }

  await page.goto(`${BASE}/vendor/dashboard`);
  await page.waitForTimeout(1000);
  const dash = await page.locator("body").innerText();
  if (!/dashboard|attention|service|task/i.test(dash) && dash.length < 100) {
    const shot = await screenshot(page, "vendor", "dashboard-sparse");
    addFinding({ portal: "vendor", path: "/vendor/dashboard", category: "ui", severity: "medium", title: "Vendor dashboard sparse vs manager Needs-attention pattern", detail: dash.slice(0, 200), screenshot: shot });
  }
}

async function adminFlows(page, account) {
  console.log("\n=== Admin flows ===");
  const paths = [
    ["/admin/dashboard", "Dashboard"],
    ["/admin/properties", "Properties"],
    ["/admin/events", "Meetings"],
    ["/admin/bugs-feedback", "Feedback"],
    ["/admin/communication/inbox/unopened", "Inbox unopened"],
    ["/admin/communication/inbox/opened", "Inbox opened"],
    ["/admin/communication/inbox/schedule", "Inbox schedule"],
    ["/admin/communication/inbox/sent", "Inbox sent"],
    ["/admin/axis-users", "Accounts"],
    ["/admin/profile", "Settings"],
  ];
  for (const [path, label] of paths) {
    process.stdout.write(`  ${label}… `);
    await visit(page, "admin", path, label, account);
    console.log("ok");
  }

  await page.goto(`${BASE}/admin/axis-users`);
  await page.waitForTimeout(2000);
  const body = await page.locator("body").innerText();
  if (!/manager|resident|vendor|account/i.test(body)) {
    const shot = await screenshot(page, "admin", "accounts-empty");
    addFinding({ portal: "admin", path: "/admin/axis-users", category: "runtime", severity: "high", title: "Admin Accounts page missing user tables", detail: body.slice(0, 300), screenshot: shot });
  }

  // Admin UI vs manager table pattern
  await page.goto(`${BASE}/admin/bugs-feedback`);
  await page.waitForTimeout(1500);
  const fb = await page.locator("body").innerText();
  if (!/filter|status|feedback|bug/i.test(fb)) {
    const shot = await screenshot(page, "admin", "feedback-bare");
    addFinding({ portal: "admin", path: "/admin/bugs-feedback", category: "ui", severity: "medium", title: "Admin Feedback tab missing filter pills + table chrome", detail: "Reference: admin-bug-feedback-client filter row pattern", screenshot: shot });
  }
}

async function publicFlows(page) {
  console.log("\n=== Public routes ===");
  for (const [path, label] of [
    ["/rent/browse", "Browse"],
    ["/auth/sign-in", "Sign in"],
    ["/auth/create-account", "Create account"],
  ]) {
    process.stdout.write(`  ${label}… `);
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    const body = await page.locator("body").innerText();
    if (/something went wrong|404|not found/i.test(body)) {
      const shot = await screenshot(page, "public", label.replace(/\s+/g, "-").toLowerCase());
      addFinding({ portal: "manager", path, category: "runtime", severity: "high", title: `Public ${label}: error page`, detail: body.slice(0, 200), screenshot: shot });
    }
    console.log("ok");
  }
}

async function createLinearIssue(finding, imageMarkdown) {
  const title = finding.title.startsWith("[") ? finding.title : `[${finding.portal}] ${finding.title}`;
  const category = finding.category || "improvement";
  const labelType = finding.severity === "high" && category === "runtime" ? "Bug" : category === "feature" ? "Feature" : "Improvement";
  const description = `## Category
${category} (${finding.severity})

## Found during exhaustive QA (${DATE})
**Portal:** ${finding.portal}
**Path:** \`${finding.path}\`
**Base:** ${BASE}

## Detail
${finding.detail || "_See screenshot._"}

${imageMarkdown ? `## Screenshot\n${imageMarkdown}` : ""}

## Acceptance
- [ ] Repro on localhost:3010 with test account
- [ ] Matches manager portal UI pattern where applicable

## Source
\`scripts/qa-exhaustive-portal-audit.mjs\``;

  const projectId = await resolveProjectId(portalProject(finding.portal));
  const input = {
    teamId: teamId(),
    title,
    description,
    priority: inferPriority({ title, description, project: { name: portalProject(finding.portal) }, labels: { nodes: [{ name: labelType }] } }),
    projectId,
    labelIds: await resolveLabelIds([labelType, `portal:${finding.portal}`, `qa:exhaustive`]),
    stateId: await resolveStateId("Backlog"),
  };

  const data = await linearGraphql(
    `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier title url } } }`,
    { input },
  );
  return data.issueCreate.issue;
}

async function fileFindings() {
  const open = await loadOpenIssueTitles();
  const novel = [];
  for (const f of findings) {
    const dup = isDuplicateFinding(f, open);
    if (dup.duplicate) {
      f.skipped = dup.match;
      continue;
    }
    novel.push(f);
  }

  console.log(`\nFiling ${novel.length} novel findings (${findings.length - novel.length} duplicates skipped)…`);
  for (const f of novel) {
    let imageMd = "";
    if (f.screenshot && existsSync(f.screenshot)) {
      try {
        const assetUrl = await uploadFileToLinear(f.screenshot);
        imageMd = `![${f.title}](${assetUrl})`;
      } catch (e) {
        imageMd = `_Screenshot: \`${f.screenshot}\` (upload failed: ${e.message})_`;
      }
    }
    try {
      const issue = await createLinearIssue(f, imageMd);
      f.prp = issue.identifier;
      f.url = issue.url;
      console.log(`  ${issue.identifier}: ${f.title.slice(0, 60)}`);
      open.push({ identifier: issue.identifier, title: issue.title, description: "" });
    } catch (e) {
      console.error(`  FAIL: ${f.title.slice(0, 50)} — ${e.message}`);
    }
  }
}

function writeManifest() {
  const novel = findings.filter((f) => !f.skipped);
  let md = `# Exhaustive QA — ${DATE}\n\nBase: ${BASE}\n\nScreenshots: \`docs/linear/qa-screenshots/${DATE}/\`\n\n`;
  md += `| Status | Count |\n| --- | --- |\n| Total findings | ${findings.length} |\n| Skipped duplicate | ${findings.filter((f) => f.skipped).length} |\n| Filed / novel | ${novel.filter((f) => f.prp).length} |\n\n`;
  md += `## Findings\n\n| PRP | Sev | Cat | Portal | Title |\n| --- | --- | --- | --- | --- |\n`;
  for (const f of findings) {
    md += `| ${f.prp || f.skipped || ""} | ${f.severity} | ${f.category} | ${f.portal} | ${f.title.replace(/\|/g, "/")} |\n`;
  }
  writeFileSync(OUT_JSON, JSON.stringify({ date: DATE, base: BASE, findings }, null, 2));
  writeFileSync(OUT_MD, md);
  console.log(`\nWrote ${OUT_MD}`);
}

async function main() {
  console.log(`Exhaustive QA on ${BASE}`);
  const browser = await chromium.launch({ headless: true });

  for (const [name, account] of Object.entries(ACCOUNTS)) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await signIn(page, account);
    if (name === "manager") await managerFlows(page, account);
    else if (name === "resident") await residentFlows(page, account);
    else if (name === "vendor") await vendorFlows(page, account);
    else if (name === "admin") await adminFlows(page, account);
    await ctx.close();
  }

  const pub = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await publicFlows(await pub.newPage());
  await pub.close();

  // Mobile resident + vendor spot check
  const mob = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mpage = await mob.newPage();
  await signIn(mpage, ACCOUNTS.resident);
  await visit(mpage, "resident", "/resident/dashboard", "Mobile dashboard", ACCOUNTS.resident);
  const mobNav = await mpage.locator(".portal-native-bottom-nav, .portal-mobile-nav-bar, [data-mobile-nav-section]").count();
  if (mobNav === 0) {
    const shot = await screenshot(mpage, "resident", "mobile-no-bottom-nav");
    addFinding({ portal: "resident", path: "/resident/dashboard", category: "ui", severity: "medium", title: "Resident mobile: bottom nav not visible at 390px", detail: "", screenshot: shot });
  }
  await mob.close();

  await browser.close();

  console.log(`\nFindings: ${findings.length}`);
  if (FILE_TICKETS) await fileFindings();
  else console.log("Re-run with --file-tickets to create Linear issues");
  writeManifest();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
