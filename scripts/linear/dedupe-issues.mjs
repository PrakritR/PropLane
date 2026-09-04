/**
 * Dedupe new QA findings against open Linear issues.
 */
import { linearGraphql } from "./graphql.mjs";

let _cache;

export async function loadOpenIssueTitles() {
  if (_cache) return _cache;
  const data = await linearGraphql(
    `query {
      issues(filter: { state: { type: { nin: ["completed", "canceled"] } } }, first: 150) {
        nodes { identifier title description }
      }
    }`,
  );
  _cache = data.issues.nodes;
  return _cache;
}

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\[.*?\]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenSet(s) {
  return new Set(normalize(s).split(/\s+/).filter((w) => w.length > 3));
}

function overlapScore(a, b) {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

/** @returns {{ duplicate: boolean, match?: string }} */
export function isDuplicateFinding(finding, openIssues) {
  const title = finding.title || "";
  const text = `${title} ${finding.detail || ""}`;
  for (const issue of openIssues) {
    const combined = `${issue.title} ${issue.description || ""}`;
    const score = overlapScore(text, combined);
    if (score >= 0.55) return { duplicate: true, match: issue.identifier };
    // explicit keyword hooks
    const hooks = [
      [/vendor.*calendar.*403/i, /vendor.*calendar|403.*vendor/i],
      [/applications pending.*blank|empty state.*application/i, /applications pending|blank.*pending/i],
      [/zero properties|no seeded rows|listed tab empty/i, /zero properties|listed tab|seeded manager/i],
      [/add property.*dead|plan limit/i, /add property.*dead|plan limit/i],
      [/vendor.*403/i, /vendor.*calendar.*403/i],
    ];
    for (const [a, b] of hooks) {
      if (a.test(text) && b.test(combined)) return { duplicate: true, match: issue.identifier };
    }
  }
  return { duplicate: false };
}
