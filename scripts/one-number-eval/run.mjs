#!/usr/bin/env node
/**
 * One-number eval runner.
 *
 *   npm run eval:one-number                       grade every fixture's hand-written `gold` reply (offline).
 *   npm run eval:one-number -- --replies out.json grade recorded replies: [{ id, reply, toolTrace? }].
 *   npm run eval:one-number -- --live             replay each case through the agent turn.
 *
 * Live mode posts to the dev server's SMS test transport (`/api/agent/sms-test`, no real sends):
 *   EVAL_BASE_URL   e.g. http://localhost:3013
 *   EVAL_COOKIE     the signed-in test manager's Cookie header (dev/test workspace only)
 *   EVAL_LISTING_ID the target listing for prospect and resident cases
 * Manager and resident cases replay through the `manager` and `resident` portals; the SMS test
 * route has no vendor or prospect-only surface, so live mode skips vendor cases and says so.
 *
 * Exit code: 0 when every graded case passes, 1 when any fails, 2 on bad input.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCase } from "./cases.mjs";
import { gradeCase, summarize } from "./grader.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export function loadFixtures(dir = join(here, "fixtures")) {
  const cases = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
    for (const c of Array.isArray(parsed) ? parsed : [parsed]) cases.push(c);
  }
  return cases;
}

function parseArgs(argv) {
  const out = { live: false, replies: null, dir: null, role: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--live") out.live = true;
    else if (a === "--replies") out.replies = argv[++i];
    else if (a === "--dir") out.dir = argv[++i];
    else if (a === "--role") out.role = argv[++i];
  }
  return out;
}

async function liveReply(testCase, env) {
  const portal = testCase.role === "manager" ? "manager" : "resident";
  const url = `${env.base}/api/agent/sms-test?portal=${portal}&targetListingId=${encodeURIComponent(portal === "manager" ? "" : env.listing)}`;
  let sessionId = null;
  let last = null;
  for (const text of testCase.turns) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: env.cookie },
      body: JSON.stringify({ messages: [{ role: "user", content: text }], ...(sessionId ? { sessionId } : {}) }),
    });
    if (!res.ok) throw new Error(`sms-test ${res.status}`);
    last = await res.json();
    sessionId = last.sessionId ?? sessionId;
  }
  return { reply: String(last?.reply ?? ""), toolTrace: last?.toolTrace ?? [] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const all = loadFixtures(args.dir ?? undefined);
  const bad = all.map((c) => ({ id: c?.id, problems: validateCase(c) })).filter((r) => r.problems.length);
  if (bad.length) {
    console.error("Invalid fixtures:", JSON.stringify(bad));
    process.exit(2);
  }
  const cases = args.role ? all.filter((c) => c.role === args.role) : all;

  const recorded = args.replies ? new Map(JSON.parse(readFileSync(args.replies, "utf8")).map((r) => [r.id, r])) : null;
  const env = { base: process.env.EVAL_BASE_URL, cookie: process.env.EVAL_COOKIE, listing: process.env.EVAL_LISTING_ID };
  if (args.live && (!env.base || !env.cookie)) {
    console.error("Live mode needs EVAL_BASE_URL and EVAL_COOKIE (dev/test workspace only).");
    process.exit(2);
  }

  const results = [];
  const skipped = [];
  for (const testCase of cases) {
    let produced;
    if (recorded) {
      produced = recorded.get(testCase.id);
      if (!produced) {
        skipped.push(testCase.id);
        continue;
      }
    } else if (args.live) {
      if (testCase.role === "vendor") {
        skipped.push(testCase.id);
        continue;
      }
      try {
        produced = await liveReply(testCase, env);
      } catch (error) {
        results.push({ id: testCase.id, role: testCase.role, pass: false, checks: [{ name: "replay", pass: false, detail: String(error?.message ?? error) }] });
        continue;
      }
    } else {
      produced = { reply: testCase.gold ?? "", toolTrace: [] };
    }
    results.push(gradeCase(testCase, produced));
  }

  for (const r of results.filter((x) => !x.pass)) {
    console.log(`FAIL ${r.id}: ${r.checks.filter((c) => !c.pass).map((c) => `${c.name} (${c.detail})`).join("; ")}`);
  }
  const summary = summarize(results);
  console.log(JSON.stringify({ mode: args.live ? "live" : recorded ? "recorded" : "gold", ...summary, skipped: skipped.length }));
  process.exit(summary.failed > 0 ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
