#!/usr/bin/env node
/**
 * Batch-assign and prioritize open PropLane Linear issues (API key only).
 *
 *   npm run linear:triage
 *   npm run linear:triage -- --dry-run
 *
 * @see scripts/linear/triage-rules.mjs
 */

import { inferAssigneeId, inferPriority, triageReason } from "./linear/triage-rules.mjs";
import { linearGraphql, teamId } from "./linear/graphql.mjs";

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const data = await linearGraphql(
    `query($teamId: String!) {
      team(id: $teamId) {
        issues(first: 250, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
          nodes {
            id identifier title description priority
            assignee { id name }
            project { name }
            state { name type }
            labels { nodes { name } }
          }
        }
      }
    }`,
    { teamId: teamId() },
  );

  const issues = data.team.issues.nodes;
  const updates = [];

  for (const issue of issues) {
    const assigneeId = inferAssigneeId(issue);
    const priority = inferPriority(issue);
    const changed = issue.assignee?.id !== assigneeId || issue.priority !== priority;
    if (!changed) continue;
    updates.push({ issue, assigneeId, priority });
  }

  if (dryRun) {
    console.log(`dry-run: would update ${updates.length} of ${issues.length} open issues\n`);
    for (const { issue, assigneeId, priority } of updates) {
      console.log(
        `${issue.identifier}\tp${priority}\t${triageReason(issue)}`,
      );
    }
    return;
  }

  for (const { issue, assigneeId, priority } of updates) {
    await linearGraphql(
      `mutation($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      { id: issue.id, input: { assigneeId, priority } },
    );
    console.log(`updated ${issue.identifier} → priority ${priority} (${triageReason(issue)})`);
  }

  console.log(`\nlinear-triage: ${updates.length} updated, ${issues.length - updates.length} unchanged`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
