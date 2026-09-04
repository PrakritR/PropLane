/**
 * Patch a Linear issue description (append-only block) via GraphQL.
 */
import { linearGraphql } from "./graphql.mjs";

export async function fetchIssue(identifier) {
  const num = Number(String(identifier).replace(/^PRP-/i, ""));
  const data = await linearGraphql(
    `query($filter: IssueFilter) {
      issues(filter: $filter, first: 1) {
        nodes { id identifier title description url }
      }
    }`,
    { filter: { team: { key: { eq: "PRP" } }, number: { eq: num } } },
  );
  const issue = data.issues.nodes[0];
  if (!issue) throw new Error(`Issue not found: ${identifier}`);
  return issue;
}

export async function appendIssueSection(identifier, heading, body) {
  const issue = await fetchIssue(identifier);
  const block = `\n\n## ${heading}\n${body.trim()}\n`;
  const description = (issue.description ?? "").includes(heading)
    ? issue.description
    : `${issue.description ?? ""}${block}`.trim();
  await linearGraphql(
    `mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    { id: issue.id, input: { description } },
  );
  return issue;
}
