#!/usr/bin/env node
/**
 * "Nothing removed" proof for the portal redesign.
 *
 * Walks every sidebar page of the manager (/portal), resident (/resident) and
 * vendor (/vendor) portals at desktop (1440x900) and phone (390x844), records
 * every user-facing control by accessible name, and compares a later walk
 * against a committed baseline: a control may MOVE (another page, a menu, a
 * panel) but it must not disappear from its portal.
 *
 *   node scripts/portal-control-inventory.mjs --baseline [--merge] [--portal manager]
 *   node scripts/portal-control-inventory.mjs --compare  [--portal manager]
 *   flags: --base http://localhost:3013
 *
 * Read-only: signs in through the real /auth/sign-in page and only ever opens
 * menus (row ⋯, account menu, workspace switcher, tabs). It never clicks a
 * destructive or committing control and never writes to the database.
 * Output: tests/fixtures/portal-control-inventory.json
 *   { "_meta": {...}, "<portal>:<section>:<viewport>": [names], "<portal>:shell": [names] }
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { QA_ACCOUNTS } from "../tests/fixtures/qa-accounts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "tests/fixtures/portal-control-inventory.json");

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const BASE = opt("base", "http://localhost:3013").replace(/\/$/, "");
const MODE = flag("baseline") ? "baseline" : flag("compare") ? "compare" : null;
if (!MODE) {
  console.error("usage: portal-control-inventory.mjs --baseline|--compare [--portal manager|resident|vendor] [--base URL]");
  process.exit(2);
}

const PORTALS = {
  manager: { prefix: "/portal", account: QA_ACCOUNTS.manager2, chooser: "Property" },
  resident: { prefix: "/resident", account: QA_ACCOUNTS.resident, chooser: "Resident" },
  vendor: { prefix: "/vendor", account: QA_ACCOUNTS.vendor, chooser: "Vendor" },
};
const only = opt("portal", null);
if (only && !PORTALS[only]) {
  console.error(`unknown --portal ${only}`);
  process.exit(2);
}
const portalNames = only ? [only] : Object.keys(PORTALS);

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

/** Never clicked, even as a menu/tab trigger. */
const DESTRUCTIVE = /\b(delete|remove|archive|decline|reject|sign\s?out|log\s?out|withdraw|cancel|pay|send|void|refund|revoke|terminate|disconnect)\b/i;
const MAX_TABS = 8;
const LOAD_TIMEOUT_MS = 15_000;

/** page keys that could not be loaded; re-walked before giving up */
const failed = new Set();
const log = (...a) => console.error("[inventory]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- normalise

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const STREET = "(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|hwy|terrace|ter)";
const DATA_PATTERNS = [
  /[$€£]\s?\d/, // money
  /\b\d[\d,]*\.\d{2}\b/, // 1,200.00
  new RegExp(`\\b${MONTH}\\s+\\d{1,2}\\b`, "i"), // Oct 4
  new RegExp(`\\b\\d{1,2}\\s+${MONTH}\\b`, "i"), // 4 Oct
  /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/, // 10/4, 10/4/2026
  /\b\d{4}-\d{2}-\d{2}\b/, // ISO date
  /\b\d{1,2}:\d{2}\s?(am|pm)?\b/i, // times
  /@/, // emails
  /\b\d{3}[\s.-]?\d{3}[\s.-]?\d{4}\b/, // phones
  new RegExp(`^\\d+\\s+[\\w .'-]+\\b${STREET}\\b`, "i"), // 123 Main St
  /\b[A-Z]{2}\s\d{5}\b/, // WA 98101
  /\b(AXIS|AXISGRP|REQ|PRP|WO|INV|LSE)-[\w-]+/i, // record ids
  /^[0-9a-f]{8}-[0-9a-f]{4}-/i, // uuid
  /^(sun|mon|tue|wed|thu|fri|sat)[a-z]*,?\s+\d/i, // "Mon 12"
];
const WEEKDAY_OR_MONTH_ONLY = new RegExp(`^(?:${MONTH}|(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*)\\s*\\d{0,4}$`, "i");

/** trim, collapse whitespace, strip trailing/leading counts; "" means drop. */
function normaliseName(raw) {
  if (!raw) return "";
  let n = String(raw).replace(/\s+/g, " ").trim();
  if (!n) return "";
  // trailing counts: "Residents 12", "Pending (3)", "Inbox 99+", "Unread · 4"
  n = n.replace(/\s+[(\[]?\d[\d,]*\+?[)\]]?$/, "").trim();
  n = n.replace(/\s*[·•|:-]\s*$/, "").trim();
  if (!n) return "";
  // "Actions for Water heater pilot out" / "Open details for 5 pm on ..." name a row: keep the verb only
  n = n.replace(/^((?:more |row )?actions?|open details?|open|view|edit|select|expand|collapse|toggle|menu|options|more options|more|manage|details?|add|remove|delete|archive|copy|share|download|preview|open menu) (?:for|on|of) .+$/i, "$1").trim();
  n = n.replace(/^.+ (actions)$/i, "Actions").trim(); // "Patch drywall hole actions" / "PROOF-2001 actions"
  n = n.replace(/^(switch workspace): .+$/i, "$1").trim();
  n = n.replace(/\s+\d+ of(?: \d+)?$/i, "").trim(); // "Workspaces 1 of 3"
  n = n.replace(/(^|\s)\d[\d,]*\+?(?=\s|$)/g, "$1").replace(/\s+/g, " ").trim(); // standalone counts: "6 assigned", "View all 70 →"
  if (/loading|…|\.\.\.$/i.test(n)) return ""; // transient state
  if (/\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?\b,?/i.test(n) && /\b(?:oct|nov|dec|jan|feb|mar|apr|may|jun|jul|aug|sep)[a-z]*\b|day\b/i.test(n)) return ""; // dated
  if (/^[A-Z][\w'.-]*(?: [A-Z][\w'.-]*){0,3}, [A-Z][\w-]*$/.test(n)) return ""; // "Sofia Diaz, In-house" calendar chips
  if (n.length > 80) return "";
  if (/^[\W\d_]+$/.test(n)) return ""; // pure punctuation / digits
  if (n.length === 1 && !/[A-Za-z]/.test(n)) return "";
  if (DATA_PATTERNS.some((re) => re.test(n))) return "";
  if (WEEKDAY_OR_MONTH_ONLY.test(n)) return "";
  if (/next\.?js dev tools|open next\.js|nextjs/i.test(n)) return "";
  return n;
}

// ------------------------------------------------------------- in-page code

/**
 * Runs in the page. Returns raw {name, kind, role, rowish, href} for every
 * visible control. `scope` "page" walks the document, "menus" only open menus.
 */
function collectInPage(scope) {
  const SHELL_SEL = "main, nav, header, aside, [role=navigation], [role=main], [role=menu], [role=dialog]";
  const isVisible = (el) => {
    if (!el.getClientRects().length) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none") return false;
    if (el.closest("[aria-hidden=true], [hidden], [inert]")) return false;
    if (el.closest("nextjs-portal, [data-nextjs-dev-tools], [data-nextjs-toast], [data-nextjs-dialog]")) return false;
    return true;
  };
  const nameOf = (el) => {
    let n = el.getAttribute("aria-label");
    if (!n) {
      const lb = el.getAttribute("aria-labelledby");
      if (lb) n = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
    }
    if (!n || !n.trim()) n = el.innerText || el.textContent || "";
    if (!n.trim()) {
      n =
        el.getAttribute("title") ||
        el.querySelector("img[alt]")?.getAttribute("alt") ||
        el.querySelector("svg title")?.textContent ||
        "";
    }
    return n;
  };
  const out = [];
  const seen = new Set();
  const push = (el, kind) => {
    if (seen.has(el)) return;
    seen.add(el);
    if (!isVisible(el)) return;
    const labelled = !!(el.getAttribute("aria-label") || el.getAttribute("aria-labelledby"));
    const href = el.getAttribute("href") || "";
    const row = el.closest("li, tr, [role=row], [role=listitem], article");
    const nm = nameOf(el);
    out.push({
      name: nm,
      multiline:
        !labelled &&
        el.getAttribute("role") !== "tab" &&
        nm.split(/\n/).map((l) => l.trim()).filter((l) => l && !/^\d[\d,]*\+?$/.test(l)).length > 1,
      kind,
      role: el.getAttribute("role") || el.tagName.toLowerCase(),
      labelled,
      href,
      inMain: !!el.closest("main, [role=main]"),
      rowish: !!row && !el.closest("nav, aside, header, [role=menu], [role=tablist]"),
    });
  };
  if (scope === "menus") {
    for (const el of document.querySelectorAll(
      "[role=menu] a[href], [role=menu] button, [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=dialog] a[href], [role=dialog] button",
    ))
      push(el, "menu");
    return out;
  }
  for (const el of document.querySelectorAll("button, [role=button], [role=tab], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]"))
    push(el, "button");
  for (const el of document.querySelectorAll("a[href]")) {
    if (el.closest(SHELL_SEL)) push(el, "link");
  }
  return out;
}

/** Tag the first row-menu trigger and return whether one exists. */
function tagRowMenuTrigger() {
  document.querySelectorAll("[data-pci-trigger]").forEach((e) => e.removeAttribute("data-pci-trigger"));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest("[aria-hidden=true], [hidden]");
  };
  const MORE = /^(more|row actions?|actions?|options|menu|more actions?|more options)\b/i;
  const GLYPH = /^(⋯|…|\.{3}|⋮|•••)$/;
  const cands = [...document.querySelectorAll("main button, [role=main] button")].filter((el) => {
    if (!visible(el)) return false;
    if (el.closest("nav, aside, header, [role=tablist]")) return false;
    const label = (el.getAttribute("aria-label") || "").trim();
    const text = (el.innerText || "").trim();
    if (/account|workspace|assistant|sidebar/i.test(label)) return false;
    if (GLYPH.test(text) || GLYPH.test(label)) return true;
    if (MORE.test(label)) return true;
    const pop = el.getAttribute("aria-haspopup");
    if (pop && pop !== "false" && pop !== "dialog" && !text && !!el.closest("li, tr, [role=row], [role=listitem], article")) return true;
    return false;
  });
  const el = cands[0];
  if (!el) return false;
  el.setAttribute("data-pci-trigger", "1");
  return true;
}

/** Wait helper executed in page: true once nothing says Loading. */
function isSettledInPage() {
  const main = document.querySelector("main, [role=main]") || document.body;
  const text = main.innerText || "";
  if (/\bloading\b/i.test(text)) return false;
  const busy = [...main.querySelectorAll('[aria-busy="true"], [class*="skeleton" i], [class*="animate-pulse"], [role=progressbar]')].filter(
    (e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    },
  );
  return busy.length === 0;
}

// ----------------------------------------------------------------- browser

async function waitSettled(page) {
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  let calm = 0;
  while (Date.now() < deadline) {
    const ok = await page.evaluate(isSettledInPage).catch(() => false);
    calm = ok ? calm + 1 : 0;
    if (calm >= 2) break;
    await sleep(350);
  }
  // then require the control count + text length to hold still for 3 samples
  const sig = () =>
    page
      .evaluate(() => {
        const m = document.querySelector("main, [role=main]") || document.body;
        return `${m.querySelectorAll("button, a[href], [role=tab]").length}:${(m.innerText || "").length}`;
      })
      .catch(() => "");
  const stableDeadline = Date.now() + 8_000;
  let last = "";
  let same = 0;
  while (Date.now() < stableDeadline) {
    const cur = await sig();
    same = cur === last ? same + 1 : 0;
    last = cur;
    if (same >= 3) break;
    await sleep(600);
  }
  await sleep(300);
}

async function gotoSafe(page, url) {
  for (let i = 0; i < 3; i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
      return true;
    } catch (e) {
      log(`goto ${url} failed (${e.message.split("\n")[0]})`);
      await sleep(1500);
    }
  }
  return false;
}

async function signInOnce(browser, portal) {
  const ctx = await browser.newContext(VIEWPORTS.desktop);
  try {
    return await signInIn(ctx, portal);
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function signInIn(ctx, portal) {
  const { prefix, account, chooser } = PORTALS[portal];
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);
  if (!(await gotoSafe(page, `${BASE}/auth/sign-in?next=${encodeURIComponent(prefix + "/dashboard")}`))) {
    throw new Error("sign-in page unreachable");
  }
  await page.getByPlaceholder("Email").fill(account.email, { timeout: 30_000 });
  await page.getByPlaceholder("Password").fill(account.password);
  let tokenStatus = 0;
  page.on("response", (r) => {
    if (r.url().includes("/auth/v1/token")) tokenStatus = r.status();
  });
  await page.getByRole("button", { name: /sign in/i }).click();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (tokenStatus >= 500) throw new Error(`Supabase auth answered ${tokenStatus}`);
    const p = new URL(page.url()).pathname;
    if (p.startsWith(prefix + "/")) break;
    if (p.startsWith("/auth/choose-portal")) {
      await page.getByRole("button", { name: new RegExp(`^${chooser}`, "i") }).first().click().catch(() => {});
    }
    await sleep(500);
  }
  if (!new URL(page.url()).pathname.startsWith(prefix + "/")) {
    // single-role accounts sometimes need an explicit nudge
    await gotoSafe(page, `${BASE}${prefix}/dashboard`);
  }
  if (!new URL(page.url()).pathname.startsWith(prefix + "/")) throw new Error(`sign-in did not land in ${prefix} (at ${page.url()})`);
  return await ctx.storageState();
}

/** The shared dev Supabase answers 504 under load: retry the sign-in with backoff. */
async function signIn(browser, portal) {
  let lastErr;
  for (let i = 1; i <= 15; i++) {
    try {
      return await signInOnce(browser, portal);
    } catch (e) {
      lastErr = e;
      log(`${portal}: sign-in attempt ${i} failed (${e.message.split("\n")[0]}); retrying`);
      await sleep(6_000);
    }
  }
  throw lastErr;
}

async function closeMenus(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(150);
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(150);
}

const addAll = (set, rows) => {
  for (const r of rows) {
    const n = normaliseName(r.name);
    if (!n) continue;
    if (r.multiline && r.inMain) continue; // a card/row made of several text lines is data, not a control name
    // structural data filters
    if (r.href && /\/[^/?#]*\d[^/?#]*(?:[?#].*)?$/.test(r.href.split("?")[0]) && r.kind === "link" && r.rowish) continue; // detail link with id
    if (r.rowish && r.inMain && !r.labelled && (r.role === "a" || r.role === "button") && /^[A-Z][\w'.-]*(?: [A-Z0-9][\w'.&-]*){1,3}$/.test(n) && !/\b(Add|New|View|Open|Edit|Show|Hide|See|Create|Upload|Download|Manage|Invite|Review)\b/.test(n))
      continue; // title-cased row label: person / property / company name
    set.add(n);
  }
};

async function openAndRead(page, locator, set) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await locator.first().click({ timeout: 10_000 });
      await sleep(500);
      const rows = await page.evaluate(collectInPage, "menus");
      addAll(set, rows);
      await closeMenus(page);
      if (rows.length || attempt) return;
    } catch (e) {
      log(`  menu open failed (attempt ${attempt + 1}): ${e.message.split("\n")[0]}`);
      await closeMenus(page);
      await sleep(1200);
    }
  }
}

async function collectPage(page, set) {
  addAll(set, await page.evaluate(collectInPage, "page"));
  // first row's ⋯ menu
  if (await page.evaluate(tagRowMenuTrigger)) {
    await openAndRead(page, page.locator("[data-pci-trigger]"), set);
    await page.evaluate(() => document.querySelectorAll("[data-pci-trigger]").forEach((e) => e.removeAttribute("data-pci-trigger")));
  }
}

async function walkSection(page, url, set, notes, label) {
  if (!(await gotoSafe(page, url))) {
    failed.add(label);
    return;
  }
  await waitSettled(page);
  const landed = new URL(page.url()).pathname;
  if (landed.startsWith("/auth/")) {
    // the session dropped (shared dev auth is flaky under load): not a page, re-walk it
    failed.add(label);
    return;
  }
  if (landed !== new URL(url).pathname) notes.push(`${label}: redirected to ${landed}`);
  await collectPage(page, set);

  // tabs: click each non-selected, non-destructive tab and collect its state
  const tabInfo = await page
    .evaluate(() =>
      [...document.querySelectorAll("[role=tab]")]
        .filter((e) => e.getBoundingClientRect().width > 0 && !e.closest("[aria-hidden=true]"))
        .map((e) => ({ name: (e.getAttribute("aria-label") || e.innerText || "").trim(), selected: e.getAttribute("aria-selected") === "true" })),
    )
    .catch(() => []);
  const tabs = page.getByRole("tab");
  const count = await tabs.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, MAX_TABS); i++) {
    const info = tabInfo[i];
    if (!info || info.selected || DESTRUCTIVE.test(info.name)) continue;
    try {
      if ((await page.getByRole("tab").count()) !== count) break;
      await tabs.nth(i).click({ timeout: 5000 });
      await waitSettled(page);
      await collectPage(page, set);
    } catch (e) {
      notes.push(`${label}: tab "${info.name}" not walked (${e.message.split("\n")[0]})`);
    }
  }
}

/** Open every collapsed sidebar group so its links render (read-only toggle). */
async function expandGroups(page) {
  const btns = page.locator('nav button[aria-expanded="false"], aside button[aria-expanded="false"]');
  const n = Math.min(await btns.count().catch(() => 0), 8);
  for (let i = 0; i < n; i++) {
    const b = btns.nth(i);
    const nm = (await b.getAttribute("aria-label").catch(() => "")) || (await b.innerText().catch(() => ""));
    if (DESTRUCTIVE.test(nm || "") || !(await b.isVisible().catch(() => false))) continue;
    await b.click({ timeout: 3000 }).catch(() => {});
    await sleep(250);
  }
}

const sectionKey = (prefix, clean, sections) => {
  const rest = clean.slice(prefix.length + 1).split("/").filter(Boolean);
  if (!rest.length) return null;
  const seg = rest[0];
  if (!sections.has(seg)) return seg;
  return sections.get(seg) === clean ? null : `${seg}/${rest[1] ?? ""}`.replace(/\/$/, "");
};

function addSectionHrefs(prefix, hrefs, sections) {
  for (const h of hrefs) {
    const clean = h.split("?")[0].split("#")[0].replace(/\/$/, "");
    const key = sectionKey(prefix, clean, sections);
    if (key && !sections.has(key) && ![...sections.values()].includes(clean)) sections.set(key, clean);
  }
}

async function discoverSections(page, portal) {
  const { prefix } = PORTALS[portal];
  await gotoSafe(page, `${BASE}${prefix}/dashboard`);
  await waitSettled(page);
  await expandGroups(page);
  // hidden (mobile-nav) copies count too: the sidebar group may be collapsed
  const hrefs = await page.evaluate(
    (prefix) =>
      [...document.querySelectorAll("nav a[href], aside a[href]")].map((a) => a.getAttribute("href")).filter((h) => h && h.startsWith(prefix + "/")),
    prefix,
  );
  const sections = new Map();
  addSectionHrefs(prefix, hrefs, sections);
  return sections;
}

async function readShell(page, portal, vpName, shell, sections) {
  const { prefix } = PORTALS[portal];
  await gotoSafe(page, `${BASE}${prefix}/dashboard`);
  await waitSettled(page);
  await expandGroups(page);
  // everything in nav/aside/header
  const rows = await page.evaluate(collectInPage, "page");
  for (const r of rows) {
    // shell = anything not inside main; collectInPage tags inMain
    if (!r.inMain) addAll(shell, [r]);
  }
  // account menu + workspace switcher + (phone) More sheet. Opened, read, closed.
  const triggers = [
    page.locator('button[aria-haspopup="menu"][aria-label*="ccount" i]'),
    page.locator('button[aria-haspopup="menu"][aria-label*="orkspace" i]'),
    page.getByRole("button", { name: /^more$/i }),
    page.getByRole("button", { name: /menu$/i }),
  ];
  for (const t of triggers) {
    const n = await t.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 3); i++) {
      const el = t.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const nm = (await el.getAttribute("aria-label").catch(() => "")) || (await el.innerText().catch(() => ""));
      if (DESTRUCTIVE.test(nm || "")) continue;
      await openAndRead(page, el, shell);
      // account-menu links (e.g. Settings) are extra pages to walk
      const menuLinks = await (async () => {
        try {
          await el.click({ timeout: 4000 });
          await sleep(400);
          return await page.evaluate(
            (prefix) => [...document.querySelectorAll("[role=menu] a[href], [role=dialog] a[href]")].map((a) => a.getAttribute("href")).filter((h) => h && h.startsWith(prefix + "/")),
            prefix,
          );
        } catch {
          return [];
        } finally {
          await closeMenus(page);
        }
      })();
      addSectionHrefs(prefix, menuLinks, sections);
    }
  }
}

async function walkPortal(browser, portal, result, notes, onlyKeys = null) {
  const { prefix } = PORTALS[portal];
  log(`${portal}: signing in as ${PORTALS[portal].account.email}`);
  const state = await signIn(browser, portal);
  const shell = new Set();
  let sections = null;
  const perPage = {};
  for (const vpName of Object.keys(VIEWPORTS)) {
    const ctx = await browser.newContext({ ...VIEWPORTS[vpName], storageState: state });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30_000);
    try {
      if (!sections) sections = await (async () => {
        // sidebar is desktop-only; discover on the desktop pass
        return discoverSections(page, portal);
      })();
      await readShell(page, portal, vpName, shell, sections);
      for (const [seg, href] of sections) {
        const key = `${portal}:${seg}:${vpName}`;
        if (onlyKeys && !onlyKeys.has(key)) continue;
        const set = new Set();
        log(`${key}`);
        try {
          await walkSection(page, `${BASE}${href}`, set, notes, key);
        } catch (e) {
          notes.push(`${key}: ${e.message.split("\n")[0]}`);
        }
        perPage[key] = set;
      }
    } finally {
      await ctx.close();
    }
  }
  // shell names are not repeated in page sets
  for (const [key, set] of Object.entries(perPage)) {
    result[key] = [...set].filter((n) => !shell.has(n)).sort();
  }
  result[`${portal}:shell`] = [...shell].sort();
  return sections;
}

// -------------------------------------------------------------------- main

const portalOf = (key) => key.split(":")[0];
const unionByPortal = (map) => {
  const u = {};
  for (const [k, names] of Object.entries(map)) {
    if (k.startsWith("_")) continue;
    (u[portalOf(k)] ??= new Set());
    for (const n of names) u[portalOf(k)].add(n);
  }
  return u;
};

const started = Date.now();
const browser = await chromium.launch({ headless: true });
const result = {};
const notes = [];
try {
  for (const portal of portalNames) {
    try {
      await walkPortal(browser, portal, result, notes);
    } catch (e) {
      notes.push(`${portal}: could not be walked (${e.message.split("\n")[0]})`);
      log(`${portal} FAILED: ${e.message}`);
    }
  }
} finally {
  await browser.close();
}

// Pages that timed out under load get re-walked (a baseline with a hole is a weak proof).
if (MODE === "baseline") {
  for (let attempt = 1; attempt <= 3 && failed.size; attempt++) {
    const keys = new Set(failed);
    failed.clear();
    const b2 = await chromium.launch({ headless: true });
    try {
      for (const portal of portalNames) {
        const mine = new Set([...keys].filter((k) => portalOf(k) === portal));
        if (!mine.size) continue;
        log(`${portal}: re-walking ${mine.size} page(s) that failed (retry ${attempt})`);
        const again = {};
        try {
          await walkPortal(b2, portal, again, notes, mine);
        } catch (e) {
          log(`${portal} retry failed: ${e.message}`);
          for (const k of mine) failed.add(k);
          continue;
        }
        for (const [k, v] of Object.entries(again)) {
          if (k.endsWith(":shell")) result[k] = [...new Set([...(result[k] ?? []), ...v])].sort();
          else if (mine.has(k)) result[k] = v;
        }
      }
    } finally {
      await b2.close();
    }
  }
  for (const k of failed) notes.push(`${k}: could not be walked (unreachable after retries)`);
}
const secs = Math.round((Date.now() - started) / 1000);

const counts = Object.fromEntries(Object.entries(unionByPortal(result)).map(([p, s]) => [p, s.size]));
if (notes.length) {
  console.error("[inventory] notes:");
  for (const n of notes) console.error("  - " + n);
}

if (MODE === "baseline") {
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  } catch {}
  // a portal that could not be walked keeps what is already on file: never overwrite a baseline with a hole
  const walked = portalNames.filter((p) => Object.keys(result).some((k) => portalOf(k) === p));
  const merged = {};
  for (const [k, v] of Object.entries(existing)) if (!k.startsWith("_") && !walked.includes(portalOf(k))) merged[k] = v;
  Object.assign(merged, result);
  if (flag("merge")) {
    // --merge: union this walk with the names already on file (a loaded dev server can hide a control on one walk)
    for (const [k, v] of Object.entries(existing)) {
      if (k.startsWith("_") || !walked.includes(portalOf(k))) continue;
      merged[k] = [...new Set([...(merged[k] ?? []), ...v.map(normaliseName).filter(Boolean)])].sort();
    }
  }
  const ordered = { _meta: { base: BASE, viewports: Object.fromEntries(Object.entries(VIEWPORTS).map(([k, v]) => [k, `${v.viewport.width}x${v.viewport.height}`])), note: "Control names per portal page; compare checks every name still exists somewhere in the same portal.", portals: Object.keys(unionByPortal(merged)).sort() } };
  for (const k of Object.keys(merged).sort()) ordered[k] = merged[k];
  fs.writeFileSync(FIXTURE, JSON.stringify(ordered, null, 2) + "\n");
  console.log(`baseline written: ${path.relative(ROOT, FIXTURE)}`);
  console.log("names per portal:", JSON.stringify(counts));
  console.log(`runtime ${secs}s`);
  process.exit(notes.some((n) => /could not be walked/.test(n)) ? 1 : 0);
}

// compare
const baseline = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
const normBaseline = Object.fromEntries(
  Object.entries(baseline)
    .filter(([k]) => !k.startsWith("_"))
    .map(([k, v]) => [k, [...new Set(v.map(normaliseName).filter(Boolean))]]),
);
const baseU = unionByPortal(normBaseline);
const nowU = unionByPortal(result);
const missingFor = (portal) => [...(baseU[portal] ?? [])].filter((n) => !nowU[portal]?.has(n)).sort();

// A flaky render must not read as a removed control: re-walk only the pages that
// held a missing name (up to 2 times) and count it found if it shows up anywhere.
const RETRIES = 2;
for (let attempt = 1; attempt <= RETRIES; attempt++) {
  let any = false;
  const b2 = await chromium.launch({ headless: true });
  try {
    for (const portal of portalNames) {
      if (!(portal in nowU)) continue;
      const miss = missingFor(portal);
      if (!miss.length) continue;
      any = true;
      const keys = new Set(
        Object.entries(normBaseline)
          .filter(([k, v]) => portalOf(k) === portal && v.some((n) => miss.includes(n)))
          .map(([k]) => k),
      );
      log(`${portal}: ${miss.length} missing, re-walking ${keys.size} page(s) (retry ${attempt})`);
      const again = {};
      try {
        await walkPortal(b2, portal, again, notes, keys);
      } catch (e) {
        log(`${portal} retry failed: ${e.message}`);
      }
      for (const set of Object.values(again)) for (const n of set) nowU[portal].add(n);
    }
  } finally {
    await b2.close();
  }
  if (!any) break;
}

const missing = [];
for (const portal of portalNames) {
  if (!(portal in nowU)) {
    missing.push(`${portal}: portal could not be walked`);
    continue;
  }
  for (const n of missingFor(portal)) {
    const where = Object.entries(normBaseline)
      .filter(([k, v]) => portalOf(k) === portal && v.includes(n))
      .map(([k]) => k);
    missing.push(`${portal}: "${n}"  (was in ${where.join(", ")})`);
  }
}
console.log(`missing ${missing.length}`);
for (const m of missing) console.log("  - " + m);
console.log("names per portal now:", JSON.stringify(Object.fromEntries(Object.entries(nowU).map(([p, set]) => [p, set.size]))));
console.log(`runtime ${Math.round((Date.now() - started) / 1000)}s`);
process.exit(missing.length ? 1 : 0);
