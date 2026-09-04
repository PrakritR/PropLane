#!/usr/bin/env node
/**
 * File QA findings to Linear with screenshot embeds. Skips duplicates vs open PRP titles.
 * Usage: node scripts/qa-file-findings-to-linear.mjs .lavish/qa-screenshots-2026-09-04/findings.json
 */
import { readFileSync, existsSync } from "node:fs";
import { uploadLinearImage } from "./qa-linear-upload-image.mjs";
import { linearGraphql, resolveLabelIds, resolveProjectId, resolveStateId, teamId } from "./linear/graphql.mjs";
import { resolveIssueId } from "./linear/graphql.mjs";

const findingsPath = process.argv[2];
if (!findingsPath || !existsSync(findingsPath)) {
  console.error("Usage: node scripts/qa-file-findings-to-linear.mjs <findings.json>");
  process.exit(1);
}

const findings = JSON.parse(readFileSync(findingsPath, "utf8"));

const PROJECT_BY_ROLE = {
  manager: "02 — Manager Portal",
  resident: "03 — Resident Portal",
  vendor: "04 — Vendor Portal",
  admin: "05 — Admin Portal",
  public: "12 — Marketing & Growth",
};

function norm(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

function isDuplicate(title, openTitles) {
  const t = norm(title);
  for (const o of openTitles) {
    const n = norm(o);
    if (t.includes(n.slice(0, 40)) || n.includes(t.slice(0, 40))) return true;
    const words = t.split(" ").filter((w) => w.length > 4);
    const hits = words.filter((w) => n.includes(w));
    if (hits.length >= 3) return true;
  }
  return false;
}

async function fetchOpenTitles() {
  const titles = [];
  let cursor = null;
  for (let i = 0; i < 6; i++) {
    const data = await linearGraphql(
      `query($after: String) {
        issues(filter: { team: { key: { eq: "PRP" } }, state: { type: { nin: ["completed", "canceled"] } } }, first: 50, after: $after) {
          nodes { title }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { after: cursor },
    );
    titles.push(...data.issues.nodes.map((n) => n.title));
    if (!data.issues.pageInfo.hasNextPage) break;
    cursor = data.issues.pageInfo.endCursor;
  }
  return titles;
}

async function createIssue({ title, description, project, labels, priority, parentId }) {
  const input = {
    teamId: teamId(),
    title,
    description,
    priority: priority ?? 3,
    projectId: await resolveProjectId(project),
    stateId: await resolveStateId("Backlog"),
    labelIds: await resolveLabelIds(labels),
    parentId: parentId ? await resolveIssueId(parentId) : undefined,
  };
  const data = await linearGraphql(
    `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { identifier title url } }
    }`,
    { input },
  );
  return data.issueCreate.issue;
}

const openTitles = await fetchOpenTitles();
const parentId = "PRP-171";
const created = [];
const skipped = [];

for (const f of findings) {
  const title = `[${f.role}] ${f.label}: ${f.summary.slice(0, 80)}`;
  if (isDuplicate(title, openTitles)) {
    skipped.push({ title, reason: "duplicate" });
    continue;
  }

  let imageMd = "";
  if (f.screenshot && existsSync(f.screenshot)) {
    try {
      const assetUrl = await uploadLinearImage(f.screenshot);
      imageMd = `\n\n![QA screenshot](${assetUrl})\n`;
    } catch (e) {
      imageMd = `\n\n_Screenshot upload failed: ${e.message}_\n`;
    }
  }

  const description = `## Summary
${f.summary}

## Route
\`${f.path}\`${f.finalUrl ? ` → landed \`${f.finalUrl}\`` : ""}

## Viewport
${f.viewport ?? "desktop"}

## Kind
${f.kind} · severity **${f.severity}**

## Reference UI
Property/manager portal is the design reference — resident/vendor/admin should match list density, header hierarchy, and portal chrome.

## Agent
agent:cursor-2 · QA sweep 2026-09-04
${imageMd}`;

  const labels = [
    f.kind === "runtime" ? "Bug" : f.kind === "ui" ? "Improvement" : "Improvement",
    `portal:${f.role === "manager" ? "manager" : f.role}`,
  ].filter(Boolean);

  try {
    const issue = await createIssue({
      title: title.slice(0, 240),
      description,
      project: PROJECT_BY_ROLE[f.role] ?? "01 — Infrastructure & Ops",
      labels,
      priority: f.severity === "high" ? 2 : 3,
      parentId,
    });
    created.push(issue);
    openTitles.push(title);
    console.log(`Created ${issue.identifier}: ${issue.title}`);
    console.log(issue.url);
  } catch (e) {
    console.error(`Failed: ${title} — ${e.message}`);
  }
}

console.log(`\nCreated ${created.length}, skipped ${skipped.length} duplicates`);
if (skipped.length) console.log("Skipped:", skipped.map((s) => s.title.slice(0, 60)).join("\n"));
