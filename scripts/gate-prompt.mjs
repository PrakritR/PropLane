#!/usr/bin/env node
/**
 * Lane workflow v2 test gate: run after every build, on every prompt.
 *
 * Computes "changed files" as the union of:
 *   - working-tree changes vs HEAD (`git diff --name-only HEAD`)
 *   - untracked files (`git ls-files --others --exclude-standard`)
 *   - commits on this branch not on the base ref (`git diff --name-only <base>...HEAD`)
 * default base ref: origin/prakrit (override with --base <ref>).
 *
 * Then runs, in order, ALWAYS ALL THREE even if an earlier one fails:
 *   1. `vitest related --run` for changed src/test files (skipped with a note
 *      when there are none) — restricted to the unit+integration test config's
 *      own `include` globs so `related` cannot invent test files outside it.
 *   2. `eslint` on changed .ts/.tsx/.js/.mjs files that still exist on disk
 *      (skipped with a note when there are none).
 *   3. `tsc --noEmit -p .` (whole project; skip with --skip-tsc).
 *
 * Prints one summary line per step with its real exit code, and exits
 * non-zero if any step failed. A skipped step is not a failure.
 *
 * Usage:
 *   npm run gate:prompt
 *   npm run gate:prompt -- --base origin/main
 *   npm run gate:prompt -- --skip-tsc
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

function parseArgs(argv) {
  const out = { base: "origin/prakrit", skipTsc: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") out.base = argv[++i];
    else if (a === "--skip-tsc") out.skipTsc = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    ...opts,
  });
}

function gitLines(args) {
  const res = sh("git", args);
  if (res.status !== 0) {
    return { ok: false, lines: [], stderr: res.stderr ?? "" };
  }
  const lines = (res.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return { ok: true, lines, stderr: "" };
}

function computeChangedFiles(base) {
  const working = gitLines(["diff", "--name-only", "HEAD"]);
  const untracked = gitLines(["ls-files", "--others", "--exclude-standard"]);
  const branch = gitLines(["diff", "--name-only", `${base}...HEAD`]);

  if (!branch.ok) {
    console.log(
      `NOTE: could not diff against base "${base}" (is it fetched? try --base <ref>). Continuing with working-tree + untracked files only.`,
    );
  }

  const union = new Set([...working.lines, ...untracked.lines, ...(branch.ok ? branch.lines : [])]);
  return [...union].sort();
}

function isTestOrSrcFile(rel) {
  if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel)) return false;
  return rel.startsWith("src/") || rel.startsWith("tests/");
}

function isLintableFile(rel) {
  return /\.(ts|tsx|js|mjs)$/.test(rel);
}

function existsInRepo(rel) {
  return existsSync(join(REPO_ROOT, rel));
}

function runVitestRelated(files) {
  const candidates = files.filter(isTestOrSrcFile).filter(existsInRepo);
  if (candidates.length === 0) {
    console.log("SKIP  vitest related  — no changed src/ or tests/ files (exit 0)");
    return 0;
  }
  console.log(`RUN   vitest related — ${candidates.length} file(s): ${candidates.join(", ")}`);
  // vitest.config.ts's `include` covers BOTH tests/unit/**/*.test.ts{,x} and
  // tests/integration/**/*.test.ts (see its comment) - `related` walks the
  // module graph and will happily pull in an integration suite (e.g. a
  // "*-postgres.test.ts" that needs a real database) if the changed file is
  // transitively imported there. A per-prompt gate has no database, so
  // explicitly exclude tests/integration here; it never reaches tests/e2e
  // either (a separate Playwright config/runner, not in this `include` list).
  const res = sh(
    "npx",
    ["vitest", "related", "--run", "--exclude", "tests/integration/**", ...candidates],
    { stdio: "inherit" },
  );
  const code = res.status ?? 1;
  console.log(`STEP  vitest related — exit ${code}`);
  return code;
}

function runEslint(files) {
  const candidates = files.filter(isLintableFile).filter(existsInRepo);
  if (candidates.length === 0) {
    console.log("SKIP  eslint — no changed .ts/.tsx/.js/.mjs files still on disk (exit 0)");
    return 0;
  }
  console.log(`RUN   eslint — ${candidates.length} file(s): ${candidates.join(", ")}`);
  const res = sh("npx", ["eslint", ...candidates], { stdio: "inherit" });
  const code = res.status ?? 1;
  console.log(`STEP  eslint — exit ${code}`);
  return code;
}

function runTsc(skip) {
  if (skip) {
    console.log("SKIP  tsc --noEmit -p . — --skip-tsc passed");
    return null;
  }
  console.log("RUN   tsc --noEmit -p .");
  const res = sh("npx", ["tsc", "--noEmit", "-p", "."], { stdio: "inherit" });
  const code = res.status ?? 1;
  console.log(`STEP  tsc --noEmit -p . — exit ${code}`);
  return code;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: npm run gate:prompt -- [--base <ref>] [--skip-tsc]

  --base <ref>   base ref for "commits on this branch not on the base" (default: origin/prakrit)
  --skip-tsc     skip the tsc --noEmit step
`);
    process.exit(0);
  }

  console.log(`gate:prompt — base=${args.base}`);
  const changed = computeChangedFiles(args.base);
  console.log(`Changed files (${changed.length}): ${changed.length ? changed.join(", ") : "(none)"}`);
  console.log("");

  const vitestCode = runVitestRelated(changed);
  console.log("");
  const eslintCode = runEslint(changed);
  console.log("");
  const tscCode = runTsc(args.skipTsc);
  console.log("");

  console.log("── gate:prompt summary ──────────────────────────────");
  console.log(`vitest related : exit ${vitestCode}`);
  console.log(`eslint          : exit ${eslintCode}`);
  console.log(`tsc --noEmit    : ${tscCode === null ? "skipped" : `exit ${tscCode}`}`);

  const failed = [vitestCode, eslintCode, tscCode].some((c) => c !== null && c !== 0);
  if (failed) {
    console.log("RESULT: FAILED");
    process.exit(1);
  }
  console.log("RESULT: PASSED");
  process.exit(0);
}

main();
