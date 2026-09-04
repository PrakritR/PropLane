#!/usr/bin/env node
/**
 * Fail with an explanation when a required env file is missing.
 *
 * `node --env-file=.env.test …` fails inside Node before the script it names
 * runs, with a raw ENOENT that points nowhere near the cause. In a fresh
 * worktree that is the FIRST thing you hit, because a worktree carries tracked
 * files only and every `.env*` is gitignored — so the error you get while
 * trying to seed a database is about a file, and nothing says the fix is one
 * command away (PRP-197).
 *
 * Wired as an npm `pre<script>` hook, so it runs before Node sees the flag.
 *
 *   node scripts/check-env-files.mjs .env.test [.env.local …]
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const required = process.argv.slice(2);
const missing = required.filter((name) => !existsSync(join(process.cwd(), name)));

if (missing.length > 0) {
  const list = missing.map((n) => `  • ${n}`).join("\n");
  console.error(
    `Missing env file${missing.length > 1 ? "s" : ""}:\n${list}\n\n` +
      "  A git worktree only carries TRACKED files, and every .env* is gitignored,\n" +
      "  so a fresh worktree starts without them. Copy them from the primary checkout:\n\n" +
      "    npm run seed:env\n\n" +
      "  (It never overwrites an existing file; add --force if you mean to.)",
  );
  process.exit(1);
}
