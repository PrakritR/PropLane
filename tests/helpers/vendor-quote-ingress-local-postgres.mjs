/** Disposable real PostgreSQL proof for the additive sealed quote transport migration.
 * Run with VENDOR_QUOTE_INGRESS_LOCAL_POSTGRES=1. No external DATABASE_URL is accepted.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import pg from "pg";

const ROOT = resolve(import.meta.dirname, "../..");
const BIN = "/opt/homebrew/bin/";
const { Client } = pg;
if (process.env.VENDOR_QUOTE_INGRESS_LOCAL_POSTGRES !== "1" || process.env.DATABASE_URL) {
  throw new Error("Set VENDOR_QUOTE_INGRESS_LOCAL_POSTGRES=1 and unset DATABASE_URL; this runner creates its own loopback PostgreSQL cluster.");
}

const run = (name, args, timeout = 30_000) => execFileSync(`${BIN}${name}`, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
async function freePort() {
  const server = createServer();
  await new Promise((ok, reject) => server.once("error", reject).listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  await new Promise((ok) => server.close(ok));
  return port;
}
async function cluster() {
  for (const name of ["initdb", "pg_ctl", "postgres"]) assert.match(run(name, ["--version"]), /PostgreSQL/);
  const dir = mkdtempSync(join(tmpdir(), "vendor-quote-ingress-pg-"));
  const data = join(dir, "data");
  const port = await freePort();
  let started = false;
  try {
    run("initdb", ["-D", data, "--username=postgres", "--auth-local=trust", "--auth-host=trust", "--no-locale", "--encoding=UTF8"]);
    appendFileSync(join(data, "postgresql.conf"), `\nlisten_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nshared_buffers='16MB'\nmax_connections=10\nmax_worker_processes=0\nmax_parallel_workers=0\nautovacuum=off\ndeadlock_timeout='100ms'\n`);
    run("pg_ctl", ["-D", data, "-l", join(dir, "postgres.log"), "-w", "-t", "30", "start"], 35_000);
    started = true;
    return { dir, data, port };
  } catch (error) {
    if (started) run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
function stopCluster(owned) {
  if (!owned) return;
  // pg_ctl only acts on this runner's unique data directory; never scan/stop by port.
  try { run("pg_ctl", ["-D", owned.data, "-m", "fast", "-w", "-t", "20", "stop"], 25_000); }
  finally { rmSync(owned.dir, { recursive: true, force: true }); }
}
function config(owned, database) {
  return { host: "127.0.0.1", port: owned.port, user: "postgres", database,
    connectionTimeoutMillis: 5000, options: "-c statement_timeout=12000 -c lock_timeout=8000" };
}
async function connect(owned, database) {
  const db = new Client(config(owned, database));
  await db.connect();
  return db;
}

const DURABLE = "20261104120000_sms_durable_ingress.sql";
const BRIDGE = "20261104150000_vendor_quote_durable_ingress.sql";
const checks = [];
let owned; let db; let other;
try {
 owned = await cluster(); db = await connect(owned, "postgres"); other = await connect(owned, "postgres");
 await db.query("create role anon; create role authenticated; create role service_role; create table public.sms_inbound_receipts(message_sid text primary key,status text);");
 // Supabase may grant this role function EXECUTE through the owner's default ACL.
 await db.query("alter default privileges grant execute on functions to service_role");
 const durable = readFileSync(join(ROOT, "supabase/migrations", DURABLE), "utf8");
 const bridge = readFileSync(join(ROOT, "supabase/migrations", BRIDGE), "utf8");
 await db.query(durable); await db.query(durable); await db.query(bridge); await db.query(bridge); checks.push("durable_and_bridge_apply_reapply");
 const capsule = { version: 1, nonce: "a".repeat(24), ciphertext: "b".repeat(24), tag: "c".repeat(32), issuedAt: Date.now()-100, expiresAt: Date.now()+599000 };
 const params = { Body: "QUOTE [redacted]", PropLaneRedacted: "1", MessagingServiceSid: "MGfixture" };
 let next = 0;
 async function insert(overrides = {}) {
  const data = { message_sid: `SM${String(++next).padStart(32,"0")}`, wire_from: "+12065550100", wire_to: "+12065550101", payload_digest: "a".repeat(64), params,
   runtime: "fixture", account_sid: "ACfixture", quote_capsule: capsule, quote_capsule_expires_at: new Date(capsule.expiresAt).toISOString(), ...overrides };
  const names = Object.keys(data);
  return (await db.query(`insert into public.sms_ingress_envelopes(${names.join(",")}) values(${names.map((_,i)=>`$${i+1}`).join(",")}) returning *`, Object.values(data))).rows[0];
 }
 const row = await insert(); const token = randomUUID();
 const claim = async (client, rt="fixture", ac="ACfixture", tk=token) => (await client.query("select public.sms_ingress_claim($1,$2,$3,$4) value", [row.id,tk,rt,ac])).rows[0].value;
 assert.equal(await claim(db,"production"),null); assert.equal(await claim(db,"fixture","ACwrong"),null);
 const claims = await Promise.all([claim(db),claim(other)]); assert.equal(claims.filter(Boolean).length,1);
 const claimed = claims.find(Boolean);
 for (const field of ["id","message_sid","wire_from","wire_to","payload_digest","runtime","account_sid","quote_capsule","quote_capsule_expires_at"]) assert.ok(claimed[field],field);
 assert.deepEqual(claimed.quote_capsule,capsule); assert.equal(claimed.message_sid,row.message_sid); checks.push("claim_identity_account_runtime_concurrency");
 const clear = async (tk=token,rt="fixture",ac="ACfixture") => (await db.query("select public.sms_ingress_clear_quote_capsule($1,$2,$3,$4) value",[row.id,tk,rt,ac])).rows[0].value;
 assert.equal(await clear(randomUUID()),false); assert.equal(await clear(token,"production"),false); assert.equal(await clear(token,"fixture","ACwrong"),false);
 assert.equal(await clear(),true); assert.equal((await db.query("select quote_capsule from public.sms_ingress_envelopes where id=$1",[row.id])).rows[0].quote_capsule,null); checks.push("cleanup_lease_account_runtime_guard");
 for (const bad of [{ quote_capsule: null }, { quote_capsule: {} }, { quote_capsule: { ...capsule, version: 2 } }, { quote_capsule: { ...capsule, tag: "x" } },
  { quote_capsule_expires_at: new Date(capsule.expiresAt+1).toISOString() }, { params: { Body: "hello", PropLaneRedacted:"1" } },
  { quote_capsule: { ...capsule, expiresAt: capsule.issuedAt+600001 }, quote_capsule_expires_at: new Date(capsule.issuedAt+600001).toISOString() }]) {
  await assert.rejects(insert(bad));
 }
 checks.push("shape_pair_version_tag_time_redaction_horizon_constraints");
 const terminal = await insert(); await db.query("update public.sms_ingress_envelopes set status='completed' where id=$1",[terminal.id]);
 assert.equal((await db.query("select quote_capsule from public.sms_ingress_envelopes where id=$1",[terminal.id])).rows[0].quote_capsule,null);
 const expiredCapsule = { ...capsule, issuedAt: Date.now()-600000, expiresAt: Date.now()-1 };
 const needsReview = await insert({ status:"needs_review", reason:"uncertain_effect", quote_capsule:expiredCapsule, quote_capsule_expires_at:new Date(expiredCapsule.expiresAt).toISOString() });
 const foreign = await insert({ runtime:"production", quote_capsule:expiredCapsule, quote_capsule_expires_at:new Date(expiredCapsule.expiresAt).toISOString() });
 const purge = (await db.query("select public.sms_ingress_purge_expired_quote_capsules('fixture','ACfixture') value")).rows[0].value;
 assert.equal(Number(purge),1);
 const cleaned = (await db.query("select status,reason,quote_capsule,quote_capsule_expires_at from public.sms_ingress_envelopes where id=$1",[needsReview.id])).rows[0];
 assert.deepEqual(cleaned,{ status:"needs_review", reason:"uncertain_effect", quote_capsule:null, quote_capsule_expires_at:null });
 assert.ok((await db.query("select quote_capsule from public.sms_ingress_envelopes where id=$1",[foreign.id])).rows[0].quote_capsule); checks.push("terminal_and_expired_review_cleanup_isolation");
 const checkpoint = async stage => (await db.query("select public.sms_ingress_checkpoint($1,$2,$3,null,null) value",[row.id,token,stage])).rows[0].value;
 assert.equal(await checkpoint("safe"),true); assert.equal(await checkpoint("effect"),true); assert.equal(await checkpoint("safe"),false); checks.push("generic_effect_replay_fence_preserved");
 const exhausted = await insert({ attempts:3 });
 assert.equal((await db.query("select public.sms_ingress_claim($1,$2,'fixture','ACfixture') value",[exhausted.id,randomUUID()])).rows[0].value,null);
 const backoff = await insert({ next_attempt_at:new Date(Date.now()+60000).toISOString() });
 assert.equal((await db.query("select public.sms_ingress_claim($1,$2,'fixture','ACfixture') value",[backoff.id,randomUUID()])).rows[0].value,null); checks.push("attempt_and_backoff_fences_preserved");
 for (const signature of ["sms_ingress_claim(uuid,uuid,text,text)","sms_ingress_clear_quote_capsule(uuid,uuid,text,text)","sms_ingress_purge_expired_quote_capsules(text,text)"]) {
  const acl = (await db.query("select has_function_privilege('anon',$1,'EXECUTE') anon,has_function_privilege('authenticated',$1,'EXECUTE') authenticated,has_function_privilege('service_role',$1,'EXECUTE') service",[`public.${signature}`])).rows[0];
  assert.deepEqual(acl,{anon:false,authenticated:false,service:true});
 }
 const triggerAcl = (await db.query("select has_function_privilege('service_role','public.sms_ingress_erase_terminal_quote_capsule()','EXECUTE') service")).rows[0];
 assert.equal(triggerAcl.service,false); checks.push("trigger_function_denied_despite_service_default_ACL");
 const tableAcl=(await db.query("select relrowsecurity rls,has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE') anon,has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE') authenticated from pg_class where oid='public.sms_ingress_envelopes'::regclass")).rows[0];
 assert.deepEqual(tableAcl,{rls:true,anon:false,authenticated:false}); checks.push("service_only_rpc_and_table_rls_ACL");
 console.log(JSON.stringify({ outcome:"passed",postgres:run("postgres",["--version"]).trim(),checks,providerAttempts:0,remoteDatabaseConnections:0 }));
} finally {
 await other?.end(); await db?.end(); stopCluster(owned);
}
