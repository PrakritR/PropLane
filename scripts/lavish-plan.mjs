#!/usr/bin/env node
/**
 * Scaffold the Lavish plan the captain reviews before ANY product code exists.
 *
 * A Linear ticket is NOT required and is never created here — the plan itself
 * is the artifact (see docs/agents/lavish-plan-standard.md).
 *
 * Usage:
 *   npm run lavish:plan -- --title "Calendar revamp" --summary "…" --open
 *   npm run lavish:plan -- --title "…" --image /path/to/screenshot.png
 *   npm run lavish:plan -- --id PRP-169 --title "…"     # only when a ticket exists
 *
 * Images: pass --image per attachment. Copied into the plan's assets/ and
 * embedded so the captain reviews against his own screenshots.
 *
 * The scaffold is a SHELL, not the plan. Fill every `slot` span with real
 * content — especially the UI tab, which must show the screen, not describe it.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { writeActiveSession } from "./lavish-session.mjs";
import { buildPlanHtml } from "./lavish/plan-template.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

function slugify(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function parseArgs(argv) {
  const out = { images: [], open: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--id" || a === "--ticket") out.id = next();
    else if (a === "--title") out.title = next();
    else if (a === "--summary") out.summary = next();
    else if (a === "--image") out.images.push(next());
    else if (a === "--open") out.open = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

/** Sandbox origin this pane serves on, so the plan's mock URL is the real one. */
function sandboxUrl() {
  const envPath = join(REPO_ROOT, ".env.local");
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, "utf8").match(/^NEXT_PUBLIC_APP_URL=(.*)$/m);
    if (m?.[1]?.includes("localhost")) return m[1].trim();
  }
  return "http://localhost:3000";
}

/** PLAN-0907-1432 — sortable, unique, needs no ticket system. */
function generatePlanId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `PLAN-${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.title) {
    console.log(`lavish:plan — scaffold the plan the captain reviews before build

  npm run workflow:plan -- --chat "<his message>"        # preferred one-shot
  npm run lavish:plan -- --title "Calendar revamp" --summary "…" --open
  npm run lavish:plan -- --title "…" --image /path/to/upload.png

Options:
  --title <t>     required — what the plan is called
  --summary <s>   one paragraph, in the captain's words
  --image <path>  captain screenshot (repeatable, copied into assets/)
  --id <id>       optional label (e.g. PRP-169); a plan id is generated otherwise
  --open          open Lavish and start the listener

No Linear ticket is created or required. Fill the scaffold before showing it:
docs/agents/lavish-plan-standard.md`);
    process.exit(args.help ? 0 : 1);
  }

  const id = (args.id ?? generatePlanId()).toUpperCase();
  const title = args.title;
  const planDir = join(REPO_ROOT, ".lavish", "plans", `${id}-${slugify(title)}`);
  const assetsDir = join(planDir, "assets");
  mkdirSync(assetsDir, { recursive: true });

  const copied = [];
  for (const src of args.images) {
    if (!existsSync(src)) {
      console.warn(`warn: image not found: ${src}`);
      continue;
    }
    const name = basename(src);
    copyFileSync(src, join(assetsDir, name));
    copied.push(name);
  }

  const htmlPath = join(planDir, "plan.html");
  writeFileSync(
    htmlPath,
    buildPlanHtml({
      id,
      title,
      summary: args.summary,
      imageFiles: copied,
      sandboxUrl: sandboxUrl(),
    }),
    "utf8",
  );

  console.log(htmlPath);
  console.log(`Plan written: ${htmlPath}`);
  if (copied.length) console.log(`Images: ${copied.join(", ")}`);
  console.log(`\n⚠ SCAFFOLD ONLY — fill every "slot" span (especially the UI tab) before showing the captain.`);
  console.log(`   Edit: ${relative(REPO_ROOT, htmlPath)}`);

  writeActiveSession({ planPath: htmlPath, ticket: id });

  if (args.open) {
    execFileSync("npx", ["-y", "lavish-axi", htmlPath], { cwd: REPO_ROOT, stdio: "inherit" });
    spawnSync("node", ["scripts/lavish-listen.mjs"], { cwd: REPO_ROOT, stdio: "inherit" });
    console.log("\n⚠ AGENT: listener started. Run `npm run lavish:poll` every turn until approval.");
  } else {
    console.log(`\nOpen:   npx -y lavish-axi ${htmlPath}`);
    console.log(`Listen: npm run lavish:listen`);
    console.log(`Poll:   npm run lavish:poll`);
  }
}

main();
