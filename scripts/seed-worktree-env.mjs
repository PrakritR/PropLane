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
 * Usage:
 *   node scripts/seed-worktree-env.mjs            # copy missing env files (never overwrites)
 *   node scripts/seed-worktree-env.mjs --force    # overwrite existing env files in this worktree
 *   node scripts/seed-worktree-env.mjs --dry-run  # show what would happen, copy nothing
 *   node scripts/seed-worktree-env.mjs --include-production  # also copy .env.production.local (you mean it)
 *   npm run seed:env
 *
 * Safe by default: existing files in the worktree are left untouched unless --force.
 * Running it from the primary checkout itself is a no-op.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const dryRun = args.has("--dry-run");
const includeProduction = args.has("--include-production");

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
