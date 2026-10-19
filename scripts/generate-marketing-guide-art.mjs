#!/usr/bin/env node
/**
 * Regenerates the homepage guide art in `public/marketing/`.
 *
 * Both boards are authored at 900x460 CSS px and captured at 2x, so the files
 * land at the 1800x920 the `.lp-chapter .lp-art` box expects (see AGENTS.md,
 * "Marketing mocks must use portal-accurate copy").
 *
 * Each board is rendered in BOTH themes: `guide-messages.webp` /
 * `guide-tours.webp` (light) and `guide-messages-dark.webp` /
 * `guide-tours-dark.webp` (dark). A page swaps which pair it shows based on
 * `data-theme` (the `.lp-art-img-light` / `.lp-art-img-dark` rules in
 * `landing-proplane.css`), so the dark theme gets dark portal mocks.
 *
 * THIS SCRIPT DOES NOT IMPORT FROM `src/`. It hand-authors a standalone HTML
 * replica of two portal screens: every colour is a literal value copied from the
 * theme tokens (`PALETTES.light` from the light tokens, `PALETTES.dark` from the
 * `[data-theme="dark"]` `--pl-*` + `.portal-calendar-*` / `.portal-table-th`
 * rules in `globals.css`), and every label is a copied string. A portal rename or
 * a token retune therefore leaves this art silently stale — re-check the copied
 * labels (see `TOURS_LABELS` / `SCHEDULE_LABELS`) against their source component
 * whenever you regenerate.
 *
 * Every count rendered on a board is DERIVED from the rows/cells the board
 * actually draws — the per-day "N open" headers and the week total come from
 * the slot grid, and the Schedule tab badge comes from the message list — so a
 * mock can never claim a number its own screenshot contradicts.
 *
 * Usage: node scripts/generate-marketing-guide-art.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(REPO_ROOT, "public", "marketing");
const WIDTH = 900;
const HEIGHT = 460;
const SCALE = 2;
const QUALITY = 92;
const COMMAND_TIMEOUT_MS = 30_000;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

/* ---------------------------------------------------------------- content */

/** Copied verbatim from the availability week in `portal-calendar-panels.tsx`. */
const TOURS_LABELS = {
  eyebrow: "Your availability",
  timeColumn: "Time",
  openSlot: "Open",
  weekBadge: (count) => `${count} open`,
  dayCount: (count) => `${count} open`,
  actions: ["Copy previous week", "Create block", "Clear week", "Update to houses"],
};

/**
 * Copied verbatim from `manager-inbox-schedule-panel.tsx` (columns + source
 * chip) and `INBOX_TAB_DEFS` in `portal-inbox-ui.tsx` (tab names and order).
 */
const SCHEDULE_LABELS = {
  title: "Communication",
  columns: ["Send date & time", "Source", "Recipient", "Topic", "Subject", "Status"],
  automatedSource: "Automated",
  scheduledStatus: "Scheduled",
  tabs: ["Unopened", "Opened", "Schedule", "Sent", "Trash"],
};

/**
 * Calendar → availability week. `slots[i]` is the cell drawn at `TOUR_TIMES[i]`:
 * "open" renders the green Open slot, an object renders a booked tour, null
 * renders an empty cell.
 */
const TOUR_TIMES = ["9:00 AM", "9:30 AM", "10:00 AM", "10:30 AM", "11:00 AM"];

const TOUR_DAYS = [
  { weekday: "Tue", date: "Jul 21", slots: ["open", "open", { tour: "P. Nair" }, "open", "open"] },
  { weekday: "Wed", date: "Jul 22", slots: [{ tour: "M. Chen" }, "open", "open", "open", null] },
  { weekday: "Thu", date: "Jul 23", slots: ["open", null, "open", "open", { tour: "J. Lee" }] },
  { weekday: "Fri", date: "Jul 24", slots: [null, { tour: "D. Ramos" }, "open", "open", "open"] },
  { weekday: "Sat", date: "Jul 25", slots: ["open", "open", null, "open", "open"] },
];

const openSlotCount = (day) => day.slots.filter((slot) => slot === "open").length;
const WEEK_OPEN_COUNT = TOUR_DAYS.reduce((total, day) => total + openSlotCount(day), 0);

/** Communication → Schedule tab rows. */
const SCHEDULE_ROWS = [
  {
    sendAt: "Jul 22, 9:00 AM",
    name: "Maya Chen",
    email: "maya.chen@example.com",
    topic: "August rent",
    unit: "Cascade Lofts · 4B",
    subject: "Rent due in 3 days",
  },
  {
    sendAt: "Jul 24, 8:00 AM",
    name: "Dev Ramos",
    email: "dev.ramos@example.com",
    topic: "Tour confirmation",
    unit: "Ballard Commons · 1C",
    subject: "Your tour is confirmed",
  },
  {
    sendAt: "Jul 28, 9:00 AM",
    name: "Priya Nair",
    email: "priya.nair@example.com",
    topic: "Lease renewal",
    unit: "Cascade Lofts · 2A",
    subject: "Renewal terms ready",
  },
  {
    sendAt: "Aug 1, 9:00 AM",
    name: "Jordan Lee",
    email: "jordan.lee@example.com",
    topic: "August rent",
    unit: "Cascade Court · 3A",
    subject: "Rent is due today",
  },
];

const OTHER_TAB_COUNTS = { Unopened: 2, Opened: 0, Sent: 1, Trash: 0 };

const INBOX_TABS = SCHEDULE_LABELS.tabs.map((label) => ({
  label,
  active: label === "Schedule",
  count: label === "Schedule" ? SCHEDULE_ROWS.length : OTHER_TAB_COUNTS[label],
}));

/* ------------------------------------------------------------------ themes */

/**
 * Two palettes, one markup. Every colour on both boards is a `var(--g-*)` whose
 * value comes from the palette below. LIGHT values are the literal light-theme
 * hexes this script always used; DARK values are copied from the portal dark
 * tokens in `src/app/globals.css` — the `--pl-*` dark block plus the
 * `[data-theme="dark"] .portal-calendar-*` / `.portal-table-th` rules — so the
 * dark art matches the real dark portal surfaces rather than an inverted guess.
 */
const PALETTES = {
  light: {
    bodyBg: "#fdfdfd",
    bodyFg: "#17181a",
    pillBorder: "#e4e6ea",
    pillBg: "#fff",
    pillFg: "#17181a",
    badgeSuccessBg: "rgb(209 250 229)",
    badgeSuccessFg: "rgb(6 95 70)",
    badgeSuccessBorder: "transparent",
    cardBorder: "#e8e8e8",
    cardBg: "#fff",
    navBg: "#fff",
    navFg: "#17181a",
    weekLab: "#5c6068",
    weekRng: "#17181a",
    weekScope: "#2f6bff",
    hcBg: "#e7edff",
    hcWd: "#5c6068",
    hcDt: "#17181a",
    hcOc: "#15794a",
    tcFg: "#5c6068",
    ln: "#ededed",
    slotOpenBg: "#d9fbe6",
    slotOpenFg: "#15794a",
    slotOpenRing: "#b3e0c3",
    slotTourBg: "#e7edff",
    slotTourFg: "#4a6fd6",
    slotTourRing: "#d3ddfb",
    tabsBg: "#ebf0fc",
    tabFg: "#4a4f57",
    tabOnBg: "#fff",
    tabOnFg: "#17181a",
    tabOnShadow: "0 1px 2px rgba(8, 9, 11, 0.1)",
    chipBg: "#e3e8f2",
    chipFg: "#4a4f57",
    chipOnBg: "#e7edff",
    chipOnFg: "#3b5ce0",
    rule: "#ececec",
    thBg: "#eff3ff",
    thFg: "#5c6068",
    tdLine: "#efefef",
    whenFg: "#17181a",
    srcBorder: "#e2e8f8",
    srcBg: "#eff4fd",
    srcFg: "#4a4f57",
    nmFg: "#17181a",
    tpFg: "#17181a",
    subFg: "#8a8f98",
    subjFg: "#17181a",
    chevFg: "#8a8f98",
    statusBg: "#e7edff",
    statusFg: "#3b5ce0",
  },
  dark: {
    // Portal shell = --pl-surface-raised (#0f1011); text = --pl-ink (#f7f8f8).
    bodyBg: "#0f1011",
    bodyFg: "#f7f8f8",
    pillBorder: "rgba(255, 255, 255, 0.14)", // --pl-line-strong
    pillBg: "#16181b", // --pl-surface-muted
    pillFg: "#f7f8f8",
    badgeSuccessBg: "rgba(22, 163, 74, 0.24)", // .portal-calendar-badge-success
    badgeSuccessFg: "#bbf7d0",
    badgeSuccessBorder: "rgba(74, 222, 128, 0.38)",
    cardBorder: "rgba(255, 255, 255, 0.08)", // --pl-line
    cardBg: "#0f1011",
    navBg: "#16181b",
    navFg: "#f7f8f8",
    weekLab: "#8a8f98", // --pl-muted-fg
    weekRng: "#f7f8f8",
    weekScope: "#9a9cf5", // --pl-purple-soft (dark brand = purple, never blue)
    hcBg: "rgba(255, 255, 255, 0.09)", // .portal-calendar-header-cell
    hcWd: "rgba(255, 255, 255, 0.84)",
    hcDt: "#f7f8f8",
    hcOc: "#86efac", // .portal-calendar-open-count
    tcFg: "rgba(255, 255, 255, 0.8)", // .portal-calendar-time-cell
    ln: "rgba(255, 255, 255, 0.08)",
    slotOpenBg: "rgba(22, 163, 74, 0.34)", // .portal-calendar-open-slot
    slotOpenFg: "#ecfdf5",
    slotOpenRing: "rgba(74, 222, 128, 0.5)",
    slotTourBg: "rgba(56, 189, 248, 0.28)", // .portal-calendar-meeting-confirmed
    slotTourFg: "#f0f9ff",
    slotTourRing: "rgba(125, 211, 252, 0.55)",
    tabsBg: "rgba(255, 255, 255, 0.06)",
    tabFg: "#8a8f98",
    tabOnBg: "#16181b",
    tabOnFg: "#f7f8f8",
    tabOnShadow: "0 1px 2px rgba(0, 0, 0, 0.4)",
    chipBg: "rgba(255, 255, 255, 0.1)",
    chipFg: "#8a8f98",
    chipOnBg: "rgba(124, 127, 242, 0.18)", // --status-approved-bg (dark)
    chipOnFg: "#b8baf6", // --status-approved-fg (dark)
    rule: "rgba(255, 255, 255, 0.08)",
    thBg: "#16181b",
    thFg: "rgba(255, 255, 255, 0.82)", // .portal-table-th (dark)
    tdLine: "rgba(255, 255, 255, 0.08)",
    whenFg: "#f7f8f8",
    srcBorder: "rgba(255, 255, 255, 0.14)",
    srcBg: "rgba(255, 255, 255, 0.06)",
    srcFg: "#8a8f98",
    nmFg: "#f7f8f8",
    tpFg: "#f7f8f8",
    subFg: "#8a8f98",
    subjFg: "#f7f8f8",
    chevFg: "#8a8f98",
    statusBg: "rgba(124, 127, 242, 0.18)", // --status-approved-bg (dark)
    statusFg: "#b8baf6", // --status-approved-fg (dark)
  },
};

/** Emit the palette as `:root` custom properties the shared CSS reads. */
const themeVars = (theme) => {
  const p = PALETTES[theme];
  return `:root{${Object.entries(p)
    .map(([key, value]) => `--g-${key}:${value};`)
    .join("")}}`;
};

/* ------------------------------------------------------------------ markup */

const BASE_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    width: ${WIDTH}px;
    height: ${HEIGHT}px;
    overflow: hidden;
    background: var(--g-bodyBg);
    color: var(--g-bodyFg);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", ui-sans-serif, system-ui, sans-serif;
    line-height: 1.4;
    -webkit-font-smoothing: antialiased;
  }
  .board { padding: 24px 26px; }
  .pill-btn {
    display: inline-flex; align-items: center;
    border: 1px solid var(--g-pillBorder); background: var(--g-pillBg); border-radius: 999px;
    padding: 7px 17px; font-size: 13px; font-weight: 600; color: var(--g-pillFg);
  }
  .badge-success {
    border-radius: 999px; background: var(--g-badgeSuccessBg); color: var(--g-badgeSuccessFg);
    border: 1px solid var(--g-badgeSuccessBorder);
    padding: 5px 13px; font-size: 13px; font-weight: 700;
  }
  .card { border: 1px solid var(--g-cardBorder); border-radius: 14px; background: var(--g-cardBg); overflow: hidden; }
`;

const escapeHtml = (value) =>
  String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function toursHtml(theme) {
  const headerCells = TOUR_DAYS.map(
    (day) => `
      <div class="hc day">
        <p class="wd">${escapeHtml(day.weekday)}</p>
        <p class="dt">${escapeHtml(day.date)}</p>
        <p class="oc">${escapeHtml(TOURS_LABELS.dayCount(openSlotCount(day)))}</p>
      </div>`,
  ).join("");

  const bodyRows = TOUR_TIMES.map((time, rowIdx) => {
    const edge = rowIdx === 0 ? "" : " ln";
    const cells = TOUR_DAYS.map((day) => {
      const slot = day.slots[rowIdx];
      if (slot === "open")
        return `<div class="sc${edge}"><span class="slot open">${escapeHtml(TOURS_LABELS.openSlot)}</span></div>`;
      if (slot && slot.tour)
        return `<div class="sc${edge}"><span class="slot tour">Tour · ${escapeHtml(slot.tour)}</span></div>`;
      return `<div class="sc${edge}"></div>`;
    }).join("");
    return `<div class="tc${edge}">${escapeHtml(time)}</div>${cells}`;
  }).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><style>${themeVars(theme)}${BASE_CSS}
    .top { display: flex; align-items: center; gap: 11px; }
    .nav {
      display: flex; align-items: center; justify-content: center;
      height: 31px; width: 31px; border-radius: 999px; border: 1px solid var(--g-cardBorder);
      background: var(--g-navBg); font-size: 14px; color: var(--g-navFg);
    }
    .week { border: 1px solid var(--g-cardBorder); border-radius: 14px; background: var(--g-cardBg); padding: 7px 17px; }
    .week .lab { font-size: 9px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--g-weekLab); }
    .week .rng { margin: 1px 0 0; font-size: 17px; font-weight: 700; letter-spacing: -0.01em; color: var(--g-weekRng); }
    .week .scope { margin: 1px 0 0; font-size: 11px; font-weight: 600; color: var(--g-weekScope); }
    .week p { margin: 0; }
    .spacer { flex: 1; }
    .actions { display: flex; gap: 10px; margin-top: 15px; }
    .grid {
      display: grid; grid-template-columns: 84px repeat(5, 1fr);
      margin-top: 17px; font-size: 12px;
    }
    .hc { background: var(--g-hcBg); padding: 7px 6px; }
    .hc.time { display: flex; align-items: center; font-size: 9px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--g-hcWd); padding-left: 12px; }
    .hc.day { text-align: center; }
    .hc p { margin: 0; }
    .hc .wd { font-size: 9px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--g-hcWd); }
    .hc .dt { margin-top: 1px; font-size: 12px; font-weight: 700; color: var(--g-hcDt); }
    .hc .oc { margin-top: 1px; font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--g-hcOc); }
    .tc { display: flex; align-items: center; height: 36px; padding-left: 12px; font-size: 12px; font-weight: 600; color: var(--g-tcFg); }
    .sc { display: flex; align-items: center; height: 36px; padding: 0 7px; }
    .ln { border-top: 1px solid var(--g-ln); }
    .slot {
      display: flex; align-items: center; justify-content: center;
      width: 100%; height: 26px; border-radius: 8px; font-size: 12px; font-weight: 600;
    }
    .slot.open { background: var(--g-slotOpenBg); color: var(--g-slotOpenFg); box-shadow: inset 0 0 0 1px var(--g-slotOpenRing); }
    .slot.tour { background: var(--g-slotTourBg); color: var(--g-slotTourFg); box-shadow: inset 0 0 0 1px var(--g-slotTourRing); }
  </style></head><body><div class="board">
    <div class="top">
      <span class="nav">←</span>
      <div class="week">
        <p class="lab">${escapeHtml(TOURS_LABELS.eyebrow)}</p>
        <p class="rng">Jul 21 – Jul 25, 2026</p>
        <p class="scope">Calendar · Ballard Commons</p>
      </div>
      <span class="nav">→</span>
      <span class="spacer"></span>
      <span class="badge-success">${escapeHtml(TOURS_LABELS.weekBadge(WEEK_OPEN_COUNT))}</span>
    </div>
    <div class="actions">
      ${TOURS_LABELS.actions.map((action) => `<span class="pill-btn">${escapeHtml(action)}</span>`).join("")}
    </div>
    <div class="card grid">
      <div class="hc time">${escapeHtml(TOURS_LABELS.timeColumn)}</div>
      ${headerCells}
      ${bodyRows}
    </div>
  </div></body></html>`;
}

const SCHEDULE_COLUMN_WIDTHS = ["17%", "13%", "21%", "21%", "18%", "14%"];

function messagesHtml(theme) {
  const columnHeads = SCHEDULE_LABELS.columns
    .map((column, idx) => `<th style="width: ${SCHEDULE_COLUMN_WIDTHS[idx]}">${escapeHtml(column)}</th>`)
    .join("");

  const tabs = INBOX_TABS.map(
    (tab) => `
      <span class="tab${tab.active ? " on" : ""}">
        ${escapeHtml(tab.label)}<span class="chip">${tab.count}</span>
      </span>`,
  ).join("");

  const rows = SCHEDULE_ROWS.map(
    (row) => `
      <tr>
        <td class="when">${escapeHtml(row.sendAt)}</td>
        <td><span class="src">${escapeHtml(SCHEDULE_LABELS.automatedSource)}</span></td>
        <td><p class="nm">${escapeHtml(row.name)}</p><p class="sub">${escapeHtml(row.email)}</p></td>
        <td><p class="tp">${escapeHtml(row.topic)}</p><p class="sub">${escapeHtml(row.unit)}</p></td>
        <td class="subj">${escapeHtml(row.subject)} <span class="chev">›</span></td>
        <td><span class="status">${escapeHtml(SCHEDULE_LABELS.scheduledStatus)}</span></td>
      </tr>`,
  ).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><style>${themeVars(theme)}${BASE_CSS}
    h1 { margin: 0; font-size: 26px; font-weight: 700; letter-spacing: -0.02em; }
    .tabs { display: inline-flex; align-items: center; gap: 2px; margin-top: 14px; background: var(--g-tabsBg); border-radius: 999px; padding: 5px; }
    .tab { display: inline-flex; align-items: center; border-radius: 999px; padding: 6px 15px; font-size: 13.5px; font-weight: 600; color: var(--g-tabFg); }
    .tab.on { background: var(--g-tabOnBg); color: var(--g-tabOnFg); box-shadow: var(--g-tabOnShadow); }
    .chip { margin-left: 7px; border-radius: 999px; background: var(--g-chipBg); padding: 0 6px; font-size: 11px; font-weight: 700; color: var(--g-chipFg); }
    .tab.on .chip { background: var(--g-chipOnBg); color: var(--g-chipOnFg); }
    .rule { margin-top: 14px; border-top: 1px solid var(--g-rule); }
    table { width: 100%; margin-top: 16px; border-collapse: collapse; table-layout: fixed; }
    th { background: var(--g-thBg); padding: 11px 13px; text-align: left; font-size: 9.5px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--g-thFg); }
    td { padding: 11px 13px; border-top: 1px solid var(--g-tdLine); vertical-align: middle; }
    tr:first-child td { border-top: 0; }
    td p { margin: 0; }
    .when { font-size: 12.5px; font-weight: 600; color: var(--g-whenFg); }
    .src { display: inline-flex; border: 1px solid var(--g-srcBorder); border-radius: 999px; background: var(--g-srcBg); padding: 2px 9px; font-size: 11px; font-weight: 600; color: var(--g-srcFg); }
    .nm { font-size: 13.5px; font-weight: 700; color: var(--g-nmFg); }
    .tp { font-size: 12.5px; color: var(--g-tpFg); }
    .sub { font-size: 11px; color: var(--g-subFg); }
    .subj { font-size: 12.5px; font-weight: 600; color: var(--g-subjFg); }
    .chev { color: var(--g-chevFg); }
    .status { display: inline-flex; border-radius: 999px; background: var(--g-statusBg); padding: 3px 10px; font-size: 11.5px; font-weight: 700; color: var(--g-statusFg); }
  </style></head><body><div class="board">
    <h1>${escapeHtml(SCHEDULE_LABELS.title)}</h1>
    <div class="tabs">${tabs}</div>
    <div class="rule"></div>
    <div class="card"><table>
      <thead><tr>${columnHeads}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div></body></html>`;
}

/* -------------------------------------------------------------------- CDP */

function resolveChrome() {
  const found = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`No Chrome binary found. Set CHROME_PATH. Tried:\n${CHROME_CANDIDATES.join("\n")}`);
  return found;
}

async function withChrome(run) {
  const chromePath = resolveChrome();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "proplane-guide-art-"));
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--force-color-profile=srgb",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const chromeExited = new Promise((resolve) => {
    chrome.once("exit", resolve);
    chrome.once("close", resolve);
  });
  const waitForExit = (ms) =>
    Promise.race([chromeExited, new Promise((resolve) => setTimeout(resolve, ms))]);

  let chromeDead = null;
  const chromeDeadListeners = [];
  const markChromeDead = (reason) => {
    if (chromeDead) return;
    chromeDead = reason;
    for (const listener of chromeDeadListeners) listener(reason);
  };
  chrome.once("error", (error) => markChromeDead(new Error(`Chrome failed to start: ${error.message}`)));
  chrome.once("exit", (code, signal) =>
    markChromeDead(new Error(`Chrome exited before the capture finished (code ${code}, signal ${signal}).`)),
  );

  try {
    const portFile = path.join(userDataDir, "DevToolsActivePort");
    let port = null;
    for (let attempt = 0; attempt < 200 && port === null; attempt += 1) {
      if (chromeDead) throw chromeDead;
      if (fs.existsSync(portFile)) {
        const first = fs.readFileSync(portFile, "utf8").split("\n")[0]?.trim();
        if (first) port = first;
      }
      if (port === null) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (port === null) throw new Error("Chrome did not expose a DevTools port.");

    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("DevTools socket failed to open.")), { once: true });
      socket.addEventListener("close", () => reject(new Error("DevTools socket closed before opening.")), { once: true });
      chromeDeadListeners.push(reject);
    });

    let nextId = 0;
    let failure = null;
    const pending = new Map();

    const failAll = (reason) => {
      failure ??= reason;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(reason);
      }
      pending.clear();
    };
    socket.addEventListener("close", () => failAll(new Error("DevTools socket closed mid-command.")), { once: true });
    socket.addEventListener("error", () => failAll(new Error("DevTools socket errored mid-command.")), { once: true });
    chromeDeadListeners.push(failAll);
    if (chromeDead) failAll(chromeDead);

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const { resolve, reject, timer } = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });

    const send = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        if (failure) {
          reject(failure);
          return;
        }
        const id = (nextId += 1);
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          reject(new Error(`DevTools command timed out after ${COMMAND_TIMEOUT_MS}ms: ${method}`));
        }, COMMAND_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });

    try {
      return await run(send);
    } finally {
      failAll(new Error("DevTools session closed."));
      socket.close();
    }
  } finally {
    chrome.kill();
    await waitForExit(5_000);
    if (chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill("SIGKILL");
      await waitForExit(2_000);
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function capture(send, html) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send(
    "Emulation.setDeviceMetricsOverride",
    { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false },
    sessionId,
  );
  const { frameTree } = await send("Page.getFrameTree", {}, sessionId);
  await send("Page.setDocumentContent", { frameId: frameTree.frame.id, html }, sessionId);
  await send(
    "Runtime.evaluate",
    { expression: "document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))", awaitPromise: true },
    sessionId,
  );
  const shot = await send(
    "Page.captureScreenshot",
    { format: "webp", quality: QUALITY, captureBeyondViewport: false },
    sessionId,
  );
  await send("Target.closeTarget", { targetId });
  return Buffer.from(shot.data, "base64");
}

/* -------------------------------------------------------------------- main */

const boards = [
  { file: "guide-messages.webp", html: messagesHtml("light") },
  { file: "guide-tours.webp", html: toursHtml("light") },
  { file: "guide-messages-dark.webp", html: messagesHtml("dark") },
  { file: "guide-tours-dark.webp", html: toursHtml("dark") },
];

await withChrome(async (send) => {
  for (const board of boards) {
    const bytes = await capture(send, board.html);
    fs.writeFileSync(path.join(OUT_DIR, board.file), bytes);
    console.log(`${board.file}  ${WIDTH * SCALE}x${HEIGHT * SCALE}  ${(bytes.length / 1024).toFixed(1)} KB`);
  }
});

console.log(
  `guide-tours open counts: ${TOUR_DAYS.map((d) => `${d.weekday} ${openSlotCount(d)}`).join(", ")} — week total ${WEEK_OPEN_COUNT}`,
);
console.log(`guide-messages Schedule badge: ${SCHEDULE_ROWS.length} (rows drawn: ${SCHEDULE_ROWS.length})`);
