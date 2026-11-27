#!/usr/bin/env node
/**
 * Export an explicitly requested Linear issue to a chosen Markdown path.
 * npm run linear:export -- --ticket PRP-180 --out /tmp/PRP-180.md
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { linearGraphql } from "./linear/graphql.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== "--ticket" && flag !== "--out") {
      throw new Error(`Unknown argument ${flag}. Use --ticket <PRP-id> --out <path>.`);
    }
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    out[flag.slice(2)] = value;
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

function buildMarkdown(issue) {
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
    "- [ ] Out of scope is explicit",
    "- [ ] Test plan is realistic",
    "- [ ] Verification evidence and remaining limitations recorded",
    "",
    "_Exported from PropLane `npm run linear:export`._",
    "",
  );
  return lines.join("\n");
}

function printHelp() {
  console.log(`linear:export — write a shareable Markdown snapshot of a Linear issue

  npm run linear:export -- --ticket PRP-180 --out /tmp/PRP-180.md
  npm run linear:export -- --ticket PRP-180 --out ./ticket.md

Both --ticket and --out are required. Relative paths resolve from the repo root.
Requires LINEAR_API_KEY in .env.local`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (args.help || !args.ticket || !args.out) {
    printHelp();
    process.exit(args.help ? 0 : 2);
  }

  const issue = await fetchIssue(args.ticket);
  const outPath = resolve(REPO_ROOT, args.out);
  mkdirSync(dirname(outPath), { recursive: true });

  const md = buildMarkdown(issue);
  writeFileSync(outPath, md, "utf8");

  console.log(outPath);
  console.log(`Exported ${issue.identifier} → ${outPath}`);
  console.log(`Linear: ${issue.url}`);
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
