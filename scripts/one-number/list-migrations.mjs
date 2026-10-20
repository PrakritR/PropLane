#!/usr/bin/env node
/**
 * Print every migration file of the one-number build (supabase/migrations/202610*), in the order `db:push`
 * applies them, with the first comment line of each. Read-only, local files only.
 *
 *   node scripts/one-number/list-migrations.mjs [--since 20261018]
 *
 * --since is matched as a filename PREFIX, not as a floor: --since 20261018 skips 20261019* and 20261020*.
 * The runbook (docs/agents/one-number-runbook.md) lists the same files; tests/unit/one-number-migration-runbook.test.ts
 * fails when a migration from 20261018000000 on exists on disk that the runbook does not name, or when the
 * table is out of timestamp order.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "..", "supabase", "migrations");

export function listMigrations(prefix = "202610", { read = (f) => readFileSync(join(dir, f), "utf8"), files = readdirSync(dir) } = {}) {
  return files
    .filter((f) => f.endsWith(".sql") && f.startsWith(prefix))
    .sort()
    .map((file) => {
      const first = read(file).split("\n").find((l) => l.trim().startsWith("--")) ?? "";
      return { file, version: file.split("_")[0], summary: first.replace(/^--\s*/, "").trim() };
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--since");
  const prefix = i > -1 ? process.argv[i + 1] : "202610";
  for (const m of listMigrations(prefix)) console.log(`${m.version}  ${m.file}${m.summary ? `  -- ${m.summary}` : ""}`);
}
