/**
 * Linear GraphQL helpers (API key only — no MCP).
 */

import { requireLinearApiKey } from "./load-env.mjs";

export const DEFAULT_TEAM_ID = "2b9b00db-7ef6-4cd7-bce5-86899ad72d15";

export async function linearGraphql(query, variables = {}) {
  const apiKey = requireLinearApiKey();
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

export function teamId() {
  return process.env.LINEAR_TEAM_ID?.trim() || DEFAULT_TEAM_ID;
}

export async function resolveProjectId(projectName) {
  const data = await linearGraphql(
    `query($filter: ProjectFilter) {
      projects(filter: $filter, first: 5) { nodes { id name } }
    }`,
    { filter: { name: { eq: projectName } } },
  );
  const node = data.projects.nodes[0];
  if (!node) throw new Error(`Project not found: ${projectName}`);
  return node.id;
}

export async function resolveProjectMilestoneId(projectId, milestoneName) {
  if (!milestoneName?.trim()) return null;
  const data = await linearGraphql(
    `query($projectId: String!) {
      project(id: $projectId) {
        projectMilestones { nodes { id name } }
      }
    }`,
    { projectId },
  );
  const milestone = data.project?.projectMilestones?.nodes?.find(
    (m) => m.name.toLowerCase() === milestoneName.trim().toLowerCase(),
  );
  if (!milestone) {
    console.warn(`warn: milestone not found on project: ${milestoneName}`);
    return null;
  }
  return milestone.id;
}

export async function resolveLabelIds(names) {
  if (!names.length) return [];
  const data = await linearGraphql(
    `query($teamId: String!) {
      team(id: $teamId) { labels { nodes { id name } } }
    }`,
    { teamId: teamId() },
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

export async function resolveStateId(stateName) {
  const data = await linearGraphql(
    `query($teamId: String!) {
      team(id: $teamId) { states { nodes { id name type } } }
    }`,
    { teamId: teamId() },
  );
  const state = data.team.states.nodes.find(
    (s) => s.name.toLowerCase() === stateName.toLowerCase(),
  );
  if (!state) throw new Error(`State not found: ${stateName}`);
  return state.id;
}

export async function resolveIssueId(parentRef) {
  const ref = parentRef.trim();
  const data = await linearGraphql(
    `query($filter: IssueFilter) {
      issues(filter: $filter, first: 1) { nodes { id identifier } }
    }`,
    { filter: { team: { key: { eq: "PRP" } }, number: { eq: Number(ref.replace(/^PRP-/i, "")) } } },
  );
  const node = data.issues.nodes[0];
  if (!node) throw new Error(`Parent issue not found: ${ref}`);
  return node.id;
}
