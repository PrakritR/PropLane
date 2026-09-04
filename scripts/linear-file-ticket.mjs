#!/usr/bin/env node
/**
 * File a PropLane Linear ticket from structured flags or natural-language chat.
 *
 * Prefers LINEAR_API_KEY (GraphQL). Falls back to `cursor agent` + Linear MCP.
 *
 * Usage:
 *   npm run linear:ticket -- --title "..." --body "..." --project "02 — Manager Portal"
 *   npm run linear:ticket -- --chat "Residents tab crashes when I click payments"
 *   echo "bug: calendar UI is ugly" | npm run linear:ticket -- --chat -
 *
 * Env: LINEAR_API_KEY (optional), LINEAR_TEAM_ID (optional override)
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildDescription, formatTitle, inferRoute, TEAM_NAME } from "./linear/ticket-routing.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const DEFAULT_TEAM_ID = "2b9b00db-7ef6-4cd7-bce5-86899ad72d15";

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
  console.log(`PropLane Linear ticket filer

  npm run linear:ticket -- --chat "natural language description"
  npm run linear:ticket -- --title "[Area] Summary" --project "02 — Manager Portal" --milestone Residents

Options:
  --chat <text|->     Natural language (use - for stdin)
  --title             Issue title
  --body              Markdown body (optional; auto-generated from --chat)
  --project           Numbered project folder name
  --milestone         Sub-folder milestone inside project
  --label / --labels  Linear labels (comma-separated)
  --priority 0-4      0=none 1=urgent 2=high 3=medium 4=low
  --state             Backlog | Todo (default Backlog)
  --parent PRP-123    Parent epic
  --dry-run           Print payload, do not create

Requires LINEAR_API_KEY or \`cursor agent mcp login linear\`.
See docs/linear-ticket-system.md`);
}

async function linearGraphql(apiKey, query, variables = {}) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors?.length) {
    throw new Error(json.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`);
  }
  return json.data;
}

async function resolveProjectId(apiKey, projectName) {
  const data = await linearGraphql(
    apiKey,
    `query($filter: ProjectFilter) {
      projects(filter: $filter, first: 5) { nodes { id name } }
    }`,
    { filter: { name: { eq: projectName } } },
  );
  const node = data.projects.nodes[0];
  if (!node) throw new Error(`Project not found: ${projectName}`);
  return node.id;
}

async function resolveLabelIds(apiKey, teamId, names) {
  if (!names.length) return [];
  const data = await linearGraphql(
    apiKey,
    `query($teamId: String!) {
      team(id: $teamId) { labels { nodes { id name } } }
    }`,
    { teamId },
  );
  const byName = new Map(data.team.labels.nodes.map((n) => [n.name.toLowerCase(), n.id]));
  const ids = [];
  for (const name of names) {
    const id = byName.get(name.toLowerCase());
    if (id) ids.push(id);
    else console.warn(`warn: label not found: ${name}`);
  }
  return ids;
}

async function resolveStateId(apiKey, teamId, stateName) {
  const data = await linearGraphql(
    apiKey,
    `query($teamId: String!) {
      team(id: $teamId) { states { nodes { id name type } } }
    }`,
    { teamId },
  );
  const state = data.team.states.nodes.find(
    (s) => s.name.toLowerCase() === stateName.toLowerCase(),
  );
  if (!state) throw new Error(`State not found: ${stateName}`);
  return state.id;
}

async function createViaApi(payload) {
  const apiKey = process.env.LINEAR_API_KEY?.trim();
  if (!apiKey) return null;

  const teamId = process.env.LINEAR_TEAM_ID?.trim() || DEFAULT_TEAM_ID;
  const input = {
    teamId,
    title: payload.title,
    description: payload.description,
    priority: payload.priority ?? 0,
  };

  if (payload.project) input.projectId = await resolveProjectId(apiKey, payload.project);
  const labelIds = await resolveLabelIds(apiKey, teamId, payload.labels ?? []);
  if (labelIds.length) input.labelIds = labelIds;
  if (payload.state) input.stateId = await resolveStateId(apiKey, teamId, payload.state);
  if (payload.parentId) input.parentId = payload.parentId;

  const data = await linearGraphql(
    apiKey,
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

function createViaCursorAgent(payload) {
  const labelsJson = JSON.stringify(payload.labels ?? []);
  const prompt = [
    "Use Linear MCP save_issue to CREATE one issue (do not update).",
    `team: ${TEAM_NAME}`,
    `title: ${payload.title}`,
    `description: ${payload.description}`,
    payload.project ? `project: ${payload.project}` : "",
    payload.milestone ? `milestone: ${payload.milestone}` : "",
    `state: ${payload.state ?? "Backlog"}`,
    payload.priority != null ? `priority: ${payload.priority}` : "",
    `labels: ${labelsJson}`,
    payload.parentId ? `parentId: ${payload.parentId}` : "",
    "Reply with ONLY the new issue identifier (PRP-###) and URL on one line.",
  ]
    .filter(Boolean)
    .join("\n");

  const out = execFileSync("cursor", ["agent", "--approve-mcps", "--print", prompt], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  const match = out.match(/(PRP-\d+)[^\n]*?(https:\/\/linear\.app\/\S+)/i);
  if (match) return { identifier: match[1], url: match[2], title: payload.title };
  return { identifier: "(see agent output)", url: "", title: payload.title, raw: out.trim() };
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

  return {
    title,
    description,
    project: args.project || route.project,
    milestone: args.milestone || route.milestone,
    labels: [...new Set([...(args.labels || []), ...(route.labels || [])])],
    priority: args.priority,
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

  let issue;
  try {
    issue = await createViaApi(payload);
  } catch (e) {
    console.warn(`api: ${e.message} — falling back to cursor agent`);
  }

  if (!issue) {
    try {
      issue = createViaCursorAgent(payload);
    } catch (e) {
      console.error("error: could not create ticket. Set LINEAR_API_KEY or run: cursor agent mcp login linear");
      console.error(e.message);
      process.exit(1);
    }
  }

  console.log(`Created ${issue.identifier}: ${issue.title}`);
  if (issue.url) console.log(issue.url);
  if (issue.raw) console.log(issue.raw);
}

main();
