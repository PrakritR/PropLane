#!/usr/bin/env node
/**
 * Scaffold a Lavish review plan for a Linear ticket.
 *
 * Usage:
 *   npm run lavish:plan -- --ticket PRP-169 --title "..." --summary "..."
 *   npm run lavish:plan -- --ticket PRP-169 --image /path/to/screenshot.png
 *   npm run lavish:plan -- --ticket PRP-169 --open   # open in browser after write
 *
 * Images: pass --image multiple times (Cursor chat attachments). Copied to
 * plan assets/ and embedded in the HTML for Lavish review.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeActiveSession } from "./lavish-session.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

function slugify(s) {
  return s
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
    if (a === "--ticket") out.ticket = next();
    else if (a === "--title") out.title = next();
    else if (a === "--summary") out.summary = next();
    else if (a === "--image") out.images.push(next());
    else if (a === "--open") out.open = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function buildHtml({ ticket, title, summary, imageFiles }) {
  const imageBlocks = imageFiles
    .map(
      (name) =>
        `<figure class="my-4"><img src="assets/${name}" alt="Captain reference" class="max-w-full rounded-lg border border-base-300" /><figcaption class="text-sm opacity-70 mt-1">${name}</figcaption></figure>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${ticket ?? "Plan"} — ${title ?? "PropLane"}</title>
  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
  <link href="https://cdn.jsdelivr.net/npm/daisyui@5/dist/full.min.css" rel="stylesheet" />
  <style>
    body { min-height: 100vh; }
    .prose-section { max-width: 52rem; margin: 0 auto; }
    img { max-height: 70vh; object-fit: contain; }
  </style>
</head>
<body class="bg-base-200 text-base-content p-6 md:p-10">
  <div class="prose-section">
    <div class="badge badge-primary mb-2">${ticket ?? "DRAFT"}</div>
    <h1 class="text-3xl font-bold mb-2">${title ?? "Implementation plan"}</h1>
    <p class="text-base-content/70 mb-8">Review this plan end-to-end before build starts. Annotate or queue feedback in Lavish.</p>

    <div class="card bg-base-100 shadow-md mb-6">
      <div class="card-body">
        <h2 class="card-title text-lg">Summary</h2>
        <p>${summary ?? "_Add summary._"}</p>
      </div>
    </div>

    ${imageBlocks ? `<section class="card bg-base-100 shadow-md mb-6"><div class="card-body"><h2 class="card-title text-lg">Captain references (images)</h2>${imageBlocks}</div></section>` : ""}

    <section class="card bg-base-100 shadow-md mb-6">
      <div class="card-body">
        <h2 class="card-title text-lg">Scope</h2>
        <ul class="list-disc pl-5 space-y-1">
          <li><strong>In scope:</strong> _…_</li>
          <li><strong>Out of scope:</strong> _…_</li>
        </ul>
      </div>
    </section>

    <section class="card bg-base-100 shadow-md mb-6">
      <div class="card-body">
        <h2 class="card-title text-lg">Approach</h2>
        <ol class="list-decimal pl-5 space-y-2">
          <li>_Step 1 — files / routes touched_</li>
          <li>_Step 2 — …_</li>
          <li>_Step 3 — tests + manual walkthrough_</li>
        </ol>
      </div>
    </section>

    <section class="card bg-base-100 shadow-md mb-6">
      <div class="card-body">
        <h2 class="card-title text-lg">Risks &amp; open questions</h2>
        <ul class="list-disc pl-5">
          <li>_…_</li>
        </ul>
      </div>
    </section>

    <section class="card bg-base-100 shadow-md mb-6">
      <div class="card-body">
        <h2 class="card-title text-lg">Test plan</h2>
        <ul class="list-disc pl-5">
          <li>Happy path on <code>localhost:3011</code> (this sandbox)</li>
          <li>Edge cases: _…_</li>
          <li><code>npm run test:unit</code> — targeted specs</li>
        </ul>
      </div>
    </section>

    <div class="alert alert-info mt-8">
      <span>Approve in Lavish or reply in chat: <strong>approved — build</strong></span>
    </div>
    <p class="text-sm text-base-content/60 mt-4">Companion: <code>ticket.md</code> in this folder — run <code>npm run linear:export -- --ticket ${ticket}</code></p>
  </div>
</body>
</html>`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.ticket) {
    console.log(`lavish:plan — scaffold plan HTML for captain review

  npm run workflow:plan -- --chat "…"              # preferred: ticket + plan
  npm run lavish:plan -- --ticket PRP-169 --title "Calendar revamp" --summary "..."
  npm run lavish:plan -- --ticket PRP-169 --image /path/to/upload.png --open

Requires --ticket PRP-### (create with npm run linear:ticket or workflow:plan).

Images: pass each attachment path with --image (copied into plan assets/).`);
    process.exit(args.help ? 0 : 1);
  }

  if (!/^PRP-\d+$/i.test(args.ticket ?? "")) {
    console.error("error: --ticket PRP-### required (create with npm run linear:ticket first)");
    process.exit(1);
  }

  const ticket = args.ticket.toUpperCase();
  const title = args.title ?? "Plan";
  const dirName = `${ticket}-${slugify(title)}`;
  const planDir = join(REPO_ROOT, ".lavish", "plans", dirName);
  const assetsDir = join(planDir, "assets");
  mkdirSync(assetsDir, { recursive: true });

  const copied = [];
  for (const src of args.images) {
    if (!existsSync(src)) {
      console.warn(`warn: image not found: ${src}`);
      continue;
    }
    const name = basename(src);
    const dest = join(assetsDir, name);
    copyFileSync(src, dest);
    copied.push(name);
  }

  const htmlPath = join(planDir, "plan.html");
  writeFileSync(
    htmlPath,
    buildHtml({ ticket, title, summary: args.summary, imageFiles: copied }),
    "utf8",
  );

  console.log(htmlPath);
  console.log(`Plan written: ${htmlPath}`);
  if (copied.length) console.log(`Images: ${copied.join(", ")}`);

  writeActiveSession({ planPath: htmlPath, ticket });

  if (args.open) {
    execFileSync("npx", ["-y", "lavish-axi", htmlPath], { cwd: REPO_ROOT, stdio: "inherit" });
    spawnSync("node", ["scripts/lavish-listen.mjs"], { cwd: REPO_ROOT, stdio: "inherit" });
    console.log("\n⚠ AGENT: Lavish listener started (`npm run lavish:listen`). Run `npm run lavish:poll` each turn.");
  } else {
    console.log(`Open: npx -y lavish-axi ${htmlPath}`);
    console.log(`Poll:  npm run lavish:poll`);
  }
}

main();
