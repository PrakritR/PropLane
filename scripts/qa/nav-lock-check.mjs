import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const BASE = "http://localhost:3000";
const state = JSON.parse(readFileSync(".testmanager/auth/resident.json", "utf8"));
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, storageState: state });
const p = await ctx.newPage();
await p.goto(`${BASE}/resident/dashboard`, { waitUntil: "domcontentloaded" });
await p.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
const nav = await p.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('a[href^="/resident/"], [data-attr^="bottom-nav-"], [aria-disabled]')) {
    const href = el.getAttribute("href");
    const text = (el.textContent || "").trim().slice(0, 28);
    if (!text) continue;
    out.push({ tag: el.tagName, href, text, disabled: el.getAttribute("aria-disabled"), cls: (el.className||"").toString().slice(0,40) });
  }
  return out;
});
const seen = new Set();
for (const n of nav) {
  const k = `${n.tag}|${n.href}|${n.text}`;
  if (seen.has(k)) continue; seen.add(k);
  if (/move-in|House details|Services|Lease|Payments|Documents/i.test(n.text + (n.href||""))) {
    console.log(`${n.tag.padEnd(6)} href=${String(n.href).padEnd(28)} aria-disabled=${String(n.disabled).padEnd(5)} "${n.text}"`);
  }
}
await b.close();
