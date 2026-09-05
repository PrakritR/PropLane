#!/usr/bin/env node
/**
 * Production → staging data refresh.
 *
 * Read-only against production (`qahnczmilgptcedaqype`). Writes only to staging
 * (`xwszcafaontidfgznlxd`). Default is dry-run. --apply requires
 * ALLOW_STAGING_PROD_CLONE=1 and never accepts a production write flag.
 *
 * First --apply (no snapshot yet): restore the prod dump into staging. That is
 * the full clone. Later --apply without --full-replace refuses: a second restore
 * would wipe staging-only rows. Use the merge planner (`decideRowFate`) for
 * those refreshes, or --full-replace if the captain wants a wipe.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROD_REF,
  STAGING_REF,
  assertCloneEndpoint,
} from "./lib/prod-staging-merge.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_DIR = join(ROOT, ".staging-prod-sync");
const SNAPSHOT_MARK = join(SNAPSHOT_DIR, "last-prod-dump.ok");

function hasFlag(name) {
  return process.argv.includes(name);
}

function readEnvFile(rel) {
  const path = join(ROOT, rel);
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^['"]|['"]$/g, "");
  }
  return out;
}

function requireApplyGate() {
  if (process.env.ALLOW_PRODUCTION_LISTING_WRITE) {
    throw new Error("Refuse: ALLOW_PRODUCTION_LISTING_WRITE is set. This script never writes production.");
  }
  if (process.env.ALLOW_STAGING_PROD_CLONE !== "1") {
    throw new Error("Refuse: set ALLOW_STAGING_PROD_CLONE=1 for --apply (staging writes only).");
  }
}

function dumpProd({ password, file, schema }) {
  const args = [
    "supabase",
    "db",
    "dump",
    "--project-ref",
    PROD_REF,
    "--data-only",
    "--use-copy",
    "--schema",
    schema,
    "--file",
    file,
    "--yes",
  ];
  if (password) args.push("--password", password);
  const result = spawnSync("npx", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`supabase db dump ${schema} failed:\n${result.stderr || result.stdout}`);
  }
}

function restoreStaging({ password, files }) {
  const url = `postgresql://postgres:${encodeURIComponent(password)}@db.${STAGING_REF}.supabase.co:5432/postgres`;
  const result = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", ...files.flatMap((file) => ["-f", file])], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`psql restore into staging failed:\n${result.stderr || result.stdout}`);
  }
}

function main() {
  const apply = hasFlag("--apply");
  const fullReplace = hasFlag("--full-replace");
  const stagingEnv = { ...readEnvFile(".env.staging.local"), ...process.env };
  const stagingUrl = stagingEnv.NEXT_PUBLIC_SUPABASE_URL || "";
  const stagingPassword = stagingEnv.STAGING_DB_PASSWORD || "";
  const prodPassword = process.env.PROD_DB_PASSWORD || "";

  assertCloneEndpoint({ kind: "staging", url: stagingUrl });
  assertCloneEndpoint({ kind: "prod", url: `https://${PROD_REF}.supabase.co` });

  if (apply) requireApplyGate();

  const hasSnapshot = existsSync(SNAPSHOT_MARK);
  console.log(
    apply
      ? `sync-prod-to-staging: APPLY (read ${PROD_REF} → write ${STAGING_REF})`
      : `sync-prod-to-staging: dry-run (read ${PROD_REF}, no staging write)`,
  );

  if (!prodPassword) {
    console.log("missing PROD_DB_PASSWORD — production READ is not available in this process.");
    if (apply) throw new Error("PROD_DB_PASSWORD is required for --apply");
    console.log("dry-run ok: safety rails passed.");
    process.exit(0);
  }

  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const publicFile = join(SNAPSHOT_DIR, "prod-public.sql");
  const authFile = join(SNAPSHOT_DIR, "prod-auth.sql");

  console.log("dumping production public + auth (read-only)…");
  dumpProd({ password: prodPassword, file: publicFile, schema: "public" });
  dumpProd({ password: prodPassword, file: authFile, schema: "auth" });

  if (!apply) {
    console.log(`dry-run dumped to ${SNAPSHOT_DIR}. Pass --apply to write staging.`);
    process.exit(0);
  }

  if (!stagingPassword) {
    throw new Error("STAGING_DB_PASSWORD missing from .env.staging.local");
  }

  if (hasSnapshot && !fullReplace) {
    throw new Error(
      "A snapshot already exists. A second restore would wipe staging-only rows. " +
        "Re-run with --full-replace only if the captain wants a wipe, or wait for the merge apply path.",
    );
  }

  restoreStaging({ password: stagingPassword, files: [authFile, publicFile] });
  writeFileSync(SNAPSHOT_MARK, `${new Date().toISOString()}\n`);
  console.log("staging restore complete. Snapshot marked.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
