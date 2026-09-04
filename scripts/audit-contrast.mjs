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
    const nodes = result.violations.flatMap((v) => v.nodes);
    console.log(`\n${path} — ${nodes.length} colour-contrast failure${nodes.length === 1 ? "" : "s"}`);
    for (const node of nodes) {
      const summary = (node.any?.[0]?.message ?? "").replace(/\s+/g, " ").trim();
      console.log(`  ${node.target.join(" ")}\n    ${summary}`);
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
