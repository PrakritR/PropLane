#!/usr/bin/env node
/**
 * Mobile portal QA — 390×844 viewport, all four portals.
 * Strategy: file mobile-specific issues; desktop website polish is phase 1.
 *
 *   PLAYWRIGHT_BASE_URL=http://localhost:3010 node scripts/qa-mobile-portal-audit.mjs
 *   ... --file-tickets
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { uploadFileToLinear } from "./linear/upload-file.mjs";
import { loadOpenIssueTitles, isDuplicateFinding } from "./linear/dedupe-issues.mjs";
import { inferPriority } from "./linear/triage-rules.mjs";
import {
  linearGraphql,
  resolveProjectId,
  resolveLabelIds,
  resolveStateId,
  teamId,
} from "./linear/graphql.mjs";
import { signInToPortal, completePostAuthNavigation, dismissDevOverlay } from "./qa-portal-sign-in.mjs";
import { qaPortalAccounts } from "../tests/fixtures/qa-accounts.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const BASE = (process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3010").replace(/\/$/, "");
const DATE = new Date().toISOString().slice(0, 10);
const FILE_TICKETS = process.argv.includes("--file-tickets");
const VIEWPORT = { width: 390, height: 844 };
const SHOT_DIR = join(REPO, "docs/linear/qa-screenshots", DATE);
const OUT_JSON = join(REPO, "docs/linear/manifests", `qa-mobile-${DATE}.json`);

mkdirSync(SHOT_DIR, { recursive: true });

// One source: tests/fixtures/qa-accounts.mjs (`npm run test:accounts:check`).
const ACCOUNTS = qaPortalAccounts();

/** @type {Array<Record<string, unknown>>} */
const findings = [];
let shotSeq = 0;

function add(f) {
  findings.push(f);
  console.log(`  [${f.severity}] ${f.title}`);
}

async function screenshot(page, portal, slug) {
  const name = `mobile-${portal}-${String(++shotSeq).padStart(3, "0")}-${slug}.png`;
  const path = join(SHOT_DIR, name);
  await page.screenshot({ path, fullPage: false });
  return path;
}

async function signIn(page, account) {
  await signInToPortal(page, account, BASE);
}

async function hasHorizontalOverflow(page) {
  try {
    return await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  } catch {
    return false;
  }
}

async function mobileChromeVisible(page) {
  return page.evaluate(() => {
    const top = document.querySelector(".portal-mobile-nav-bar");
    const bottom = document.querySelector(".portal-native-bottom-nav");
    const strip = document.querySelector("[data-mobile-nav-section]");
    return { top: !!top, bottom: !!bottom, strip: !!strip };
  });
}

async function smallTapTargets(page, limit = 8) {
  return page.evaluate((max) => {
    const bad = [];
    const clickables = document.querySelectorAll(
      'button, a[href], [role="button"], input[type="submit"]',
    );
    for (const el of clickables) {
      if (bad.length >= max) break;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (r.width < 40 || r.height < 40) {
        const label = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40);
        bad.push({ label, w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
    return bad;
  }, limit);
}

async function auditPage(page, portal, path, label, account) {
  const portalPrefix =
    portal === "manager" ? "/portal" : portal === "admin" ? "/admin" : `/${portal}`;
  if (!new URL(page.url()).pathname.startsWith(portalPrefix) || page.url().includes("/auth/")) {
    await signIn(page, account);
  }

  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  await page
    .waitForSelector(".portal-mobile-nav-bar, .portal-native-bottom-nav, [data-mobile-nav-section]", {
      timeout: 12_000,
    })
    .catch(() => {});
  await page.waitForTimeout(800);

  if (page.url().includes("/auth/sign-in") || page.url().includes("/auth/continue")) {
    await signIn(page, account);
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(1500);
  }

  const pathname = new URL(page.url()).pathname;
  if (pathname === "/auth/continue" || pathname.includes("/auth/connect-google-services")) {
    await completePostAuthNavigation(page, BASE);
    const afterAuth = new URL(page.url()).pathname;
    const targetPrefix = path.split("/").slice(0, 2).join("/");
    if (!afterAuth.startsWith(targetPrefix)) {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(1500);
    }
  }

  const slug = label.replace(/\s+/g, "-").toLowerCase();
  const finalPath = new URL(page.url()).pathname;
  if (finalPath.includes("/auth/sign-in") || finalPath === "/auth/continue") {
    const s = await screenshot(page, portal, `${slug}-auth-blocked`);
    add({
      portal,
      path,
      category: "runtime",
      severity: "high",
      title: `${label} (mobile): auth blocked — stuck on sign-in or /auth/continue`,
      detail: `URL: ${page.url()}. Fix PRP-223 before mobile chrome audit is meaningful.`,
      screenshot: s,
    });
    return;
  }

  if (await hasHorizontalOverflow(page)) {
    const s = await screenshot(page, portal, `${slug}-overflow`);
    add({
      portal,
      path,
      category: "ui",
      severity: "medium",
      title: `${label} (mobile): horizontal page overflow at 390px`,
      detail: "Content wider than viewport — hard to use on phone browsers.",
      screenshot: s,
    });
  }

  const chrome = await mobileChromeVisible(page);
  if (!chrome.top && !chrome.bottom && !chrome.strip) {
    const s = await screenshot(page, portal, `${slug}-no-chrome`);
    add({
      portal,
      path,
      category: "ui",
      severity: "high",
      title: `${label} (mobile): no mobile nav chrome visible`,
      detail: "Expected .portal-mobile-nav-bar and/or .portal-native-bottom-nav or section strip.",
      screenshot: s,
    });
  }

  const small = await smallTapTargets(page);
  if (small.length >= 3) {
    const s = await screenshot(page, portal, `${slug}-tap-targets`);
    add({
      portal,
      path,
      category: "a11y",
      severity: "medium",
      title: `${label} (mobile): tap targets under 40px`,
      detail: small.map((t) => `${t.label || "?"} (${t.w}×${t.h})`).join("; "),
      screenshot: s,
    });
  }

  // Duplicate primary CTAs in mobile header band (known production bug pattern)
  const dupes = await page.evaluate(() => {
    const band = document.querySelector('[data-slot="portal-page-title-band"]');
    if (!band) return [];
    const buttons = [...band.querySelectorAll("button, a")].map((el) =>
      (el.textContent || "").trim().replace(/\s+/g, " "),
    );
    const seen = new Map();
    for (const t of buttons) {
      if (!t || t.length < 4) continue;
      seen.set(t, (seen.get(t) || 0) + 1);
    }
    return [...seen.entries()].filter(([, n]) => n > 1).map(([t]) => t);
  });
  if (dupes.length) {
    const s = await screenshot(page, portal, `${slug}-dup-cta`);
    add({
      portal,
      path,
      category: "ui",
      severity: "high",
      title: `${label} (mobile): duplicate header actions`,
      detail: dupes.join(", "),
      screenshot: s,
    });
  }
}

const MANAGER_PATHS = [
  ["/portal/dashboard", "Dashboard"],
  ["/portal/properties/listed", "Properties"],
  ["/portal/applications/pending", "Applications"],
  ["/portal/residents", "Residents"],
  ["/portal/payments/incoming", "Payments"],
  ["/portal/services", "Services"],
  ["/portal/communication/active", "Communication"],
];

const RESIDENT_PATHS = [
  ["/resident/dashboard", "Dashboard"],
  ["/resident/applications", "Applications"],
  ["/resident/communication/active", "Communication"],
  ["/resident/payments", "Payments"],
  ["/resident/services", "Services"],
];

const VENDOR_PATHS = [
  ["/vendor/dashboard", "Dashboard"],
  ["/vendor/work-orders", "Work orders"],
  ["/vendor/communication/active", "Communication"],
  ["/vendor/payments", "Payments"],
];

const ADMIN_PATHS = [
  ["/admin/dashboard", "Dashboard"],
  ["/admin/communication/inbox/unopened", "Inbox"],
  ["/admin/axis-users", "Accounts"],
];

async function testBottomNavClickThrough(page, portal, account, basePath) {
  await dismissDevOverlay(page);
  const tabs = page.locator(".portal-native-bottom-nav-scroll a, .portal-native-bottom-nav-scroll button");
  if ((await tabs.count()) === 0) return;

  const before = new URL(page.url()).pathname;
  const count = await tabs.count();
  let target = null;
  for (let i = 0; i < count; i++) {
    const tab = tabs.nth(i);
    const href = (await tab.getAttribute("href")) ?? "";
    const path = href.split("?")[0];
    if (path && path !== before) {
      target = tab;
      break;
    }
  }
  if (!target) return;

  await target.click();
  await page.waitForTimeout(1200);
  const after = new URL(page.url()).pathname;
  if (after === before && !page.url().includes("/auth/")) {
    const s = await screenshot(page, portal, "bottom-nav-dead");
    add({
      portal,
      path: before,
      category: "ux",
      severity: "high",
      title: `${portal} (mobile): bottom nav tab did not navigate`,
      detail: `Stayed on ${before}`,
      screenshot: s,
    });
  }

  // More sheet
  const more = page.getByRole("button", { name: /^more$/i });
  if (await more.count()) {
    await more.first().click();
    await page.waitForTimeout(600);
    const sheetLink = page.locator('[role="dialog"] a, [data-state="open"] a').filter({ hasText: /settings|documents|calendar/i }).first();
    if (await sheetLink.count()) {
      await sheetLink.click();
      await page.waitForTimeout(1000);
      if (page.url().includes("/auth/sign-in")) {
        const s = await screenshot(page, portal, "more-sheet-auth-bounce");
        add({
          portal,
          path: basePath,
          category: "runtime",
          severity: "high",
          title: `${portal} (mobile): More sheet navigation bounced to sign-in`,
          detail: "",
          screenshot: s,
        });
      }
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
}

async function testAssistantFab(page, portal) {
  const fab = page.locator(".axis-assistant-fab, [data-attr='axis-assistant-fab']").first();
  if ((await fab.count()) === 0) return;
  const box = await fab.boundingBox();
  const bottomNav = await page.locator(".portal-native-bottom-nav").boundingBox();
  if (box && bottomNav && box.y + box.height > bottomNav.y - 4) {
    const s = await screenshot(page, portal, "fab-overlap");
    add({
      portal,
      path: new URL(page.url()).pathname,
      category: "ui",
      severity: "medium",
      title: `${portal} (mobile): assistant FAB overlaps bottom nav`,
      detail: "FAB should sit above measured bottom inset.",
      screenshot: s,
    });
  }
}

function portalProject(portal) {
  return (
    {
      manager: "02 — Manager Portal",
      resident: "03 — Resident Portal",
      vendor: "04 — Vendor Portal",
      admin: "05 — Admin Portal",
    }[portal] || "02 — Manager Portal"
  );
}

async function createLinearIssue(finding, imageMarkdown) {
  const labelType = finding.category === "runtime" ? "Bug" : finding.category === "a11y" ? "Improvement" : "Improvement";
  const title = `[Mobile] ${finding.title}`;
  const description = `## Found during mobile QA (${DATE})
**Viewport:** 390×844
**Portal:** ${finding.portal}
**Path:** \`${finding.path}\`

## Detail
${finding.detail || "_See screenshot._"}

${imageMarkdown ? `## Screenshot\n${imageMarkdown}` : ""}

## Sequencing
**Phase 1:** finish desktop website polish on this route.
**Phase 2:** fix mobile layout/tap targets (this ticket).

## Source
\`scripts/qa-mobile-portal-audit.mjs\``;

  const input = {
    teamId: teamId(),
    title,
    description,
    priority: inferPriority({
      title,
      description,
      project: { name: portalProject(finding.portal) },
      labels: { nodes: [{ name: labelType }] },
    }),
    projectId: await resolveProjectId(portalProject(finding.portal)),
    labelIds: await resolveLabelIds([labelType, `portal:${finding.portal}`, "qa:mobile"]),
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
  let filed = 0;
  for (const f of findings) {
    const dup = isDuplicateFinding(f, open);
    if (dup.duplicate) {
      console.log(`  skip dup → ${dup.match}`);
      continue;
    }
    let imageMd = "";
    if (f.screenshot && existsSync(f.screenshot)) {
      try {
        imageMd = `![screenshot](${await uploadFileToLinear(f.screenshot)})`;
      } catch (e) {
        imageMd = `_Screenshot: \`${f.screenshot}\`_`;
      }
    }
    try {
      const issue = await createLinearIssue(f, imageMd);
      f.prp = issue.identifier;
      console.log(`  ${issue.identifier}: ${f.title.slice(0, 55)}`);
      open.push({ identifier: issue.identifier, title: issue.title, description: "" });
      filed++;
    } catch (e) {
      console.error(`  FAIL ${f.title.slice(0, 40)}: ${e.message}`);
    }
  }
  console.log(`Filed ${filed} novel mobile tickets`);
}

async function runPortal(browser, portal, paths, account) {
  console.log(`\n=== ${portal} mobile ===`);
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();
  await signIn(page, account);
  await page.goto(`${BASE}${account.home}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  for (const [path, label] of paths) {
    console.log(`  ${label}…`);
    await auditPage(page, portal, path, label, account);
  }

  await testBottomNavClickThrough(page, portal, account, account.home);
  await testAssistantFab(page, portal);
  await ctx.close();
}

async function main() {
  console.log(`Mobile QA ${VIEWPORT.width}×${VIEWPORT.height} on ${BASE}`);
  const browser = await chromium.launch({ headless: true });

  await runPortal(browser, "manager", MANAGER_PATHS, ACCOUNTS.manager);
  await runPortal(browser, "resident", RESIDENT_PATHS, ACCOUNTS.resident);
  await runPortal(browser, "vendor", VENDOR_PATHS, ACCOUNTS.vendor);
  await runPortal(browser, "admin", ADMIN_PATHS, ACCOUNTS.admin);

  await browser.close();
  writeFileSync(OUT_JSON, JSON.stringify({ date: DATE, viewport: VIEWPORT, findings }, null, 2));
  console.log(`\nFindings: ${findings.length} → ${OUT_JSON}`);

  if (FILE_TICKETS) await fileFindings();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
