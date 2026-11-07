/** Publication-only forward recovery. Imports and --plan never perform operations. */
import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, rotationSourceDigest, rotationStore, rotationGithubIO, assertQuiescenceReceipt, STATE_SQL } from './signup-fixture-observer-rotate.mjs';
import { DEV_REF, OBSERVER_ROLE, REPOSITORY, SECRET_NAME, CATALOG_SQL, CONSTRAINTS_SQL, verifyInstallation, rejectUnreviewedDefiners } from './signup-fixture-observer-provision.mjs';
import { nonproductionDatabaseConfig, connectNonproductionDatabase } from './nonproduction-database.mjs';
import { connectSignupObserver } from '../signup-proof-observer.mjs';

export const ORIGINAL_SHA256 = '3bea6a4b5ec9d11b7a8852321922a5dda90ff2b0f09ded00602b96258852c67f';
const HOST = 'aws-1-us-west-2.pooler.supabase.com';
const CA_PATH = fileURLToPath(new URL('./supabase-prod-ca-2021.crt', import.meta.url));
export const HELD_SQL = `select pg_catalog.pg_backend_pid() as pid,a.backend_start::text as backend_start,current_user as role,session_user as session_role,current_database() as database from pg_catalog.pg_stat_activity a where a.pid=pg_catalog.pg_backend_pid()`;
export const INVENTORY_SQL = `select pg_has_role(current_user,'pg_read_all_stats','USAGE') as complete,(select coalesce(jsonb_agg(jsonb_build_object('pid',pid,'backend_start',backend_start::text,'role',usename,'database',datname)),'[]'::jsonb) from pg_catalog.pg_stat_activity where usename='signup_fixture_observer') as sessions`;
export const PREFLIGHT_SQL = ["select conname from pg_constraint where contype='f' limit 0", "select a.attname from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid=a.attrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and a.attnum>0 and not a.attisdropped limit 0"];
const COUNT_SQL = 'select * from signup_fixture_guard.session_counts($1::uuid)';
function assert(ok) { if (!ok) throw new Error('Retained publication prerequisite refused.'); }
export function recoverySourceDigest() { return digest(`${ORIGINAL_SHA256}\0${readFileSync(fileURLToPath(import.meta.url), 'utf8')}`); }

/** Destroy the owned socket on timeout; never leave a raced query running. */
export async function boundedQuery(client, sql, values, limit = 10000) {
  let expired = false;
  const timer = setTimeout(() => { expired = true; client.connection?.stream?.destroy(); }, limit);
  try { const result = await client.query(sql, values); assert(!expired); return result; }
  catch (error) { if (expired) throw new Error('Owned query timed out.'); throw error; }
  finally { clearTimeout(timer); }
}
async function closeClient(client) {
  if (!client) return;
  let timer, expired = false;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { expired = true; client.connection?.stream?.destroy(); reject(new Error('Owned client close timed out.')); }, 1000); });
  try { await Promise.race([client.end(), timeout]); assert(!expired); } finally { clearTimeout(timer); client.connection?.stream?.destroy(); }
}
function bounded(client) { return { query: (sql, values) => boundedQuery(client, sql, values) }; }
function tls(client) { assert(client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true); }
function identity(row) { assert(row && Number.isSafeInteger(row.pid) && row.pid > 0 && typeof row.backend_start === 'string' && Number.isFinite(Date.parse(row.backend_start)) && row.role === OBSERVER_ROLE && row.database === 'postgres'); return row; }
async function held(client) { const rows = (await client.query(HELD_SQL)).rows; assert(rows.length === 1 && rows[0].session_role === OBSERVER_ROLE); return identity(rows[0]); }
function same(a, b) { return a.pid === b.pid && a.backend_start === b.backend_start && a.role === b.role && a.database === b.database; }
async function inventory(db) {
  await db.query('select pg_catalog.pg_stat_clear_snapshot()');
  const rows = (await db.query(INVENTORY_SQL)).rows;
  assert(rows.length === 1 && rows[0].complete === true && Array.isArray(rows[0].sessions));
  return rows[0].sessions.map(identity);
}
async function exactHeld(db, captured, observe = () => undefined) { const rows = await inventory(db); observe(rows); assert(rows.length === 1 && same(rows[0], captured)); }
/** Only the first bootstrap snapshot may reflect the provider's short-lived login renewal. */
export function classifyBootstrapMetadata(previous, current, now = Date.now()) {
  assert(Array.isArray(previous?.roles) && Array.isArray(current?.roles) && Array.isArray(current?.inventory?.roles));
  const before = previous.roles.filter((role) => role.name === 'cli_login_postgres');
  const after = current.roles.filter((role) => role.name === 'cli_login_postgres');
  assert(before.length === 1 && after.length === 1);
  const stateSha256 = digest(current);
  if (digest(previous) === stateSha256) return { classification: 'unchanged', stateSha256 };
  const oldExpiry = before[0].valid_until, newExpiry = after[0].valid_until;
  const oldAt = typeof oldExpiry === 'string' ? Date.parse(oldExpiry) : NaN;
  const newAt = typeof newExpiry === 'string' ? Date.parse(newExpiry) : NaN;
  assert(Number.isFinite(now) && Number.isFinite(oldAt) && Number.isFinite(newAt) && newAt >= oldAt && newAt > now && newAt <= now + 600000);
  // Restore this one field on a copy: the full snapshot, including all other role fields, must match.
  const restored = { ...current, roles: current.roles.map((role) => role === after[0] ? { ...role, valid_until: oldExpiry } : role) };
  assert(digest(restored) === digest(previous));
  return { classification: 'cli-login-expiry-renewal', stateSha256 };
}
async function metadata(db, backup, pinned) {
  const rows = (await db.query(STATE_SQL)).rows;
  assert(rows.length === 1 && Array.isArray(rows[0].state?.roles) && Array.isArray(rows[0].state?.inventory?.roles));
  const fresh = pinned ?? classifyBootstrapMetadata(backup.prestate, rows[0].state);
  assert(digest(rows[0].state) === fresh.stateSha256);
  assert(digest((await db.query(CATALOG_SQL)).rows) === digest(backup.catalog) && digest((await db.query(CONSTRAINTS_SQL)).rows) === digest(backup.constraints));
  return fresh;
}
async function bootstrap(client) {
  tls(client); const db = bounded(client);
  await db.query('BEGIN'); await db.query('SET LOCAL ROLE postgres');
  await db.query("SET LOCAL statement_timeout='10s'"); await db.query("SET LOCAL lock_timeout='5s'");
  await db.query('select pg_catalog.pg_advisory_xact_lock(734219,118)');
  const rows = (await db.query('select current_user as role,session_user as session_role,current_database() as database')).rows;
  assert(rows.length === 1 && rows[0].role === 'postgres' && rows[0].session_role === 'cli_login_postgres' && rows[0].database === 'postgres');
  await verifyInstallation(db); await rejectUnreviewedDefiners(db, () => undefined); return db;
}
export function validateRetained(store) {
  const retained = store.read('prepared'), backup = store.read('metadata-backup');
  assert(retained.version === 1 && retained.phase === 'prepared' && retained.project === DEV_REF && retained.repository === REPOSITORY && retained.sourceSha256 === ORIGINAL_SHA256 && /^[a-f0-9]{64}$/.test(retained.password) && retained.dsn === `postgresql://${OBSERVER_ROLE}.${DEV_REF}:${retained.password}@${HOST}:5432/postgres`);
  assert(backup.prestate && Array.isArray(backup.prestate.roles) && Array.isArray(backup.prestate.inventory?.roles) && Array.isArray(backup.catalog) && backup.catalog.length > 0 && Array.isArray(backup.constraints) && digest(backup.prestate) === retained.prestateSha256);
  let previous = -Infinity;
  for (const [name, phase] of [['commit-attempt', undefined], ['local-proof', 'locally-verified'], ['publication-attempt', 'publication-attempt']]) {
    const marker = store.read(name), at = Date.parse(marker.at);
    assert(marker.sourceSha256 === ORIGINAL_SHA256 && marker.phase === phase && typeof marker.at === 'string' && Number.isFinite(at) && new Date(at).toISOString() === marker.at && at >= previous && at <= Date.now()); previous = at;
  }
  return { retained, backup, lastAt: previous, operationSha256: digest(retained) };
}
/** Parity with cleanup preflight and rotation proof, on this one held connection. */
export async function proveHeldObserver(client, backup) {
  tls(client); const db = bounded(client);
  const target = (await db.query(COUNT_SQL, ['00000000-0000-0000-0000-000000000000'])).rows;
  assert(target.length === 1 && target[0].project_ref === DEV_REF);
  for (const sql of PREFLIGHT_SQL) await db.query(sql);
  await db.query('BEGIN READ ONLY');
  try {
    await verifyInstallation(db); await rejectUnreviewedDefiners(db, () => undefined);
    const rows = (await db.query(COUNT_SQL, ['00000000-0000-4000-8000-000000000000'])).rows;
    assert(rows.length === 1 && Object.keys(rows[0]).sort().join(',') === 'project_ref,refresh_tokens,sessions' && rows[0].project_ref === DEV_REF && ['sessions', 'refresh_tokens'].every((key) => /^(0|[1-9]\d*)$/.test(String(rows[0][key]))));
    assert(digest((await db.query(CATALOG_SQL)).rows) === digest(backup.catalog) && digest((await db.query(CONSTRAINTS_SQL)).rows) === digest(backup.constraints));
    for (const sql of ['select user_id from auth.sessions limit 0', 'select user_id from auth.refresh_tokens limit 0']) {
      await db.query('SAVEPOINT denied_probe'); let denied = false;
      try { await db.query(sql); } catch (error) { denied = error?.code === '42501'; }
      await db.query('ROLLBACK TO SAVEPOINT denied_probe'); await db.query('RELEASE SAVEPOINT denied_probe'); assert(denied);
    }
  } finally { await db.query('ROLLBACK'); }
}

// Diagnostics are fixed vocabulary only. Never retain provider messages or identities.
const CLOSE_STEPS = ['lease', 'exact-held', 'identity', 'client-close', 'zero-inventory'];
const CLOSE_RESULTS = ['not-started', 'pending', 'complete'];
const SAFE_CODES = ['XX000', '42501', '57P01', '57014', '53300', '08003', '08006', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'];
function safeCode(error) { return SAFE_CODES.includes(error?.code) ? error.code : 'unknown'; }
export function safePublicationRefusal(error) {
  const phases = ['retained-records', 'bootstrap-metadata', 'owned-proof', 'own-backend-close', 'publication-gates', 'secret-publication'];
  const phase = phases.includes(error?.publicationPhase) ? error.publicationPhase : 'retained-records';
  const d = error?.closeDiagnostics;
  const diagnostics = phase === 'own-backend-close' && d ? `; close-step=${CLOSE_STEPS.includes(d.step) ? d.step : 'unknown'}; close-result=${CLOSE_RESULTS.includes(d.closeResult) ? d.closeResult : 'unknown'}; error-code=${SAFE_CODES.includes(d.errorCode) ? d.errorCode : 'unknown'}; event-source=${['admin', 'observer'].includes(d.eventSource) ? d.eventSource : 'none'}; inventory=${['zero', 'same-captured', 'different', 'additional'].includes(d.inventory) ? d.inventory : 'unknown'}` : '';
  return `Retained observer publication pending; phase=${phase}${diagnostics}. Preserve private records and exclusion; only same-value full re-proof is permitted.`;
}

/** Offline dependencies belong only to this helper; CLI always uses the fixed real IO. */
export async function publishRetainedObserver(options, dependencies = {}) {
  assert(rotationSourceDigest() === ORIGINAL_SHA256 && options.originalSha256 === ORIGINAL_SHA256 && options.reviewedSha256 === recoverySourceDigest() && options.apiUrl === `https://${DEV_REF}.supabase.co`);
  const store = (dependencies.store ?? rotationStore)(options.directory, true);
  let phase = 'retained-records';
  const closeDiagnostics = { step: 'lease', closeResult: 'not-started', errorCode: 'unknown', eventSource: 'none', inventory: 'unknown' };
  const event = (source, error) => { closeDiagnostics.eventSource = source; closeDiagnostics.errorCode = safeCode(error); };
  let admin, observer, eventFailure = false, normalClose = false;
  const onError = (error) => { event('observer', error); eventFailure = true; };
  const onEnd = () => { closeDiagnostics.eventSource = 'observer'; if (!normalClose) eventFailure = true; };
  const secrets = dependencies.secrets ?? rotationGithubIO();
  const lease = dependencies.quiescence ?? ((minimum = 0) => assertQuiescenceReceipt(options.quiescencePath, options.reviewedSha256, Date.now(), minimum));
  try {
    const { retained, backup, operationSha256, lastAt } = validateRetained(store);
    const binding = { sourceSha256: options.reviewedSha256, originalSha256: ORIGINAL_SHA256, operationSha256, project: DEV_REF, repository: REPOSITORY };
    const pending = { published: true, localVerified: true, complete: false, pending: 'fresh-exact-candidate-ci-proof', project: DEV_REF };
    if (store.has('published')) {
      const marker = store.read('published'), at = Date.parse(marker.at);
      assert(marker.sourceSha256 === ORIGINAL_SHA256 && marker.phase === 'published-ci-proof-pending' && Number.isFinite(at) && new Date(at).toISOString() === marker.at && at >= lastAt && at <= Date.now()); return pending;
    }
    if (store.has('recovery-published')) {
      const marker = store.read('recovery-published'), at = Date.parse(marker.at);
      assert(Object.entries(binding).every(([key, value]) => marker[key] === value) && marker.phase === 'published-ci-proof-pending' && Number.isFinite(at) && new Date(at).toISOString() === marker.at && at >= lastAt && at <= Date.now()); return pending;
    }
    phase = 'bootstrap-metadata';
    await lease(); await secrets.assertExisting(); await secrets.assertQuiescent(); await lease();
    const config = await (dependencies.getConfig ?? nonproductionDatabaseConfig)(DEV_REF);
    assert(config.host === HOST && config.port === 5432 && config.database === 'postgres' && config.user === `cli_login_postgres.${DEV_REF}` && typeof config.password === 'string' && config.password.length > 0);
    admin = await (dependencies.connect ?? connectNonproductionDatabase)({ ...config, ssl: { rejectUnauthorized: true, ca: readFileSync(CA_PATH, 'utf8') }, connectionTimeoutMillis: 10000, query_timeout: 10000 });
    admin.on('error', (error) => { event('admin', error); eventFailure = true; });
    const db = await bootstrap(admin), bootstrapMetadata = await metadata(db, backup); assert((await inventory(db)).length <= 1);
    phase = 'owned-proof';
    const ca = lstatSync(CA_PATH); assert(ca.isFile() && !ca.isSymbolicLink());
    observer = await (dependencies.connectObserver ?? connectSignupObserver)({ NEXT_PUBLIC_SUPABASE_URL: options.apiUrl, SIGNUP_PROOF_OBSERVER_URL: retained.dsn, SUPABASE_DB_SSL_CA_FILE: CA_PATH });
    observer.on('error', onError); observer.on('end', onEnd);
    const restricted = bounded(observer), captured = await held(restricted);
    await exactHeld(db, captured); assert(!eventFailure);
    await proveHeldObserver(observer, backup); assert(!eventFailure && same(await held(restricted), captured));
    phase = 'own-backend-close';
    const observe = (rows) => { closeDiagnostics.inventory = rows.length === 0 ? 'zero' : rows.length > 1 ? 'additional' : same(rows[0], captured) ? 'same-captured' : 'different'; };
    closeDiagnostics.step = 'lease';
    await lease();
    closeDiagnostics.step = 'exact-held';
    await exactHeld(db, captured, observe);
    closeDiagnostics.step = 'identity';
    assert(!eventFailure && same(await held(restricted), captured));
    closeDiagnostics.step = 'client-close';
    normalClose = true; closeDiagnostics.closeResult = 'pending';
    await closeClient(observer); observer = undefined;
    closeDiagnostics.closeResult = 'complete';
    assert(!eventFailure);
    closeDiagnostics.step = 'zero-inventory';
    // Supavisor may retain this same physical backend after normal client close.
    // Only fresh complete zero inventory proves drainage, never the end event.
    const deadline = performance.now() + 150000;
    const drainDb = { query: async (sql, values) => {
      const remaining = deadline - performance.now(); assert(remaining > 0);
      const result = await boundedQuery(admin, sql, values, Math.min(10000, remaining));
      assert(performance.now() < deadline); return result;
    } };
    for (;;) {
      await lease(); assert(!eventFailure && performance.now() < deadline);
      const rows = await inventory(drainDb); observe(rows);
      assert(!eventFailure && performance.now() < deadline);
      if (rows.length === 0) break;
      assert(rows.length === 1 && same(rows[0], captured));
      await new Promise((done) => setTimeout(done, Math.min(1000, deadline - performance.now())));
    }
    phase = 'publication-gates';
    await metadata(db, backup, bootstrapMetadata); await verifyInstallation(db); await rejectUnreviewedDefiners(db, () => undefined);
    await secrets.assertQuiescent(); await secrets.assertExisting(); await lease();
    store.write(`recovery-attempt-${Date.now()}-${process.pid}`, { ...binding, bootstrapMetadata, phase: 'recovery-proof-publication-attempt', at: new Date().toISOString() });
    assert((await inventory(db)).length === 0 && !eventFailure);
    await db.query('ROLLBACK'); await lease(35000); assert(!eventFailure);
    phase = 'secret-publication';
    await secrets.publish(retained.dsn); assert(!eventFailure);
    store.write('recovery-published', { ...binding, phase: 'published-ci-proof-pending', at: new Date().toISOString() });
    return pending;
  } catch (error) {
    if (closeDiagnostics.errorCode === 'unknown') closeDiagnostics.errorCode = safeCode(error);
    const refusal = Object.assign(new Error(), { publicationPhase: phase, closeDiagnostics: { ...closeDiagnostics } });
    refusal.message = safePublicationRefusal(refusal); throw refusal;
  }
  finally {
    await closeClient(observer).catch(() => undefined);
    if (admin) { await boundedQuery(admin, 'ROLLBACK').catch(() => undefined); await closeClient(admin).catch(() => undefined); }
    store.close();
  }
}
async function main() {
  const args = process.argv.slice(2);
  if (!args.length || (args.length === 1 && args[0] === '--plan')) { console.log(JSON.stringify({ project: DEV_REF, repository: REPOSITORY, secret: SECRET_NAME, originalSha256: ORIGINAL_SHA256, reviewedSha256: recoverySourceDigest(), publicationOnly: true, ciProofRequired: true })); return; }
  assert(args.length === 9 && args[0] === '--publish-retained' && args[1] === '--reviewed-sha256' && args[3] === '--original-sha256' && args[5] === '--directory' && args[7] === '--quiescence');
  console.log(JSON.stringify(await publishRetainedObserver({ reviewedSha256: args[2], originalSha256: args[4], directory: args[6], quiescencePath: args[8], apiUrl: process.env.NEXT_PUBLIC_SUPABASE_URL })));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(safePublicationRefusal(error)); process.exitCode = 1; });
