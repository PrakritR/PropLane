#!/usr/bin/env node
/** Restore only 18 already-visible production SMS originals to their missing transport log. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { backup, connect, credential } from "./sms-durability-release-migrations.mjs";

const TARGET = "qahnczmilgptcedaqype";
const PRIVATE_DIR = "/Users/akhilvemuri/.codex/release-backups/sms-20260926";
const EVIDENCE_FILE = `${PRIVATE_DIR}/provider-originals-production-missing-log-18-20260926.json`;
const EVIDENCE_SHA256 = "2a13837ef8c87dc5e614d67eff4607493d963c672c75f3a39659fa80f3096805";
const SOURCE_OWNER_SHA256 = "4b24cecb8815c322d3176de3b9ef0a1090c43d68287b125c4074fc68393ea3ff";
const SOURCE_CONTEXT_SHA256 = "a6f793d071c6243f0b2dc59c4e2290f0b1ef0043f1fcc9811de41605d4c64eda";
const EXPECTED_COUNT = 18;

// SHARE conflicts with ordinary INSERT/UPDATE/DELETE RowExclusive locks. Keep
// this order fixed across rehearsals and the apply transaction. The source
// ingress/burst/receipt rows are locked separately by assertState().
export const RESTORE_PREDICATE_LOCK_TABLES = Object.freeze([
  "manager_sms_messages",
  "manager_sms_numbers",
  "portal_inbox_thread_records",
  "portal_workspaces",
  "sms_relay_messages",
]);
export async function lockRestorePredicates(client) {
  for (const table of RESTORE_PREDICATE_LOCK_TABLES) {
    await client.query(`lock table public.${table} in share mode`);
  }
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const consentPhoneKey = (value) => {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
};
function fail(message) { throw new Error(message); }

function options(argv) {
  const out = { phase: "preflight", authorized: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--target") out.target = argv[++i];
    else if (argv[i] === "--phase") out.phase = argv[++i];
    else if (argv[i] === "--backup-file") out.backupFile = argv[++i];
    else if (argv[i] === "--apply-authorized") out.authorized = true;
    else fail("Unknown restore option");
  }
  if (out.target !== "production" || !["preflight", "apply", "postflight"].includes(out.phase)) fail("Exact production target and phase required");
  if (out.phase !== "apply" && (out.authorized || out.backupFile)) fail("Apply options in read-only phase");
  if (out.phase === "apply") {
    if (!out.authorized || !out.backupFile) fail("Apply requires explicit authorization and new backup");
    const path = resolve(out.backupFile);
    if (dirname(path) !== PRIVATE_DIR || realpathSync(dirname(path)) !== PRIVATE_DIR ||
      (statSync(dirname(path)).mode & 0o777) !== 0o700 ||
      !basename(path).startsWith("sms-production-visible-originals-") || !path.endsWith(".dump")) {
      fail("Backup must be a fresh production-named archive in the private directory");
    }
    out.backupFile = path;
  }
  return out;
}

function evidence() {
  if (realpathSync(dirname(EVIDENCE_FILE)) !== PRIVATE_DIR || realpathSync(EVIDENCE_FILE) !== EVIDENCE_FILE ||
    (statSync(dirname(EVIDENCE_FILE)).mode & 0o777) !== 0o700 ||
    (statSync(EVIDENCE_FILE).mode & 0o777) !== 0o600) fail("Private provider evidence permissions changed");
  const bytes = readFileSync(EVIDENCE_FILE);
  if (sha256(bytes) !== EVIDENCE_SHA256) fail("Private provider evidence hash changed");
  const document = JSON.parse(bytes.toString("utf8"));
  if (document.target !== "production" || !Array.isArray(document.records) || document.records.length !== EXPECTED_COUNT) fail("Provider evidence shape changed");
  const bySid = new Map();
  for (const record of document.records) {
    if (typeof record.sid !== "string" || !/^SM[a-f0-9]{32}$/i.test(record.sid) || bySid.has(record.sid) ||
      typeof record.body !== "string" || !record.body.trim() ||
      typeof record.from !== "string" || typeof record.to !== "string" ||
      typeof record.accountSid !== "string" || !/^AC[a-f0-9]{32}$/i.test(record.accountSid) ||
      !["inbound", "inbound-api", "inbound-reply"].includes(record.direction) ||
      !Number.isFinite(Date.parse(record.dateCreated))) fail("Provider evidence record invalid");
    bySid.set(record.sid, record);
  }
  if (new Set(document.records.map((record) => record.accountSid)).size !== 1) fail("Provider account namespace differs");
  return bySid;
}

async function assertState(client, originals, { restored, lock }) {
  const sids = [...originals.keys()].sort();
  const projection = await client.query("select to_regclass('public.sms_projection_turns') is null turns_absent, to_regclass('public.sms_projection_deleted_events') is null tombstones_absent");
  if (!projection.rows[0].turns_absent || !projection.rows[0].tombstones_absent) fail("Production projection state changed; review before restoration");
  const sources = await client.query(`select i.source_message_id sid,i.manager_user_id owner,i.body,i.channel,i.burst_revision,
      i.test_actor_user_id,i.test_session_id,b.id burst_id,b.manager_user_id burst_owner,
      b.counterparty_phone_e164,b.counterparty_role,b.channel burst_channel,b.reply_from_number,b.reply_transport,
      b.identity_kind,b.test_actor_user_id burst_test_actor,b.test_session_id burst_test_session,
      r.manager_user_id receipt_owner,r.recipient_phone_key,r.status receipt_status,
      r.first_received_at::text receipt_time_text,
      r.inbound_payload,r.lease_owner receipt_lease_owner,r.lease_expires_at receipt_lease_expiry,
      (select count(*) from public.manager_sms_numbers n where n.phone_number=b.reply_from_number
        and n.provision_state in ('active','released')
        and n.manager_user_id=r.manager_user_id
        and exists(select 1 from public.portal_workspaces w
          where w.id=n.workspace_id and w.owner_user_id=i.manager_user_id)
        and coalesce(n.provisioned_at,n.requested_at)<=r.first_received_at
        and (n.released_at is null or r.first_received_at<=n.released_at)) line_count
    from public.prospect_sms_ingress i
    join public.prospect_sms_bursts b on b.id=i.burst_id
    join public.sms_inbound_receipts r on r.message_sid=i.source_message_id
    where i.source_message_id=any($1::text[]) order by i.source_message_id
    ${lock ? "for update of i,b,r" : ""}`, [sids]);
  if (sources.rowCount !== EXPECTED_COUNT || sources.rows.some((row, index) => row.sid !== sids[index])) fail("Exact source/receipt inventory differs");
  const identityHash = sha256(sources.rows.map((row) => `${row.sid}|${row.owner}`).join("\n"));
  if (identityHash !== SOURCE_OWNER_SHA256 || new Set(sources.rows.map((row) => row.owner)).size !== 1) fail("Reviewed SID/owner set changed");
  const phoneRefs = await client.query("select public.axis_sms_phone_ref(value) ref from unnest($1::text[]) with ordinality as input(value,position) order by position", [sources.rows.map((row) => originals.get(row.sid).from)]);
  const sqlTrim = await client.query(`select left(btrim(value,U&'\\0009\\000A\\000B\\000C\\000D\\0020\\00A0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF'),2000) body
    from unnest($1::text[]) with ordinality as input(value,position) order by position`,
  [sources.rows.map((row) => originals.get(row.sid).body)]);
  for (let index = 0; index < sources.rows.length; index += 1) {
    const row = sources.rows[index], original = originals.get(row.sid), ref = phoneRefs.rows[index]?.ref;
    if (row.owner !== row.burst_owner || row.owner !== row.receipt_owner || row.channel !== "twilio" ||
      row.burst_channel !== "sms" || row.counterparty_role !== "prospect" || row.reply_transport !== "twilio" ||
      row.identity_kind !== "live_phone" || row.test_actor_user_id !== null || row.test_session_id !== null ||
      row.burst_test_actor !== null || row.burst_test_session !== null ||
      row.receipt_status !== "completed" || row.inbound_payload !== null ||
      row.receipt_lease_owner !== null || row.receipt_lease_expiry !== null ||
      row.body !== original.body.trim() || row.counterparty_phone_e164 !== original.from ||
      row.reply_from_number !== original.to || consentPhoneKey(original.from) !== row.recipient_phone_key ||
      row.body !== sqlTrim.rows[index]?.body || Number(row.line_count) !== 1 ||
      !ref || !Number.isFinite(Date.parse(row.receipt_time_text))) fail("Original source, receipt, phone, or role context changed");
    row.conversation_key = `${row.owner}:prospect:${ref}`;
  }
  const contextHash = sha256(sources.rows.map((row) =>
    [row.sid, row.owner, row.burst_id, row.burst_revision, row.receipt_time_text].join("|")).join("\n"));
  if (contextHash !== SOURCE_CONTEXT_SHA256) fail("Reviewed receipt time or burst context changed");
  const alternatives = await client.query(`select
    (select count(*) from public.manager_sms_messages where message_sid=any($1::text[])) manager_logs,
    (select count(*) from public.sms_relay_messages where twilio_sid=any($1::text[])) relay_logs`, [sids]);
  if (Number(alternatives.rows[0].manager_logs) !== 0 || Number(alternatives.rows[0].relay_logs) !== 0) fail("Alternative transport source appeared");
  const existing = await client.query(`select l.message_sid,l.manager_user_id,l.body,l.from_phone,l.to_phone,
    l.counterparty_role,l.conversation_key,l.matched_sender_user_id,
    (l.created_at=r.first_received_at) exact_receipt_time
    from public.inbound_sms_log l join public.sms_inbound_receipts r on r.message_sid=l.message_sid
    where l.message_sid=any($1::text[]) order by l.message_sid`, [sids]);
  if ((!restored && existing.rowCount !== 0) || (restored && existing.rowCount !== EXPECTED_COUNT)) fail("Restored log count differs");
  if (restored) for (let index = 0; index < EXPECTED_COUNT; index += 1) {
    const actual = existing.rows[index], row = sources.rows[index], original = originals.get(row.sid);
    if (actual.message_sid !== row.sid || actual.manager_user_id !== row.owner || actual.body !== original.body ||
      actual.from_phone !== original.from || actual.to_phone !== original.to ||
      actual.counterparty_role !== "prospect" || actual.conversation_key !== row.conversation_key ||
      actual.matched_sender_user_id !== null || actual.exact_receipt_time !== true) fail("Restored original differs");
  }
  const patterns = sids.map((sid) => `%${sid}%`);
  const notices = await client.query(`select owner_user_id,scope,thread_type,row_data from public.portal_inbox_thread_records
    where scope='axis_portal_inbox_manager_v1' and row_data::text like any($1::text[])
    ${lock ? "for share" : ""}`, [patterns]);
  const counts = new Map(sids.map((sid) => [sid, 0]));
  const mirrorSids = new Set();
  let noticeMatches = 0;
  for (const notice of notices.rows) {
    const data = notice.row_data ?? {};
    const matches = [{ id: data.rootMessageId, body: data.body, from: data.from, flags: data },
      ...(Array.isArray(data.messages) ? data.messages.map((message) => ({ id: message?.id, body: message?.body, from: message?.from, flags: message })) : [])];
    for (const match of matches) for (const sid of sids) {
      if (match.id !== `leasing_${sid}` && match.id !== sid && match.id !== `sms_${sid}`) continue;
      const row = sources.rows[sids.indexOf(sid)], original = originals.get(sid);
      if (notice.scope !== "axis_portal_inbox_manager_v1" || notice.thread_type !== "claw_leasing_sms" ||
        data.folder !== "inbox" || data.hidden === true || data.deleted === true ||
        data.isHidden === true || data.isDeleted === true || match.flags?.hidden === true ||
        match.flags?.deleted === true || match.flags?.isHidden === true || match.flags?.isDeleted === true ||
        match.body !== row.body || match.from !== original.from) fail("Existing visible original changed or is hidden");
      noticeMatches += 1;
      if (notice.owner_user_id === row.owner) counts.set(sid, counts.get(sid) + 1);
      else mirrorSids.add(sid);
    }
  }
  if (notices.rowCount !== 9 || noticeMatches !== 46 || mirrorSids.size !== 14 ||
    [...counts.values()].some((count) => count < 1)) fail("Reviewed active inbox original set changed");
  return { sources: sources.rows, ownerNoticeCount: [...counts.values()].filter((count) => count > 0).length };
}

async function readOnly(client, originals, restored) {
  await client.query("begin read only");
  try { await client.query("set local role postgres"); return await assertState(client, originals, { restored, lock: false }); }
  finally { await client.query("rollback").catch(() => undefined); }
}

async function main() {
  const opt = options(process.argv.slice(2)), originals = evidence();
  const config = credential(TARGET);
  let client = await connect(config);
  try {
    if (opt.phase === "preflight" || opt.phase === "postflight") {
      const state = await readOnly(client, originals, opt.phase === "postflight");
      console.log(JSON.stringify({ target: "production", phase: opt.phase, exactOriginals: state.sources.length,
        activeOwnerNotices: state.ownerNoticeCount, ready: true }));
      return;
    }
    await readOnly(client, originals, false);
    backup(config, opt.backupFile);
    await client.query("begin");
    let commitAttempted = false;
    try {
      await client.query("set local role postgres");
      await client.query("set local lock_timeout='3s'");
      await client.query("set local statement_timeout='60s'");
      const claim = await client.query("select pg_try_advisory_xact_lock(20260926220000::bigint) acquired");
      if (!claim.rows[0]?.acquired) fail("Restore advisory lock unavailable");
      await lockRestorePredicates(client);
      const state = await assertState(client, originals, { restored: false, lock: true });
      for (const row of state.sources) {
        const original = originals.get(row.sid);
        const inserted = await client.query(`insert into public.inbound_sms_log
          (manager_user_id,from_phone,to_phone,matched_sender_user_id,body,message_sid,created_at,counterparty_role,conversation_key)
          select $1,$2,$3,null,$4,$5,r.first_received_at,'prospect',$6
          from public.sms_inbound_receipts r
          where r.message_sid=$5 and r.first_received_at::text=$7
          returning message_sid`,
        [row.owner, original.from, original.to, original.body, row.sid, row.conversation_key, row.receipt_time_text]);
        if (inserted.rowCount !== 1 || inserted.rows[0].message_sid !== row.sid) fail("Original insert count differs");
      }
      await assertState(client, originals, { restored: true, lock: true });
      commitAttempted = true;
      await client.query("commit");
    } catch (error) {
      if (!commitAttempted) await client.query("rollback").catch(() => undefined);
      throw error;
    }
    await client.end();
    client = await connect(config);
    await readOnly(client, originals, true);
    console.log(JSON.stringify({ target: "production", phase: "apply", outcome: "committed_and_verified",
      backupFile: opt.backupFile, exactOriginals: EXPECTED_COUNT }));
  } finally { await client.end().catch(() => undefined); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("Visible-original restoration failed. Inspect exact state before retrying; commit may be uncertain.");
    process.exitCode = 1;
  });
}
