#!/usr/bin/env node
/** Exact staging-only removal of two documented synthetic ingress rows. */
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { backup, connect, credential } from "./sms-durability-release-migrations.mjs";

const STAGING_REF = "xwszcafaontidfgznlxd";
const OWNER_ID = "4607b4c2-8a1f-4840-a0db-11b4472b62e7";
const OWNER_EMAIL = "release.qa.20260911@test.proplane.local";
const BURST_ID = "ff18f230-b4d4-4723-aacc-7308c4ecd390";
const SOURCES = Object.freeze([
  ["trial-4c04bfd4-d005-4588-9207-f8e632ce2117-1", 2, "defaf165acf904e2137b223fddd32de8deffdddd6536ed15cc61492c9f21c30c"],
  ["trial-4c04bfd4-d005-4588-9207-f8e632ce2117-2", 3, "481dff63b0ae4b66c9169c5bf38f9d0bb29c334b9f5480ee8565aafca6b897d9"],
]);
const SOURCE_IDS = SOURCES.map(([id]) => id);
const BACKUP_DIR = "/Users/akhilvemuri/.codex/release-backups/sms-20260926";

function args(argv) {
  const out = { phase: "preflight", authorized: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--target") out.target = argv[++i];
    else if (argv[i] === "--phase") out.phase = argv[++i];
    else if (argv[i] === "--backup-file") out.backupFile = argv[++i];
    else if (argv[i] === "--apply-authorized") out.authorized = true;
    else throw new Error("Unknown cleanup option");
  }
  if (out.target !== "staging" || !["preflight", "apply", "postflight"].includes(out.phase)) {
    throw new Error("Exact --target staging and --phase required");
  }
  if (out.phase !== "apply" && (out.authorized || out.backupFile)) throw new Error("Apply options in read-only phase");
  if (out.phase === "apply") {
    if (!out.authorized || !out.backupFile) throw new Error("Explicit apply authorization and new backup required");
    const path = resolve(out.backupFile);
    const directory = dirname(path);
    if (directory !== BACKUP_DIR || realpathSync(directory) !== BACKUP_DIR ||
      (statSync(directory).mode & 0o777) !== 0o700 ||
      !basename(path).startsWith("sms-staging-synthetic-ingress-") || !path.endsWith(".dump")) {
      throw new Error("Backup path must be a fresh target-specific archive in the private release directory");
    }
    out.backupFile = path;
  }
  return out;
}

async function count(client, sql, values) {
  const result = await client.query(sql, values);
  return Number(result.rows[0]?.n ?? -1);
}

async function assertCatalog(client, { removed, lock = false }) {
  const owner = await client.query("select id from public.profiles where id=$1 and email=$2", [OWNER_ID, OWNER_EMAIL]);
  if (owner.rows.length !== 1) throw new Error("QA owner identity differs");
  const burst = await client.query(`select manager_user_id,status,revision,handled_revision,channel,reply_transport,
    outbox_id,lease_owner,lease_expires_at,identity_kind,test_actor_user_id,test_session_id
    from public.prospect_sms_bursts where id=$1 ${lock ? "for update" : ""}`, [BURST_ID]);
  const b = burst.rows[0];
  if (burst.rows.length !== 1 || b.manager_user_id !== OWNER_ID || b.status !== "suppressed" ||
    b.revision !== 3 || b.handled_revision !== 3 || b.channel !== "sms" || b.reply_transport !== "twilio" ||
    b.outbox_id !== null || b.lease_owner !== null || b.lease_expires_at !== null ||
    b.identity_kind !== "live_phone" || b.test_actor_user_id !== null || b.test_session_id !== null) {
    throw new Error("Synthetic burst changed");
  }
  const ingress = await client.query(`select source_message_id,manager_user_id,channel,burst_revision,body,
    test_actor_user_id,test_session_id from public.prospect_sms_ingress where burst_id=$1
    order by source_message_id ${lock ? "for update" : ""}`, [BURST_ID]);
  if (removed) {
    if (ingress.rows.length !== 0) throw new Error("Synthetic ingress remains after cleanup");
  } else {
    if (ingress.rows.length !== SOURCES.length) throw new Error("Synthetic burst ingress count differs");
    for (const [index, [id, revision, hash]] of SOURCES.entries()) {
      const row = ingress.rows[index];
      if (row.source_message_id !== id || row.manager_user_id !== OWNER_ID || row.channel !== "twilio" ||
        row.burst_revision !== revision || row.test_actor_user_id !== null || row.test_session_id !== null ||
        createHash("sha256").update(row.body).digest("hex") !== hash) {
        throw new Error("Synthetic ingress identity or body hash differs");
      }
    }
  }
  const shadow = await client.query("select burst_revision,status,manager_user_id from public.prospect_sms_shadow_jobs where burst_id=$1", [BURST_ID]);
  if (shadow.rows.length !== 1 || shadow.rows[0].burst_revision !== 3 ||
    shadow.rows[0].status !== "completed" || shadow.rows[0].manager_user_id !== OWNER_ID) {
    throw new Error("Suppressed shadow job changed");
  }
  const checks = [
    ["receipt", "select count(*) n from public.sms_inbound_receipts where message_sid=any($1::text[])", [SOURCE_IDS]],
    ["inbound log", "select count(*) n from public.inbound_sms_log where message_sid=any($1::text[])", [SOURCE_IDS]],
    ["manager log", "select count(*) n from public.manager_sms_messages where message_sid=any($1::text[])", [SOURCE_IDS]],
    ["agent transcript", "select count(*) n from public.agent_messages where source_message_sid=any($1::text[])", [SOURCE_IDS]],
    ["projection turn", "select count(*) n from public.sms_projection_turns where source_event_id=any($1::text[]) or provider_sid=any($1::text[]) or source_ref->>'id'=any($1::text[])", [SOURCE_IDS]],
    ["projection pending", "select count(*) n from public.sms_projection_pending where source_event_id=any($1::text[]) or event_payload->>'providerSid'=any($1::text[]) or event_payload->'sourceRef'->>'id'=any($1::text[])", [SOURCE_IDS]],
    ["projection tombstone", "select count(*) n from public.sms_projection_deleted_events where source_event_id=any($1::text[]) or provider_sid=any($1::text[])", [SOURCE_IDS]],
    ["outbox", "select count(*) n from public.sms_outbox where prospect_burst_id=$1", [BURST_ID]],
    ["booking", "select count(*) n from public.prospect_tour_bookings where burst_id=$1", [BURST_ID]],
    ["reminder", "select count(*) n from public.prospect_sms_tour_reminders where burst_id=$1", [BURST_ID]],
    ["inline action", "select count(*) n from public.prospect_sms_inline_actions where burst_id=$1", [BURST_ID]],
  ];
  for (const [label, sql, value] of checks) {
    if (await count(client, sql, value) !== 0) throw new Error(`Synthetic ${label} dependency exists`);
  }
}

async function readOnly(client, removed) {
  await client.query("begin read only");
  try {
    await client.query("set local role postgres");
    await assertCatalog(client, { removed });
  } finally { await client.query("rollback").catch(() => undefined); }
}

async function main() {
  const opt = args(process.argv.slice(2));
  const config = credential(STAGING_REF);
  let client = await connect(config);
  try {
    if (opt.phase === "postflight") {
      await readOnly(client, true);
      console.log(JSON.stringify({ target: "staging", phase: "postflight", removed: 2, burst: "preserved", shadowJob: "preserved" }));
      return;
    }
    await readOnly(client, false);
    if (opt.phase === "preflight") {
      console.log(JSON.stringify({ target: "staging", phase: "preflight", exactSyntheticIngress: 2, ready: true }));
      return;
    }
    backup(config, opt.backupFile);
    await client.query("begin");
    let commitAttempted = false;
    try {
      await client.query("set local role postgres");
      await client.query("set local lock_timeout='3s'");
      await client.query("set local statement_timeout='60s'");
      const locked = await client.query("select pg_try_advisory_xact_lock(20260926190000::bigint) acquired");
      if (!locked.rows[0]?.acquired) throw new Error("Cleanup lock unavailable");
      await assertCatalog(client, { removed: false, lock: true });
      const deleted = await client.query("delete from public.prospect_sms_ingress where source_message_id=any($1::text[]) and manager_user_id=$2 and burst_id=$3 returning source_message_id", [SOURCE_IDS, OWNER_ID, BURST_ID]);
      if (deleted.rowCount !== 2 || deleted.rows.some((row) => !SOURCE_IDS.includes(row.source_message_id))) {
        throw new Error("Cleanup delete scope differs");
      }
      await assertCatalog(client, { removed: true, lock: true });
      commitAttempted = true;
      await client.query("commit");
    } catch (error) {
      if (!commitAttempted) await client.query("rollback").catch(() => undefined);
      throw error;
    }
    await client.end();
    client = await connect(config);
    await readOnly(client, true);
    console.log(JSON.stringify({ target: "staging", phase: "apply", outcome: "committed_and_verified",
      backupFile: opt.backupFile, removed: 2, burst: "preserved", shadowJob: "preserved" }));
  } finally { await client.end().catch(() => undefined); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("Staging synthetic ingress cleanup failed. Inspect exact catalog state before retrying; commit may be uncertain.");
    process.exitCode = 1;
  });
}
