#!/usr/bin/env node
/**
 * File a PropLane Linear ticket from structured flags or natural-language chat.
 * Requires LINEAR_API_KEY in .env.local (GraphQL only — no MCP).
 *
 * Usage:
 *   npm run linear:ticket -- --title "..." --body "..." --project "02 — Manager Portal"
 *   npm run linear:ticket -- --chat "Residents tab crashes when I click payments"
 *
 * Env: LINEAR_API_KEY (required), LINEAR_TEAM_ID (optional override)
 */

import { readFileSync } from "node:fs";
import { buildDescription, formatTitle, inferRoute } from "./linear/ticket-routing.mjs";
import { inferAssigneeId, inferPriority } from "./linear/triage-rules.mjs";
import {
  linearGraphql,
  resolveIssueId,
  resolveLabelIds,
  resolveProjectId,
  resolveProjectMilestoneId,
  resolveStateId,
  teamId,
} from "./linear/graphql.mjs";

function parseArgs(argv) {
  const out = { labels: [], priority: null, state: "Backlog", dryRun: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--title") out.title = next();
    else if (a === "--body") out.body = next();
    else if (a === "--chat") out.chat = next();
    else if (a === "--project") out.project = next();
    else if (a === "--milestone") out.milestone = next();
    else if (a === "--label") out.labels.push(next());
    else if (a === "--labels") out.labels.push(...next().split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--priority") out.priority = Number(next());
    else if (a === "--state") out.state = next();
    else if (a === "--parent") out.parentId = next();
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else positional.push(a);
  }
  if (!out.title && positional.length) out.title = positional.join(" ");
  return out;
}

function printHelp() {
  console.log(`PropLane Linear ticket filer (API key only)

  npm run linear:ticket -- --chat "natural language description"
  npm run linear:ticket -- --title "[Area] Summary" --project "02 — Manager Portal" --milestone Residents

Options:
  --chat <text|->     Natural language (use - for stdin)
  --title             Issue title
  --body              Markdown body (optional; auto-generated from --chat)
  --project           Numbered project folder name
  --milestone         Sub-folder milestone inside project
  --label / --labels  Linear labels (comma-separated)
  --priority 0-4      0=none 1=urgent 2=high 3=medium 4=low (auto if omitted)
  --state             Backlog | Todo (default Backlog)
  --parent PRP-123    Parent epic
  --dry-run           Print payload, do not create

Requires LINEAR_API_KEY in .env.local — https://linear.app/settings/api
See docs/linear-ticket-system.md`);
}

async function createIssue(payload) {
  const input = {
    teamId: teamId(),
    title: payload.title,
    description: payload.description,
    priority: payload.priority ?? 0,
    assigneeId: payload.assigneeId,
  };

  let projectId = null;
  if (payload.project) {
    projectId = await resolveProjectId(payload.project);
    input.projectId = projectId;
  }
  if (payload.milestone && projectId) {
    const milestoneId = await resolveProjectMilestoneId(projectId, payload.milestone);
    if (milestoneId) input.projectMilestoneId = milestoneId;
  }

  const labelIds = await resolveLabelIds(payload.labels ?? []);
  if (labelIds.length) input.labelIds = labelIds;
  if (payload.state) input.stateId = await resolveStateId(payload.state);
  if (payload.parentId) {
    input.parentId = /^[a-f0-9-]{36}$/i.test(payload.parentId)
      ? payload.parentId
      : await resolveIssueId(payload.parentId);
  }

  const data = await linearGraphql(
    `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { identifier title url }
      }
    }`,
    { input },
  );

  if (!data.issueCreate.success) throw new Error("issueCreate failed");
  return data.issueCreate.issue;
}

function buildPayload(args) {
  let chatText = args.chat;
  if (chatText === "-") chatText = readFileSync(0, "utf8").trim();

  const route = inferRoute(chatText || args.title || "");
  const title = formatTitle(args.title || chatText || "Untitled ticket");
  const description =
    args.body ||
    buildDescription({
      userStory: chatText || title,
      current: chatText ? "_Reported in Cursor chat._" : undefined,
      expected: "_TBD — refine in Linear._",
      route,
      portalRoute: chatText?.match(/\/[\w/-]+/)?.[0],
      source: "npm run linear:ticket",
    });

  const projectName = args.project || route.project;
  const labelList = [...new Set([...(args.labels || []), ...(route.labels || [])])];

  const triageShape = {
    title,
    description,
    project: { name: projectName },
    labels: { nodes: labelList.map((name) => ({ name })) },
  };

  return {
    title,
    description,
    project: projectName,
    milestone: args.milestone || route.milestone,
    labels: labelList,
    priority: args.priority ?? inferPriority(triageShape),
    assigneeId: inferAssigneeId(triageShape),
    state: args.state,
    parentId: args.parentId,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (!args.title && !args.chat) {
    console.error("error: pass --title or --chat");
    printHelp();
    process.exit(1);
  }

  const payload = buildPayload(args);

  if (args.dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  try {
    const issue = await createIssue(payload);
    console.log(`Created ${issue.identifier}: ${issue.title}`);
    if (issue.url) console.log(issue.url);
    const slug = (issue.title || "plan")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48);
    const planDir = `.lavish/plans/${issue.identifier}-${slug}`;
    console.log("");
    console.log("Next steps (captain workflow):");
    console.log(`  1. npm run linear:export -- --ticket ${issue.identifier} --out ${planDir}/ticket.md`);
    console.log(
      `  2. npm run lavish:plan -- --ticket ${issue.identifier} --title "${issue.title.replace(/"/g, '\\"')}" --summary "…" --open`,
    );
    console.log(`  3. npx -y lavish-axi poll ${planDir}/plan.html`);
    console.log("  4. Captain: approved — build");
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

main();
