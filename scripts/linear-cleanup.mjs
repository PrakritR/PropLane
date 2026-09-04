#!/usr/bin/env node
/**
 * Cancel duplicate / empty-stub Linear issues and optionally mark shipped work Done.
 *
 *   node scripts/linear-cleanup.mjs --dry-run
 *   node scripts/linear-cleanup.mjs
 *
 * @see docs/linear-ticket-system.md → Monthly hygiene
 */

import { linearGraphql, teamId } from "./linear/graphql.mjs";

const dryRun = process.argv.includes("--dry-run");

/** @type {Array<{ id: string, canonical: string, reason: string }>} */
const DUPLICATE_OF = [
  { id: "PRP-286", canonical: "PRP-297", reason: "Empty stub — WO-number SMS already tracked on PRP-297." },
  { id: "PRP-287", canonical: "PRP-271", reason: "Empty stub — vendor SMS loop covered by PRP-271." },
  { id: "PRP-288", canonical: "PRP-265", reason: "Empty stub — resident SMS maintenance covered by PRP-265." },
  { id: "PRP-289", canonical: "PRP-267", reason: "Empty stub — manager digest covered by PRP-267." },
  { id: "PRP-290", canonical: "PRP-272", reason: "Empty stub — agent eval harness covered by PRP-272." },
  { id: "PRP-291", canonical: "PRP-275", reason: "Empty stub — platform pay-in covered by PRP-275." },
  { id: "PRP-292", canonical: "PRP-276", reason: "Empty stub — vendor payout covered by PRP-276." },
  { id: "PRP-293", canonical: "PRP-277", reason: "Empty stub — admin fee controls covered by PRP-277." },
  { id: "PRP-294", canonical: "PRP-279", reason: "Empty stub — action event bus covered by PRP-279." },
  { id: "PRP-295", canonical: "PRP-281", reason: "Empty stub — unit economics covered by PRP-281." },
  { id: "PRP-260", canonical: "PRP-264", reason: "Overlapping epic — canonical text-first ops is PRP-264." },
  { id: "PRP-284", canonical: "PRP-264", reason: "Overlapping epic — duplicate of PRP-264." },
];

/** Issues shipped or superseded — mark Done with note. */
const MARK_DONE = [
  {
    id: "PRP-229",
    note: "Inbox compose recipients now group by house with Manager/Vendor/Admin sections (shipped cursor-2 → prakrit).",
  },
];

async function resolveStateId(name) {
  const data = await linearGraphql(
    `query($teamId: String!) {
      team(id: $teamId) { states { nodes { id name type } } }
    }`,
    { teamId: teamId() },
  );
  const state = data.team.states.nodes.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (!state) throw new Error(`State not found: ${name}`);
  return state.id;
}

async function resolveIssue(ref) {
  const num = Number(ref.replace(/^PRP-/i, ""));
  const data = await linearGraphql(
    `query($filter: IssueFilter) {
      issues(filter: $filter, first: 1) {
        nodes { id identifier title state { name type } }
      }
    }`,
    { filter: { team: { key: { eq: "PRP" } }, number: { eq: num } } },
  );
  const node = data.issues.nodes[0];
  if (!node) throw new Error(`Issue not found: ${ref}`);
  return node;
}

async function markDuplicate(issue, canonical, reason, canceledStateId) {
  if (issue.state.type === "canceled" || issue.state.name === "Duplicate") {
    console.log(`skip ${issue.identifier} (already ${issue.state.name})`);
    return;
  }
  if (dryRun) {
    console.log(`dry-run: ${issue.identifier} → Canceled (dup ${canonical}) — ${reason}`);
    return;
  }
  await linearGraphql(
    `mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    { id: issue.id, input: { stateId: canceledStateId } },
  );
  await linearGraphql(
    `mutation($input: CommentCreateInput!) {
      commentCreate(input: $input) { success }
    }`,
    {
      input: {
        issueId: issue.id,
        body: `Duplicate of **${canonical}**. ${reason}`,
      },
    },
  );
  console.log(`canceled ${issue.identifier} (dup ${canonical})`);
}

async function markDone(issue, note, doneStateId) {
  if (issue.state.type === "completed") {
    console.log(`skip ${issue.identifier} (already Done)`);
    return;
  }
  if (dryRun) {
    console.log(`dry-run: ${issue.identifier} → Done — ${note}`);
    return;
  }
  await linearGraphql(
    `mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    { id: issue.id, input: { stateId: doneStateId } },
  );
  await linearGraphql(
    `mutation($input: CommentCreateInput!) {
      commentCreate(input: $input) { success }
    }`,
    { input: { issueId: issue.id, body: note } },
  );
  console.log(`done ${issue.identifier}`);
}

async function main() {
  const [canceledStateId, doneStateId] = await Promise.all([
    resolveStateId("Canceled"),
    resolveStateId("Done"),
  ]);

  console.log(dryRun ? "=== dry-run ===" : "=== applying ===");

  for (const row of DUPLICATE_OF) {
    const issue = await resolveIssue(row.id);
    await markDuplicate(issue, row.canonical, row.reason, canceledStateId);
  }

  for (const row of MARK_DONE) {
    const issue = await resolveIssue(row.id);
    await markDone(issue, row.note, doneStateId);
  }

  console.log(`\nlinear-cleanup: ${DUPLICATE_OF.length} canceled (duplicate), ${MARK_DONE.length} done`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
