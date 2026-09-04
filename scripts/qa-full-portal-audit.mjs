#!/usr/bin/env node
/**
 * Rigorous manager + resident + vendor portal QA on a sandbox port.
 *
 * Usage:
 *   npm run sandbox:pin -- 3010
 *   PLAYWRIGHT_BASE_URL=http://localhost:3010 node scripts/qa-full-portal-audit.mjs
 *   PLAYWRIGHT_BASE_URL=http://localhost:3010 node scripts/qa-full-portal-audit.mjs --file-tickets
 *
 * Output: docs/linear/manifests/qa-audit-<date>-cursor1.md + JSON sidecar
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const BASE = (process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3010").replace(/\/$/, "");
const FILE_TICKETS = process.argv.includes("--file-tickets");
const DATE = new Date().toISOString().slice(0, 10);

const ACCOUNTS = {
  manager: { email: "manager@test.proplane.local", password: "TestManager123!" },
  resident: { email: "resident@test.proplane.local", password: "TestResident123!" },
  vendor: { email: "vendor@test.proplane.local", password: "TestVendor123!" },
};

/** Titles we already know about — skip filing duplicates */
const KNOWN_ISSUE_PATTERNS = [
  /signup hangs|creating\.\.\./i,
  /two signup doors/i,
  /invalid login credentials/i,
  /case-sensitive/i,
  /ghost (data|properties)/i,
  /sandbox port|redirect.*3010|redirect.*3000/i,
  /playwright mcp allowed-origins/i,
  /seed:dev prunes/i,
  /rename manager-\*.*pro-/i,
  /google sign-in is not set up/i,
  /no supported way to delete an account/i,
  /port-per-lane/i,
  /colour-contrast|color contrast/i,
  /hub signup.*phone/i,
];

const MANAGER_PATHS = [
  { label: "Dashboard", path: "/portal/dashboard" },
  { label: "Properties (listed)", path: "/portal/properties/listed" },
  { label: "Properties (drafts)", path: "/portal/properties/drafts" },
  { label: "Tours (pending)", path: "/portal/tours/pending" },
  { label: "Applications (pending)", path: "/portal/applications/pending" },
  { label: "Background checks", path: "/portal/background-checks/pending_review" },
  { label: "Leases", path: "/portal/leases" },
  { label: "Residents", path: "/portal/residents/current" },
  { label: "Payments incoming", path: "/portal/payments/incoming/pending" },
  { label: "Payments outgoing", path: "/portal/payments/outgoing/pending" },
  { label: "Services", path: "/portal/services/requests" },
  { label: "Tasks", path: "/portal/tasks" },
  { label: "Calendar", path: "/portal/calendar" },
  { label: "Bookings", path: "/portal/bookings" },
  { label: "Communication", path: "/portal/communication/active" },
  { label: "Teams managers", path: "/portal/teams/managers" },
  { label: "Teams vendors", path: "/portal/teams/vendors" },
  { label: "Promotion", path: "/portal/promotion" },
  { label: "Finances income", path: "/portal/financials/income" },
  { label: "Finances expenses", path: "/portal/financials/expenses" },
  { label: "Finances GL", path: "/portal/financials/general-ledger" },
  { label: "Documents library", path: "/portal/documents/library" },
  { label: "Documents templates", path: "/portal/documents/templates" },
  { label: "Feedback", path: "/portal/bugs-feedback" },
  { label: "App", path: "/portal/app" },
  { label: "Settings", path: "/portal/profile" },
];

const RESIDENT_PATHS = [
  { label: "Dashboard", path: "/resident/dashboard" },
  { label: "Tour", path: "/resident/tour" },
  { label: "Applications", path: "/resident/applications" },
  { label: "Lease", path: "/resident/lease" },
  { label: "Payments", path: "/resident/payments" },
  { label: "Payments pending pill", path: "/resident/payments/pending" },
  { label: "Services", path: "/resident/services" },
  { label: "House details", path: "/resident/move-in" },
  { label: "Communication", path: "/resident/communication/active" },
  { label: "Documents application", path: "/resident/documents/application" },
  { label: "Documents lease", path: "/resident/documents/lease" },
  { label: "Documents receipts", path: "/resident/documents/receipts" },
  { label: "Settings", path: "/resident/profile" },
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
  { label: "Settings", path: "/vendor/profile" },
];

/** @type {{ id: string; portal: string; path: string; severity: "high"|"medium"|"low"; title: string; detail: string; duplicate?: boolean }[]} */
const findings = [];
let findingSeq = 0;

function addFinding(portal, path, severity, title, detail) {
  const duplicate =
    KNOWN_ISSUE_PATTERNS.some((re) => re.test(title) || re.test(detail)) ||
    findings.some((f) => f.portal === portal && f.path === path && f.title === title);
  if (duplicate && findings.some((f) => f.portal === portal && f.path === path && f.title === title)) return;
  const isKnown = KNOWN_ISSUE_PATTERNS.some((re) => re.test(title) || re.test(detail));
  findings.push({
    id: `QA-${++findingSeq}`,
    portal,
    path,
    severity,
    title,
    detail,
    duplicate: isKnown,
  });
}

async function signIn(page, { email, password }, nextPath, portalRole) {
  const port = new URL(BASE).port || "80";
  const next = `${nextPath}`;
  await page.goto(`${BASE}/auth/sign-in?next=${encodeURIComponent(next)}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  if (!page.url().includes("/auth/sign-in")) return;

  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();

  await page.waitForFunction(
    () => !window.location.pathname.includes("/auth/sign-in"),
    { timeout: 60_000 },
  ).catch(() => {});

  const landed = new URL(page.url());
  if (landed.port && landed.port !== port && landed.hostname === "localhost") {
    addFinding(
      portalRole,
      "/auth/sign-in",
      "medium",
      `Post-login redirect leaves sandbox port ${port} for ${landed.port}`,
      `Signed in on ${BASE} but landed on ${page.url()}. Run npm run sandbox:pin -- ${port}.`,
    );
    await page.goto(`${BASE}${nextPath}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }

  if (!page.url().includes(nextPath.split("?")[0])) {
    const chooserLabels = { manager: "Property", resident: "Resident", vendor: "Vendor" };
    const label = chooserLabels[portalRole];
    if (label) {
      await page.goto(`${BASE}/auth/choose-portal?next=${encodeURIComponent(nextPath)}`, {
        waitUntil: "domcontentloaded",
      });
      const btn = page.getByRole("button", { name: new RegExp(`^${label}\\b`) });
      if ((await btn.count()) > 0) {
        await btn.first().click();
        await page.waitForURL(`**${nextPath.split("?")[0]}**`, { timeout: 45_000 }).catch(() => {});
      }
    }
  }
}

async function auditPath(page, portal, { label, path }, account, role, nextPath) {
  const consoleErrors = [];
  const pageErrors = [];
  const onConsole = (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  };
  const onPageError = (err) => pageErrors.push(String(err));

  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  let httpStatus = 200;
  const response = await page.goto(`${BASE}${path}`, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  }).catch((e) => {
    const msg = String(e);
    if (/ERR_ABORTED/i.test(msg)) return null;
    addFinding(portal, path, "high", `${label}: navigation failed`, msg);
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    return null;
  });

  if (!response) {
    await page.waitForTimeout(800);
    if (!page.url().includes(path.split("?")[0])) {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      return;
    }
  }

  if (response) httpStatus = response.status();
  await page.waitForTimeout(1200);

  let finalUrl = page.url();
  let pathname = new URL(finalUrl).pathname;

  if (pathname.includes("/auth/sign-in")) {
    await signIn(page, account, nextPath, role);
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(1200);
    finalUrl = page.url();
    pathname = new URL(finalUrl).pathname;
    if (pathname.includes("/auth/sign-in")) {
      addFinding(portal, path, "high", `${label}: session lost — bounced to sign-in`, finalUrl);
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      return;
    }
  }
  if (httpStatus >= 400) {
    addFinding(portal, path, "high", `${label}: HTTP ${httpStatus}`, finalUrl);
  }
  if (pathname === "/" || pathname === "/portal" || pathname === "/resident" || pathname === "/vendor") {
    addFinding(portal, path, "medium", `${label}: soft redirect to home`, finalUrl);
  }

  const mainText = await page.locator("main, #portal-main-content, [data-portal-main], .portal-main-inner").first().innerText().catch(() => "");
  const bodyText = await page.locator("body").innerText();
  const hasEmptyState = /no (tours|leases|services|properties|results|items)|nothing here|get started|add your first/i.test(bodyText);
  if (mainText.length < 20 && !hasEmptyState && !/sign in|log in/i.test(mainText)) {
    addFinding(portal, path, "medium", `${label}: main content nearly empty`, `len=${mainText.length}`);
  }

  if (/something went wrong|unexpected error|failed to load/i.test(bodyText)) {
    addFinding(portal, path, "high", `${label}: error copy on page`, bodyText.slice(0, 200));
  }
  if (/404|page not found|not found/i.test(bodyText) && !/no .* found/i.test(bodyText.toLowerCase())) {
    addFinding(portal, path, "high", `${label}: possible 404 content`, pathname);
  }

  for (const err of consoleErrors.slice(0, 5)) {
    if (/favicon|hydration|devtools|posthog|ResizeObserver|Failed to fetch.*auth-js/i.test(err)) continue;
    addFinding(portal, path, "medium", `${label}: console error`, err.slice(0, 300));
  }
  for (const err of pageErrors.slice(0, 3)) {
    addFinding(portal, path, "high", `${label}: uncaught exception`, err.slice(0, 300));
  }

  page.off("console", onConsole);
  page.off("pageerror", onPageError);
}

async function auditManagerInteractions(page) {
  await page.goto(`${BASE}/portal/properties/listed`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  const addBtn = page.getByRole("button", { name: /add property|add listing|^ADD$/i }).or(page.locator('[data-attr*="add"]')).first();
  if ((await addBtn.count()) === 0) {
    addFinding("manager", "/portal/properties", "medium", "Properties: ADD row missing", "No ADD affordance on listed tab");
  }

  const rows = page.locator("[data-portal-record-row], tr[data-state], .portal-record-row");
  if ((await rows.count()) === 0) {
    addFinding("manager", "/portal/properties", "low", "Properties: no seeded rows visible", "Seed may be empty or filters hide rows");
  }

  await page.goto(`${BASE}/portal/communication/active`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  const compose = page.getByRole("button", { name: /compose|new message|write/i });
  if ((await compose.count()) > 0) {
    await compose.first().click().catch(() => {});
    await page.waitForTimeout(500);
    const modal = page.locator('[role="dialog"], .modal-panel');
    if ((await modal.count()) === 0) {
      addFinding("manager", "/portal/communication", "medium", "Communication: compose does not open modal", "");
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
}

async function auditResidentInteractions(page) {
  await page.goto(`${BASE}/resident/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  const locked = page.locator('[aria-disabled="true"], [data-nav-locked="true"]');
  const lockedCount = await locked.count();
  if (lockedCount > 0) {
    const first = locked.first();
    const href = await first.getAttribute("href").catch(() => null);
    if (href) {
      addFinding("resident", "/resident/dashboard", "medium", "Locked nav item is still a link", href);
    }
  }

  await page.goto(`${BASE}/resident/payments`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  if (/summary|statements/i.test(await page.locator("body").innerText())) {
    addFinding("resident", "/resident/payments", "medium", "Payments still shows legacy Summary/Statements tabs", "");
  }
}

async function auditVendorInteractions(page) {
  await page.goto(`${BASE}/vendor/work-orders`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  const body = await page.locator("body").innerText();
  if (/work order/i.test(body) && !/service/i.test(body)) {
    addFinding("vendor", "/vendor/work-orders", "low", 'Vendor Services tab may still say "work order" in copy', body.slice(0, 150));
  }
}

function priorityForSeverity(sev) {
  if (sev === "high") return 2;
  if (sev === "medium") return 3;
  return 4;
}

function portalProject(portal) {
  if (portal === "manager") return "02 — Manager Portal";
  if (portal === "resident") return "03 — Resident Portal";
  if (portal === "vendor") return "04 — Vendor Portal";
  return "02 — Manager Portal";
}

function fileTicket(finding) {
  if (finding.duplicate) return { skipped: "duplicate" };
  const priority = priorityForSeverity(finding.severity);
  const title = `[${finding.portal}] ${finding.title}`;
  const body = `## Found during QA audit (${DATE})\n\n**Portal:** ${finding.portal}\n**Path:** \`${finding.path}\`\n**Base:** ${BASE}\n\n## Detail\n${finding.detail}\n\n## Repro\n1. Sign in as test account on ${BASE}\n2. Navigate to \`${finding.path}\`\n\n## Source\nAutomated QA: \`scripts/qa-full-portal-audit.mjs\``;
  const labels =
    finding.severity === "high"
      ? "Bug"
      : finding.severity === "medium"
        ? "Improvement"
        : "Improvement";
  const r = spawnSync(
    "npm",
    [
      "run",
      "linear:ticket",
      "--",
      "--title",
      title,
      "--project",
      portalProject(finding.portal),
      "--priority",
      String(priority),
      "--labels",
      `${labels},portal:${finding.portal},qa:audit`,
      "--body",
      body,
    ],
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
  if (r.status !== 0) return { error: r.stderr || r.stdout };
  const match = (r.stdout + r.stdout).match(/PRP-\d+/);
  return { prp: match?.[0] ?? "created" };
}

function writeManifest() {
  const outDir = join(REPO_ROOT, "docs/linear/manifests");
  mkdirSync(outDir, { recursive: true });
  const baseName = `qa-audit-${DATE}-cursor1`;
  const jsonPath = join(outDir, `${baseName}.json`);
  const mdPath = join(outDir, `${baseName}.md`);

  const novel = findings.filter((f) => !f.duplicate);
  const dupes = findings.filter((f) => f.duplicate);

  let md = `# Portal QA audit — cursor-1 (${DATE})\n\n`;
  md += `**Base URL:** ${BASE}\n\n`;
  md += `**Accounts:** manager / resident / vendor @test.proplane.local\n\n`;
  md += `**Script:** \`node scripts/qa-full-portal-audit.mjs\`\n\n`;
  md += `## Summary\n\n`;
  md += `- Total findings: ${findings.length}\n`;
  md += `- Novel (file tickets): ${novel.length}\n`;
  md += `- Likely duplicate of existing PRP: ${dupes.length}\n\n`;

  if (novel.length) {
    md += `## Novel findings\n\n`;
    md += `| Sev | Portal | Path | Title | PRP |\n`;
    md += `| --- | --- | --- | --- | --- |\n`;
    for (const f of novel) {
      md += `| ${f.severity} | ${f.portal} | \`${f.path}\` | ${f.title} | ${f.prp ?? ""} |\n`;
    }
    md += `\n`;
  }

  if (dupes.length) {
    md += `## Skipped (existing backlog)\n\n`;
    for (const f of dupes) {
      md += `- [${f.severity}] ${f.portal} \`${f.path}\` — ${f.title}\n`;
    }
  }

  writeFileSync(jsonPath, JSON.stringify({ base: BASE, date: DATE, findings }, null, 2));
  writeFileSync(mdPath, md);
  console.log(`\nWrote ${mdPath}`);
  console.log(`Wrote ${jsonPath}`);
  return mdPath;
}

async function main() {
  console.log(`QA audit on ${BASE}`);
  const browser = await chromium.launch({ headless: true });

  async function runPortal(portal, account, nextPath, paths, interactions) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    console.log(`\n=== ${portal.charAt(0).toUpperCase() + portal.slice(1)} ===`);
    await signIn(page, account, nextPath, portal);
    for (const p of paths) {
      process.stdout.write(`  ${p.label}… `);
      await auditPath(page, portal, p, account, portal, nextPath);
      console.log("ok");
    }
    if (interactions) await interactions(page);
    await context.close();
  }

  await runPortal("manager", ACCOUNTS.manager, "/portal/dashboard", MANAGER_PATHS, auditManagerInteractions);
  await runPortal("resident", ACCOUNTS.resident, "/resident/dashboard", RESIDENT_PATHS, auditResidentInteractions);
  await runPortal("vendor", ACCOUNTS.vendor, "/vendor/dashboard", VENDOR_PATHS, auditVendorInteractions);

  await browser.close();

  const novel = findings.filter((f) => !f.duplicate);
  console.log(`\nFindings: ${findings.length} total, ${novel.length} novel`);

  if (FILE_TICKETS && novel.length) {
    console.log("\nFiling Linear tickets…");
    for (const f of novel) {
      const r = fileTicket(f);
      if (r.prp) f.prp = r.prp;
      if (r.error) console.error(`  FAIL ${f.title}: ${r.error.slice(0, 120)}`);
      else if (r.skipped) console.log(`  skip ${f.title}`);
      else console.log(`  ${f.prp ?? "?"} ${f.title}`);
    }
  } else if (novel.length && !FILE_TICKETS) {
    console.log("Re-run with --file-tickets to create Linear issues (needs LINEAR_API_KEY)");
  }

  writeManifest();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
