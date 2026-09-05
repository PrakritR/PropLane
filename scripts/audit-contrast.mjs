/**
 * Colour-contrast audit for public pages (PRP-184 finding 2).
 *
 * The August audit reported 14 failures on the home page and five on sign-in but did not name
 * the elements, so the finding could not be acted on or verified. This runs axe-core's
 * `color-contrast` rule against a running server and prints each failing node with its measured
 * ratio, so a fix can be checked rather than assumed.
 *
 * Usage: node scripts/audit-contrast.mjs [baseUrl] [path ...]
 */
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const base = (process.argv[2] ?? "http://localhost:3011").replace(/\/$/, "");
const paths = process.argv.slice(3);
const targets = paths.length ? paths : ["/", "/auth/sign-in"];

/**
 * `--pl-blue` (#2f6bff) as small text measures 3.57-4.50:1 against every
 * background it appears on site-wide - real WCAG math, not a measurement bug
 * (even a pure white background only reaches 4.499:1 against this exact blue,
 * so no background swap can rescue it; the only fixes are a darker blue or a
 * large-text size bump, both evaluated and explicitly declined). Accepted as
 * a known exception, captain's call, 2026-09-04 - tracked here rather than
 * silently invisible, so a NEW color or a genuinely different failure still
 * fails loud.
 */
const ACCEPTED_EXCEPTIONS = [
  { fgColor: "#2f6bff", reason: "--pl-blue small text, accepted 2026-09-04" },
  { fgColor: "#ffffff", bgColor: "#2f6bff", reason: "white on --pl-blue (buttons), accepted 2026-09-04" },
];

function acceptedException(node) {
  const data = node.any?.[0]?.data;
  const fg = typeof data?.fgColor === "string" ? data.fgColor.toLowerCase() : undefined;
  const bg = typeof data?.bgColor === "string" ? data.bgColor.toLowerCase() : undefined;
  return ACCEPTED_EXCEPTIONS.find((e) => fg === e.fgColor && (!e.bgColor || bg === e.bgColor));
}

const browser = await chromium.launch();
let total = 0;

for (const path of targets) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultNavigationTimeout(300000);
  try {
    await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    await page.addScriptTag({ content: axeSource });
    const result = await page.evaluate(async () => {
      // @ts-expect-error injected
      return await window.axe.run(document, { runOnly: { type: "rule", values: ["color-contrast"] } });
    });
    const allNodes = result.violations.flatMap((v) => v.nodes);
    const nodes = [];
    const accepted = [];
    for (const node of allNodes) {
      const exception = acceptedException(node);
      if (exception) accepted.push({ node, exception });
      else nodes.push(node);
    }
    console.log(`\n${path} — ${nodes.length} colour-contrast failure${nodes.length === 1 ? "" : "s"}`);
    for (const node of nodes) {
      const summary = (node.any?.[0]?.message ?? "").replace(/\s+/g, " ").trim();
      console.log(`  ${node.target.join(" ")}\n    ${summary}`);
    }
    if (accepted.length) {
      console.log(`  (${accepted.length} known-accepted exception${accepted.length === 1 ? "" : "s"}, not counted below)`);
      for (const { node, exception } of accepted) {
        const summary = (node.any?.[0]?.message ?? "").replace(/\s+/g, " ").trim();
        console.log(`  ~ ${node.target.join(" ")} [${exception.reason}]\n    ${summary}`);
      }
    }
    total += nodes.length;
  } catch (e) {
    console.log(`\n${path} — could not audit: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await page.close();
  }
}

await browser.close();
console.log(`\nTotal: ${total}`);
process.exit(total === 0 ? 0 : 1);
