#!/usr/bin/env node
/**
 * PRP-182: every agent host must see the SAME MCP servers.
 *
 * `.mcp.json` at the repo root is canonical — Claude Code reads it. Cursor
 * reads `.cursor/mcp.json` and cannot be pointed at another path, so the two
 * files are kept byte-identical and this script is what enforces it. Codex is
 * configured per-machine from the same list (see docs/agent-mcp-setup.md);
 * nothing in a repo file can check that, so the doc carries it.
 *
 * Why this exists rather than a comment asking people to remember: which agent
 * picks up a ticket already decides which lane it runs in, and before this the
 * config decided whether that lane could drive a browser or query the dev
 * database at all. A silent difference between the two files puts that back.
 *
 * Run: npm run check:mcp
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL = ".mcp.json";
const MIRROR = ".cursor/mcp.json";

/** The dev/test Supabase project. Production is a SEPARATE project and must never appear here. */
const DEV_PROJECT_REF = "emstjswhotsnyksqhqyf";

function read(rel) {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch {
    fail(`${rel} is missing. Both files must exist — see docs/agent-mcp-setup.md.`);
  }
}

const problems = [];
function fail(msg) {
  problems.push(msg);
}

const canonicalText = read(CANONICAL);
const mirrorText = read(MIRROR);

if (canonicalText !== mirrorText) {
  fail(
    `${CANONICAL} and ${MIRROR} differ. They must be byte-identical.\n` +
      `  Fix: cp ${CANONICAL} ${MIRROR}   (edit ${CANONICAL} first — it is canonical)`,
  );
}

let parsed;
try {
  parsed = JSON.parse(canonicalText);
} catch (e) {
  fail(`${CANONICAL} is not valid JSON: ${e.message}`);
}

if (parsed) {
  const servers = parsed.mcpServers ?? {};
  const names = Object.keys(servers);
  for (const required of ["supabase", "playwright", "chrome-devtools", "browser-use", "linear"]) {
    if (!names.includes(required)) fail(`${CANONICAL} is missing the "${required}" server.`);
  }

  // The one thing here that could do real damage. The standing rule is that
  // nothing an agent runs may write production data, and this server has writes
  // enabled — so the project ref is checked, not trusted.
  const supabaseUrl = String(servers.supabase?.url ?? "");
  if (supabaseUrl && !supabaseUrl.includes(`project_ref=${DEV_PROJECT_REF}`)) {
    fail(
      `The supabase server does not point at the dev project (${DEV_PROJECT_REF}).\n` +
        `  It has writes enabled, so a different ref here would let an agent write that project.\n` +
        `  Got: ${supabaseUrl}`,
    );
  }

  // A sandbox port that is not allow-listed fails as a permission error which
  // reads like a broken test rather than a config gap — that is how the list
  // silently fell behind at 3011 while lanes ran on 3012+.
  const playwrightArgs = servers.playwright?.args ?? [];
  const originsArg = playwrightArgs.find((a) => String(a).startsWith("--allowed-origins="));
  if (!originsArg) {
    fail("The playwright server has no --allowed-origins; browser checks will be refused.");
  } else {
    const origins = originsArg.slice("--allowed-origins=".length).split(";");
    for (let port = 3000; port <= 3014; port += 1) {
      for (const host of ["localhost", "127.0.0.1"]) {
        const origin = `http://${host}:${port}`;
        if (!origins.includes(origin)) fail(`playwright --allowed-origins is missing ${origin}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error("MCP config check FAILED:\n");
  for (const p of problems) console.error(`  • ${p}\n`);
  process.exit(1);
}

console.log("MCP config OK — root and Cursor agree, dev project pinned, sandbox ports 3000-3014 allowed.");
