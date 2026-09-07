#!/usr/bin/env node
/**
 * Production → staging data refresh.
 *
 * Read-only against production (`qahnczmilgptcedaqype`). Writes only to staging
 * (`xwszcafaontidfgznlxd`). Default is dry-run. --apply requires
 * ALLOW_STAGING_PROD_CLONE=1 and never accepts a production write flag.
 *
 * Dump uses the logged-in Supabase CLI role (`cli_login_postgres`) plus local
 * `pg_dump --role postgres`. Docker is not required. PROD_DB_PASSWORD is
 * optional. Staging writes use the same CLI login against the staging project.
 *
 * `--apply` is an INCREMENTAL three-way merge (`decideRowFate`, applied by
 * `lib/staging-merge-apply.sql`): production wins on rows it changed, and rows
 * QA created or edited on staging survive. It never wipes. The dump is restored
 * into a throwaway import schema first, so a bad dump cannot empty staging, and
 * the merge plus its snapshot rotation are one transaction.
 *
 * `--apply --full-replace` is the escape hatch: wipe staging and restore
 * production wholesale, discarding every staging-only row. Only when someone
 * explicitly wants staging reset.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROD_REF,
  STAGING_REF,
  assertCloneEndpoint,
  rewriteDumpSchema,
} from "./lib/prod-staging-merge.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT_DIR = join(ROOT, ".staging-prod-sync");
const SNAPSHOT_MARK = join(SNAPSHOT_DIR, "last-prod-dump.ok");
const LIBPQ_BINS = ["/opt/homebrew/opt/libpq/bin", "/usr/local/opt/libpq/bin"];

function hasFlag(name) {
  return process.argv.includes(name);
}

function toolPath(name) {
  for (const dir of LIBPQ_BINS) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

function redact(text, secrets) {
  let out = String(text || "");
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join("<redacted>");
    out = out.split(encodeURIComponent(secret)).join("<redacted>");
  }
  return out;
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

function parseExportEnv(text) {
  const env = {};
  for (const key of ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"]) {
    const match = text.match(new RegExp(`export ${key}="([^"]*)"`));
    if (!match) throw new Error(`CLI login dry-run missing ${key}`);
    env[key] = match[1];
  }
  return env;
}

function cliLoginEnv(ref) {
  const result = spawnSync(
    "npx",
    ["-y", "supabase@2.116.0", "db", "dump", "--project-ref", ref, "--data-only", "--schema", "public", "--dry-run", "--yes"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0 && !text.includes("export PGHOST=")) {
    throw new Error(`CLI login for ${ref} failed:\n${text.slice(-400)}`);
  }
  return parseExportEnv(text);
}

function assertLoginTarget(env, ref, kind) {
  const blob = `${env.PGUSER} ${env.PGHOST}`;
  if (!blob.includes(ref)) {
    throw new Error(`refuse: ${kind} login does not name ${ref}`);
  }
  if (kind === "staging" && blob.includes(PROD_REF)) {
    throw new Error("refuse: staging login unexpectedly names production");
  }
  if (kind === "prod" && blob.includes(STAGING_REF)) {
    throw new Error("refuse: prod login unexpectedly names staging");
  }
}

function dumpProd({ file, schema }) {
  const login = cliLoginEnv(PROD_REF);
  assertLoginTarget(login, PROD_REF, "prod");
  const args = [
    "--data-only",
    "--quote-all-identifier",
    "--no-owner",
    "--no-privileges",
    "--role",
    "postgres",
    "--schema",
    schema,
    "-f",
    file,
  ];
  if (schema === "auth") args.push("--exclude-table", "auth.schema_migrations");
  const result = spawnSync(toolPath("pg_dump"), args, {
    encoding: "utf8",
    env: { ...process.env, ...login },
  });
  if (result.status !== 0) {
    throw new Error(`pg_dump ${schema} failed:\n${redact(result.stderr || result.stdout, [login.PGPASSWORD])}`);
  }
}

function runStagingSql({ args, label }) {
  const login = cliLoginEnv(STAGING_REF);
  assertLoginTarget(login, STAGING_REF, "staging");
  const result = spawnSync(toolPath("psql"), ["-v", "ON_ERROR_STOP=1", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...login },
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed:\n${redact(result.stderr || result.stdout, [login.PGPASSWORD])}`);
  }
  return result.stdout || "";
}

function wipeAndRestore({ authFile, publicFile }) {
  const wipe = `
SET ROLE postgres;
SET session_replication_role = replica;
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> 'spatial_ref_sys'
  LOOP
    EXECUTE format('TRUNCATE TABLE public.%I CASCADE', r.tablename);
  END LOOP;
  -- Every auth table the dump restores, not just users. Most auth tables cascade
  -- from auth.users, but flow_state (in-flight PKCE), audit_log_entries, instances
  -- and the sso_/saml_ tables do not — they survived the old users-only truncate
  -- and then collided with the dump's own rows, aborting the restore under
  -- ON_ERROR_STOP=1 *after* the wipe had already emptied staging.
  -- schema_migrations is excluded here because the dump excludes it too.
  FOR r IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'auth'
      AND tablename <> 'schema_migrations'
  LOOP
    EXECUTE format('TRUNCATE TABLE auth.%I CASCADE', r.tablename);
  END LOOP;
END $$;
`;
  runStagingSql({
    args: ["-c", wipe, "-f", authFile, "-f", publicFile, "-c", "RESET ALL;"],
    label: "psql wipe+restore staging",
  });
}

/**
 * Incremental refresh. Restores the dump into import schemas that nothing else
 * reads, then merges row by row and rotates the snapshot in one transaction.
 * Staging is never emptied at any point, so a failure anywhere leaves the
 * environment exactly as it was.
 */
function mergeRefresh({ authFile, publicFile }) {
  const importAuthFile = join(SNAPSHOT_DIR, "import-auth.sql");
  const importPublicFile = join(SNAPSHOT_DIR, "import-public.sql");
  writeFileSync(importAuthFile, rewriteDumpSchema(readFileSync(authFile, "utf8")));
  writeFileSync(importPublicFile, rewriteDumpSchema(readFileSync(publicFile, "utf8")));

  console.log("building import schemas…");
  runStagingSql({
    args: ["-f", join(ROOT, "scripts/lib/staging-merge-import.sql")],
    label: "psql build import schemas",
  });

  console.log("restoring production dump into import schemas…");
  runStagingSql({
    args: ["-c", "SET ROLE postgres;", "-f", importAuthFile, "-f", importPublicFile],
    label: "psql restore import schemas",
  });

  console.log("merging into staging (production wins on rows it changed)…");
  const report = runStagingSql({
    args: ["-f", join(ROOT, "scripts/lib/staging-merge-apply.sql")],
    label: "psql merge staging",
  });
  return report;
}

function main() {
  const apply = hasFlag("--apply");
  const fullReplace = hasFlag("--full-replace");
  const stagingEnv = { ...readEnvFile(".env.staging.local"), ...process.env };
  const stagingUrl = stagingEnv.NEXT_PUBLIC_SUPABASE_URL || "";

  assertCloneEndpoint({ kind: "staging", url: stagingUrl });
  assertCloneEndpoint({ kind: "prod", url: `https://${PROD_REF}.supabase.co` });

  if (apply) requireApplyGate();

  console.log(
    apply
      ? `sync-prod-to-staging: APPLY ${fullReplace ? "FULL REPLACE" : "merge"} (read ${PROD_REF} → write ${STAGING_REF})`
      : `sync-prod-to-staging: dry-run (read ${PROD_REF}, no staging write)`,
  );
  console.log("production dump uses Supabase CLI login + local pg_dump (read-only)");

  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const publicFile = join(SNAPSHOT_DIR, "prod-public.sql");
  const authFile = join(SNAPSHOT_DIR, "prod-auth.sql");

  console.log("dumping production public + auth (read-only)…");
  dumpProd({ file: publicFile, schema: "public" });
  dumpProd({ file: authFile, schema: "auth" });
  console.log(`dumped ${publicFile} and ${authFile}`);

  if (!apply) {
    console.log(
      "dry-run complete. --apply merges (staging-only rows kept); " +
        "--apply --full-replace wipes staging first.",
    );
    process.exit(0);
  }

  if (fullReplace) {
    console.log("wiping staging public + auth, then restoring…");
    wipeAndRestore({ authFile, publicFile });
    // Re-run the merge so the snapshot baseline exists. Staging equals
    // production at this point, so it changes no rows; without it the next
    // incremental refresh would have no baseline and could not tell a row
    // production deleted from a row QA created.
    console.log("seeding the merge baseline…");
    mergeRefresh({ authFile, publicFile });
  } else {
    const report = mergeRefresh({ authFile, publicFile });
    const changed = report.trim();
    console.log(changed || "no row changes (staging already matches production)");
  }

  writeFileSync(SNAPSHOT_MARK, `${new Date().toISOString()}\n`);
  console.log(
    fullReplace
      ? "staging replaced from production. Snapshot marked."
      : "staging refreshed from production. Staging-only rows kept. Snapshot marked.",
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
