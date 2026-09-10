#!/usr/bin/env node
/**
 * Seed gitignored env files into the current git worktree.
 *
 * Why this exists:
 *   A git worktree (e.g. one created by `treehouse`) shares the repo history but
 *   gets its own working directory containing only *tracked* files. Secret env
 *   files like `.env` and `.env.test` are gitignored, so a fresh worktree starts
 *   without them. The app then can't read ANTHROPIC_API_KEY, Stripe keys, the
 *   Supabase service role, etc. This copies those files over from the primary
 *   checkout so a new worktree is runnable immediately.
 *
 * What it copies:
 *   Every `.env*` file in the primary checkout that git ignores (the real secret
 *   files). Tracked `*.example` files are skipped — they already exist in the
 *   worktree and must never be clobbered. `.env.production*` is WITHHELD unless
 *   `--include-production` is passed: Next loads it for any production build,
 *   so seeding it made every local `npm run build` target the live database.
 *
 * What it does NOT copy, and why that mattered:
 *   Only whole FILES. A worktree seeded before a new secret was added to the
 *   primary keeps its stale copy forever, because the file "exists" and is
 *   skipped. On 2026-09-10 this worktree was missing only
 *   DATA_ENCRYPTION_ACTIVE_KEY_ID and DATA_ENCRYPTION_KEYS_JSON, added to the
 *   primary after the worktree was seeded. Every applicant save then 500'd
 *   inside `sealApplicantRow`, and the rental wizard reported it as
 *   "We couldn't save your latest changes ... check your connection" — an
 *   env gap that reads, to everyone looking at it, like a product bug in the
 *   application form. So the copy pass now also compares variable NAMES in the
 *   files it skipped and says which ones this worktree is missing.
 *
 * Usage:
 *   node scripts/seed-worktree-env.mjs            # copy missing env files (never overwrites)
 *   node scripts/seed-worktree-env.mjs --fill-missing-keys  # also append keys the primary has and this worktree lacks
 *   node scripts/seed-worktree-env.mjs --force    # overwrite existing env files in this worktree
 *   node scripts/seed-worktree-env.mjs --dry-run  # show what would happen, copy nothing
 *   node scripts/seed-worktree-env.mjs --include-production  # also copy .env.production.local (you mean it)
 *   npm run seed:env
 *
 * Safe by default: existing files in the worktree are left untouched unless --force.
 * Running it from the primary checkout itself is a no-op.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const dryRun = args.has("--dry-run");
const includeProduction = args.has("--include-production");
const fillMissingKeys = args.has("--fill-missing-keys");

/**
 * Env files Next loads for a PRODUCTION build. `.env.production.local` outranks
 * `.env.local` under `next build`, so a worktree that carries it has every local
 * `npm run build && npm run start` silently pointed at the LIVE Supabase project
 * — a QA sweep ran against production for a minute that way (PRP-358). Nothing a
 * worktree does needs the file, so it is never seeded by default; a person who
 * genuinely wants it passes `--include-production` and gets the warning below.
 */
const PRODUCTION_ENV_FILE_RE = /^\.env\.production(\.|$)/;

function git(cmdArgs, cwd) {
  return execFileSync("git", cmdArgs, { cwd, encoding: "utf8" }).trim();
}

function isIgnored(file, cwd) {
  try {
    // `check-ignore` exits 0 when the path is ignored, non-zero otherwise.
    execFileSync("git", ["check-ignore", "-q", file], { cwd });
    return true;
  } catch {
    return false;
  }
}

let thisRoot;
let commonDir;
try {
  thisRoot = git(["rev-parse", "--show-toplevel"], process.cwd());
  commonDir = git(["rev-parse", "--absolute-git-dir"], process.cwd());
} catch {
  console.error("seed-worktree-env: not inside a git repository.");
  process.exit(1);
}

// The shared `.git` common dir lives in the primary checkout. For a linked
// worktree, --absolute-git-dir points at `<primary>/.git/worktrees/<name>`, so
// walk up to the `.git` dir, then its parent is the primary working tree.
const gitDirMatch = commonDir.match(/^(.*)\/\.git(\/worktrees\/[^/]+)?$/);
const mainRoot = gitDirMatch ? gitDirMatch[1] : dirname(commonDir);

if (mainRoot === thisRoot) {
  console.log("seed-worktree-env: already in the primary checkout; nothing to seed.");
  process.exit(0);
}

if (!existsSync(mainRoot)) {
  console.error(`seed-worktree-env: could not locate primary checkout at '${mainRoot}'.`);
  process.exit(1);
}

// Real secret env files only: `.env`, `.env.test`, etc. Skip `*.example`
// templates — they carry no secrets and the app never reads them.
const everyEnvFile = readdirSync(mainRoot).filter(
  (name) => /^\.env(\.|$)/.test(name) && !name.endsWith(".example"),
);
const withheldProduction = includeProduction
  ? []
  : everyEnvFile.filter((name) => PRODUCTION_ENV_FILE_RE.test(name));
const candidates = everyEnvFile.filter((name) => !withheldProduction.includes(name));

for (const name of withheldProduction) {
  console.log(`  hold   ${name} (production env; pass --include-production to copy it deliberately)`);
}

let copied = 0;
let skipped = 0;
for (const name of candidates) {
  const src = join(mainRoot, name);
  if (!isIgnored(name, mainRoot)) continue; // belt-and-suspenders: skip tracked files
  const dest = join(thisRoot, name);
  if (existsSync(dest) && !force) {
    console.log(`  skip   ${name} (exists; use --force to overwrite)`);
    skipped++;
    continue;
  }
  if (dryRun) {
    console.log(`  would  seed ${name}`);
    continue;
  }
  copyFileSync(src, dest);
  console.log(`  seed   ${name}`);
  copied++;
}

if (candidates.length === 0) {
  console.log(`seed-worktree-env: no .env files found in ${basename(mainRoot)}.`);
} else if (dryRun) {
  console.log("seed-worktree-env: dry run, no files written.");
} else {
  console.log(`seed-worktree-env: ${copied} copied, ${skipped} skipped.`);
}

/**
 * Variable NAMES defined in one env file. Values are never read into the report
 * — a missing-key warning has to be safe to paste into a terminal or a ticket.
 */
function variableNames(path) {
  const names = new Set();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

/**
 * The gap a file-level copy cannot see: this worktree HAS the file, so it was
 * skipped, but the primary has since gained variables it does not carry.
 */
let missingKeyTotal = 0;
for (const name of candidates) {
  const src = join(mainRoot, name);
  const dest = join(thisRoot, name);
  if (!existsSync(dest) || !existsSync(src)) continue;
  let missing;
  try {
    const here = variableNames(dest);
    missing = [...variableNames(src)].filter((key) => !here.has(key));
  } catch {
    continue; // unreadable file is the copy pass's problem, not this one's
  }
  if (missing.length === 0) continue;
  missingKeyTotal += missing.length;
  console.log(`\n  MISSING KEYS in ${name} (present in ${basename(mainRoot)}, absent here):`);
  for (const key of missing) console.log(`    ${key}`);
  if (dryRun) {
    console.log(`  would  append ${missing.length} key(s) to ${name}`);
    continue;
  }
  if (!fillMissingKeys) continue;
  const lines = readFileSync(src, "utf8").split("\n");
  const carried = missing
    .map((key) => lines.find((line) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line)))
    .filter(Boolean);
  appendFileSync(
    dest,
    `\n# Appended by seed-worktree-env --fill-missing-keys\n${carried.join("\n")}\n`,
  );
  console.log(`  fill   appended ${carried.length} key(s) to ${name}`);
}

if (missingKeyTotal > 0 && !fillMissingKeys && !dryRun) {
  console.log(
    `\n  WARNING  ${missingKeyTotal} variable(s) exist in the primary checkout and not here.\n` +
      "           A missing key does not fail loudly at startup — it throws on the\n" +
      "           first request that needs it, and the UI usually blames something\n" +
      "           else (a save that reports a connection problem, for example).\n" +
      "           Copy them over:  npm run seed:env -- --fill-missing-keys\n",
  );
}

// Next loads `.env.production.local` for ANY production build, so its presence
// means a local `npm run build` can silently target the PRODUCTION Supabase
// project. It is withheld by default (above); this warns when it is present
// anyway — copied deliberately, or left behind by an older seed.
if (existsSync(join(thisRoot, ".env.production.local"))) {
  console.log(
    "\n  WARNING  .env.production.local is present in this worktree.\n" +
      "           Next loads it for any production build, so `npm run build` here can\n" +
      "           target the PRODUCTION Supabase project rather than dev/test.\n" +
      "           Remove it unless you mean that: rm .env.production.local\n" +
      "           Details: docs/database-environments.md\n" +
      "           #a-local-production-build-can-silently-target-production",
  );
}
