#!/usr/bin/env node
/**
 * Export a Linear issue to a shareable Markdown file (for captain / friends).
 *
 *   npm run linear:export -- --ticket PRP-180
 *   npm run linear:export -- --ticket PRP-180 --out .lavish/plans/PRP-180-prefill/ticket.md
 *
 * Default: `.lavish/tickets/<PRP-###>.md`
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { linearGraphql } from "./linear/graphql.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--ticket") out.ticket = next();
    else if (a === "--out") out.out = next();
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function issueNumber(ref) {
  const n = Number(String(ref).replace(/^PRP-/i, ""));
  if (!Number.isFinite(n)) throw new Error(`Invalid ticket ref: ${ref}`);
  return n;
}

async function fetchIssue(ref) {
  const number = issueNumber(ref);
  const data = await linearGraphql(
    `query($filter: IssueFilter) {
      issues(filter: $filter, first: 1) {
        nodes {
          identifier title description url priority
          createdAt updatedAt
          state { name type }
          assignee { name }
          project { name }
          projectMilestone { name }
          labels { nodes { name } }
          parent { identifier title }
        }
      }
    }`,
    { filter: { team: { key: { eq: "PRP" } }, number: { eq: number } } },
  );
  const issue = data.issues.nodes[0];
  if (!issue) throw new Error(`Issue not found: ${ref}`);
  return issue;
}

const PRIORITY = ["None", "Urgent", "High", "Medium", "Low"];

function buildMarkdown(issue, { planPath }) {
  const labels = issue.labels.nodes.map((l) => l.name).join(", ") || "_none_";
  const lines = [
    `# ${issue.identifier}: ${issue.title}`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| **URL** | ${issue.url} |`,
    `| **State** | ${issue.state.name} |`,
    `| **Priority** | ${PRIORITY[issue.priority] ?? issue.priority} |`,
    `| **Assignee** | ${issue.assignee?.name ?? "_unassigned_"} |`,
    `| **Project** | ${issue.project?.name ?? "_none_"} |`,
    `| **Milestone** | ${issue.projectMilestone?.name ?? "_none_"} |`,
    `| **Labels** | ${labels} |`,
    `| **Parent** | ${issue.parent ? `${issue.parent.identifier} — ${issue.parent.title}` : "_none_"} |`,
    `| **Updated** | ${issue.updatedAt} |`,
  ];
  if (planPath) {
    lines.push(`| **Lavish plan** | \`${planPath}\` |`);
  }
  lines.push(
    "",
    "---",
    "",
    "## Description",
    "",
    issue.description?.trim() || "_No description in Linear._",
    "",
    "---",
    "",
    "## Review checklist (captain)",
    "",
    "- [ ] Scope matches the problem",
    "- [ ] Lavish plan reviewed (`plan.html`)",
    "- [ ] Out of scope is explicit",
    "- [ ] Test plan is realistic",
    "- [ ] **Approved — build** (or feedback queued in Lavish)",
    "",
    "## Share",
    "",
    "Send this file + Lavish plan link to a reviewer:",
    "",
    "```bash",
    "npx -y lavish-axi share .lavish/plans/<folder>/plan.html",
    "```",
    "",
    "_Exported from PropLane `npm run linear:export`._",
    "",
  );
  return lines.join("\n");
}

function defaultOutPath(ticket) {
  const id = ticket.toUpperCase().replace(/^PRP-/, "PRP-");
  return join(REPO_ROOT, ".lavish", "tickets", `${id}.md`);
}

function printHelp() {
  console.log(`linear:export — write a shareable Markdown snapshot of a Linear issue

  npm run linear:export -- --ticket PRP-180
  npm run linear:export -- --ticket PRP-180 --out .lavish/plans/PRP-180-slug/ticket.md

Requires LINEAR_API_KEY in .env.local`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.ticket) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const issue = await fetchIssue(args.ticket);
  const outPath = args.out ? join(REPO_ROOT, args.out) : defaultOutPath(issue.identifier);
  mkdirSync(dirname(outPath), { recursive: true });

  const relPlan = `.lavish/plans/${issue.identifier.toLowerCase()}-*/plan.html`;
  const md = buildMarkdown(issue, { planPath: relPlan });
  writeFileSync(outPath, md, "utf8");

  console.log(outPath);
  console.log(`Exported ${issue.identifier} → ${outPath}`);
  console.log(`Linear: ${issue.url}`);
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
