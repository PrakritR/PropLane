#!/usr/bin/env node
/** Target-bound wrapper. The original backfill command remains dev/test-only. */
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SMS_RELEASE_TARGETS, sha256 } from "./sms-durability-release-manifest.mjs";
import { runBackfill, isCleanCutoverInventory } from "./backfill-sms-projection.mjs";

export const BACKFILL_HASH = "93715b94134330ffb7dcfe25428f9c4266e6e79f172b7867a5ed50987d45eb57";
const CURSORS = {
  staging: "/private/tmp/sms-staging-20260926-reviewed-93715b94-cursor.json",
  production: "/private/tmp/sms-production-20260926-reviewed-93715b94-cursor.json",
};

export function bindCursor(options) {
  if (!options.cursorFile) return;
  if (resolve(options.cursorFile) !== CURSORS[options.target]) throw new Error("SMS cursor path does not match target");
  const metaFile = `${options.cursorFile}.release-binding`;
  const expected = { target: options.target, projectRef: SMS_RELEASE_TARGETS[options.target], backfillHash: BACKFILL_HASH };
  if (existsSync(options.cursorFile) && !existsSync(metaFile)) throw new Error("Unbound SMS cursor refused");
  if (existsSync(metaFile)) {
    const stat = lstatSync(metaFile);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 ||
        JSON.stringify(JSON.parse(readFileSync(metaFile, "utf8"))) !== JSON.stringify(expected)) {
      throw new Error("SMS cursor binding differs");
    }
  } else if (options.apply) {
    writeFileSync(metaFile, JSON.stringify(expected), { flag: "wx", mode: 0o600 });
  }
}

export function args(argv) {
  const options = { apply: false, batchSize: 100, maxPages: 10 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--target") options.target = argv[++i];
    else if (argv[i] === "--apply") options.apply = true;
    else if (argv[i] === "--cursor-file") options.cursorFile = argv[++i];
    else if (argv[i] === "--batch-size") options.batchSize = Number(argv[++i]);
    else if (argv[i] === "--max-pages") options.maxPages = Number(argv[++i]);
    else throw new Error("Unknown SMS reconciliation option");
  }
  if (!Object.hasOwn(SMS_RELEASE_TARGETS, options.target) ||
      !Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 500 ||
      !Number.isInteger(options.maxPages) || options.maxPages < 1 || options.maxPages > 100 ||
      (options.apply && (!options.cursorFile || !resolve(options.cursorFile).startsWith("/private/tmp/")))) {
    throw new Error("Exact target, bounded pages, and private resumable cursor required");
  }
  return options;
}

export function assertMigrationPostflights(target, spawn = spawnSync) {
  for (const [script, label] of [
    ["sms-message-sid-prefix-release-migration.mjs", "SMS SID correction migration"],
  ]) {
    const result = spawn(process.execPath,
      [new URL(`./${script}`, import.meta.url).pathname, "--target", target, "--phase", "postflight"],
      { stdio: "ignore", timeout: 120_000 });
    if (result.status !== 0 || result.error) {
      throw new Error(`Exact ${label} postflight required before reconciliation`);
    }
  }
}

async function main() {
  const options = args(process.argv.slice(2));
  const backfillBytes = readFileSync(new URL("./backfill-sms-projection.mjs", import.meta.url));
  if (sha256(backfillBytes) !== BACKFILL_HASH) throw new Error("Reviewed SMS backfill changed");
  bindCursor(options);
  const target = SMS_RELEASE_TARGETS[options.target];
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (url !== `https://${target}.supabase.co` || !key || !process.env.TWILIO_ACCOUNT_SID?.trim()) {
    throw new Error("SMS reconciliation target URL, service key, or account SID missing");
  }
  assertMigrationPostflights(options.target);
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: cutoverBefore, error: cutoverError } = await db.from("sms_projection_cutover").select("ready").eq("singleton", true).single();
  if (cutoverError || !cutoverBefore) throw new Error("SMS cutover singleton missing");
  const report = await runBackfill(db, options);
  const { data: cutoverAfter, error: afterError } = await db.from("sms_projection_cutover").select("ready").eq("singleton", true).single();
  if (afterError || !cutoverAfter) throw new Error("SMS cutover readback failed");
  const clean = report.inventoryComplete && isCleanCutoverInventory(report.sources);
  if (options.apply && report.complete && (!clean || !report.readinessUpdated || report.cleanPasses !== 2 || cutoverAfter.ready !== true)) {
    throw new Error("SMS reconciliation readiness proof failed");
  }
  console.log(JSON.stringify({ target: options.target, cutoverBefore: cutoverBefore.ready,
    cutoverAfter: cutoverAfter.ready, ...report }, null, 2));
  if (!report.complete) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("SMS reconciliation refused or failed; inspect target and cursor before retry."); process.exitCode = 1; });
}
