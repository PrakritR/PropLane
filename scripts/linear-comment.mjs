#!/usr/bin/env node
/**
 * Post a Linear comment without changing issue status.
 *
 * Agents must NEVER mark issues Done on a lane commit. Use this after a fix:
 *
 *   npm run linear:comment -- --ticket PRP-123 --body "Fix on cursor-1: \`abc1234\`"
 *   npm run linear:comment -- --ticket PRP-123 --sha abc1234 --lane cursor-1
 *
 * Requires LINEAR_API_KEY in .env.local (GraphQL only — no MCP).
 *
 * @see docs/linear-ticket-system.md → Status workflow
 */

import { fetchIssue } from "./linear/update-issue.mjs";
import { linearGraphql } from "./linear/graphql.mjs";

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--ticket" || a === "--issue") out.ticket = next();
    else if (a === "--body" || a === "--comment") out.body = next();
    else if (a === "--sha") out.sha = next();
    else if (a === "--lane") out.lane = next();
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}

function buildBody(args) {
  if (args.body?.trim()) return args.body.trim();
  if (args.sha?.trim()) {
    const lane = args.lane?.trim() || "agent lane";
    return `Fix committed on \`${lane}\`: \`${args.sha.trim()}\`.\n\nNot Done — awaiting captain promote to production.`;
  }
  throw new Error("Provide --body or --sha");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.ticket) {
    console.log(`Usage:
  npm run linear:comment -- --ticket PRP-### --body "…"
  npm run linear:comment -- --ticket PRP-### --sha <commit> [--lane cursor-1]
  npm run linear:comment -- --ticket PRP-### --sha <commit> --dry-run`);
    process.exit(args.help || !args.ticket ? 0 : 1);
  }

  const body = buildBody(args);
  const issue = await fetchIssue(args.ticket);

  if (args.dryRun) {
    console.log(`dry-run: comment on ${issue.identifier} (${issue.url})\n---\n${body}\n---`);
    return;
  }

  await linearGraphql(
    `mutation($input: CommentCreateInput!) {
      commentCreate(input: $input) { success comment { id url } }
    }`,
    { input: { issueId: issue.id, body } },
  );

  console.log(`commented ${issue.identifier}: ${issue.url}`);
  console.log("(status unchanged — do not mark Done until live on production)");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
