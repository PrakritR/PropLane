#!/usr/bin/env node
/**
 * Phase ① + ②: Linear ticket (required) → Lavish plan scaffold → open for review.
 * Does NOT build code. Captain must say "approved — build" before phase ③.
 *
 * Usage:
 *   npm run workflow:plan -- --chat "Residents tab crashes on open"
 *   npm run workflow:plan -- --ticket PRP-170 --title "..." --summary "..." --image /path.png
 *
 * Requires LINEAR_API_KEY in .env.local
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendIssueSection, fetchIssue } from "./linear/update-issue.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

function parseArgs(argv) {
  const out = { images: [], open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--chat") out.chat = next();
    else if (a === "--ticket") out.ticket = next();
    else if (a === "--title") out.title = next();
    else if (a === "--summary") out.summary = next();
    else if (a === "--image") out.images.push(next());
    else if (a === "--no-open") out.open = false;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function runNode(script, extraArgs) {
  const r = spawnSync(process.execPath, [script, ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    throw new Error(r.stderr?.trim() || r.stdout?.trim() || `${script} failed`);
  }
  return r.stdout.trim();
}

function printHelp() {
  console.log(`PropLane workflow — ticket first, then Lavish plan (no code until approved)

  npm run workflow:plan -- --chat "describe the work"
  npm run workflow:plan -- --ticket PRP-170 --title "..." --summary "..."

Options:
  --chat              Create Linear ticket from natural language (phase ①)
  --ticket PRP-###    Use existing ticket (skip create)
  --title / --summary Plan metadata (required with --ticket if no --chat)
  --image <path>      Captain screenshot (repeatable)
  --no-open           Skip opening Lavish in browser

Next: captain reviews plan → says "approved — build" → agent implements (phase ③)

See docs/share/proplane-collaborator-workflow.md`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (!args.chat && !args.ticket) {
    console.error("error: pass --chat (new ticket) or --ticket PRP-### (existing)");
    printHelp();
    process.exit(1);
  }

  let ticket = args.ticket?.trim().toUpperCase();
  let title = args.title;
  let summary = args.summary;

  if (args.chat) {
    console.log("① Creating Linear ticket…");
    const out = runNode("scripts/linear-file-ticket.mjs", ["--chat", args.chat]);
    const match = out.match(/(PRP-\d+)/);
    if (!match) throw new Error(`Could not parse ticket id from:\n${out}`);
    ticket = match[1];
    const line = out.split("\n").find((l) => l.includes("http"));
    console.log(out);
    if (!title) title = args.chat.slice(0, 120);
    if (!summary) summary = args.chat;
  } else {
    console.log(`① Verifying ${ticket}…`);
    const issue = await fetchIssue(ticket);
    if (!title) title = issue.title;
    if (!summary) summary = issue.description?.split("\n").slice(0, 8).join("\n") || issue.title;
    console.log(`   ${issue.url}`);
  }

  if (!title) {
    console.error("error: --title required when using --ticket without --chat");
    process.exit(1);
  }

  console.log("\n② Scaffolding Lavish plan…");
  const lavishArgs = [
    "--ticket",
    ticket,
    "--title",
    title,
    "--summary",
    summary ?? title,
  ];
  for (const img of args.images) lavishArgs.push("--image", img);
  if (args.open) lavishArgs.push("--open");

  const planOut = runNode("scripts/lavish-plan.mjs", lavishArgs);
  console.log(planOut);

  const planPath = planOut
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.endsWith("plan.html") && l.includes(".lavish"));
  if (!planPath || !existsSync(planPath)) {
    throw new Error("Could not find plan.html path in lavish output");
  }

  console.log("\n③ Linking plan on Linear ticket…");
  await appendIssueSection(
    ticket,
    "Lavish plan (review before build)",
    `Local path: \`${planPath}\`\n\nOpen: \`npx -y lavish-axi ${planPath}\`\nPoll: \`npx -y lavish-axi poll ${planPath}\`\n\n**Do not build until captain approves** (chat: \`approved — build\`).`,
  );

  console.log(`
✓ Workflow paused at plan review
  Ticket:  ${ticket}
  Plan:    ${planPath}
  Open:    npx -y lavish-axi ${planPath}
  Poll:    npx -y lavish-axi poll ${planPath}

Captain: annotate in Lavish or reply **approved — build** when ready.
Agent:   do NOT write product code until approval.
Agent:   MUST run poll before ending turn (Lavish shows "not listening" otherwise):
         npm run lavish:poll -- --plan ${planPath}`);
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
