/** Credential-only DEV rotation. No execution on import; retained value is forward recovery. */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { nonproductionDatabaseConfig, connectNonproductionDatabase } from './nonproduction-database.mjs';
import { DEV_REF, OBSERVER_ROLE, REPOSITORY, SECRET_NAME, INVENTORY_SQL, CATALOG_SQL, CONSTRAINTS_SQL, verifyInstallation, rejectUnreviewedDefiners } from './signup-fixture-observer-provision.mjs';
import { connectSignupObserver } from '../signup-proof-observer.mjs';
import { preflightSignupCleanup } from '../signup-proof-cleanup-preflight.mjs';

const HOST = 'aws-1-us-west-2.pooler.supabase.com';
const CA_PATH = fileURLToPath(new URL('./supabase-prod-ca-2021.crt', import.meta.url));
const IDENTITY = 'select current_user as role,session_user as session_role,current_database() as database';
const GITHUB_TIMEOUT_MS = 30000;
const PUBLICATION_LEASE_MS = GITHUB_TIMEOUT_MS + 5000;
// pg_roles exposes metadata only. Never inspect pg_authid or password hashes.
export const STATE_SQL = `select jsonb_build_object(
 'inventory', (${INVENTORY_SQL}),
 'roles', (select jsonb_agg(jsonb_build_object('name',rolname,'super',rolsuper,'inherit',rolinherit,'create_role',rolcreaterole,'create_db',rolcreatedb,'login',rolcanlogin,'replication',rolreplication,'bypass',rolbypassrls,'limit',rolconnlimit,'valid_until',rolvaliduntil,'config',rolconfig)) from pg_catalog.pg_roles),
 'memberships', (select jsonb_agg(to_jsonb(m)) from pg_catalog.pg_auth_members m),
 'relations', (select jsonb_agg(jsonb_build_object('oid',oid,'owner',relowner,'acl',relacl)) from pg_catalog.pg_class),
 'columns', (select jsonb_agg(jsonb_build_object('relation',attrelid,'number',attnum,'acl',attacl)) from pg_catalog.pg_attribute where attacl is not null),
 'schemas', (select jsonb_agg(jsonb_build_object('oid',oid,'owner',nspowner,'acl',nspacl)) from pg_catalog.pg_namespace),
 'routines', (select jsonb_agg(jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'body',prosrc,'config',proconfig,'definer',prosecdef)) from pg_catalog.pg_proc)
) as state`;
export const SESSIONS_SQL = `select pg_has_role(current_user,'pg_read_all_stats','USAGE') as complete,
 (select count(*)::text from pg_catalog.pg_stat_activity where usename='signup_fixture_observer') as sessions`;
function assert(ok, message = 'Observer rotation prerequisite refused.') { if (!ok) throw new Error(message); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export function digest(value) { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex'); }
export function rotationSourceDigest() {
  return digest(['./signup-fixture-observer-rotate.mjs', './signup-fixture-observer-provision.mjs', './nonproduction-database.mjs', '../signup-proof-observer.mjs', '../signup-proof-cleanup-preflight.mjs', './supabase-prod-ca-2021.crt'].map((name) => readFileSync(new URL(name, import.meta.url), 'utf8')).join('\0'));
}
function privatePath(path, directory = false) {
  assert(isAbsolute(path) && realpathSync(path) === path, 'Canonical private path required.');
  const info = lstatSync(path);
  assert(info.uid === process.getuid() && !info.isSymbolicLink() && (directory ? info.isDirectory() : info.isFile()) && (info.mode & 0o777) === (directory ? 0o700 : 0o600), 'Owner-only private path required.');
}
function durableWrite(path, content) {
  privatePath(dirname(path), true);
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  privatePath(path);
  assert(readFileSync(path, 'utf8') === content, 'Retained bytes unavailable.');
  syncDirectory(dirname(path));
}
export function syncDirectory(directory) {
  const handle = openSync(directory, 'r');
  try { fsyncSync(handle); } finally { closeSync(handle); }
}
export function rotationStore(directory, resume, sync = syncDirectory) {
  assert(isAbsolute(directory) && resolve(directory) === directory);
  privatePath(dirname(directory), true);
  if (!resume) mkdirSync(directory, { mode: 0o700 });
  privatePath(directory, true);
  // File+child fsync cannot durably publish the newly created directory entry in its parent.
  sync(directory); sync(dirname(directory));
  const lock = `${directory}/owner.lock`;
  durableWrite(lock, JSON.stringify({ pid: process.pid }));
  return {
    has(name) { return existsSync(`${directory}/${name}.json`); },
    read(name) { const path = `${directory}/${name}.json`; privatePath(path); return JSON.parse(readFileSync(path, 'utf8')); },
    write(name, value) { durableWrite(`${directory}/${name}.json`, JSON.stringify(value)); },
    close() { unlinkSync(lock); },
  };
}
export function rotationGithubIO(run = spawnSync) {
  function gh(args, input) {
    const result = run('gh', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: GITHUB_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
    assert(!result.error && result.status === 0, 'GitHub rotation operation pending.');
    return result.stdout;
  }
  return {
    assertExisting() {
      const rows = JSON.parse(gh(['secret', 'list', '--repo', REPOSITORY, '--json', 'name,updatedAt']));
      assert(Array.isArray(rows) && rows.filter((row) => row.name === SECRET_NAME && typeof row.updatedAt === 'string').length === 1, 'Existing observer secret metadata required.');
    },
    assertQuiescent() {
      // Zero-only status queries avoid enumerating history or GitHub's filtered-result ceiling.
      for (const status of ['in_progress', 'queued', 'requested', 'waiting', 'pending']) {
        const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${REPOSITORY}/actions/runs?status=${status}&per_page=100`]));
        assert(Array.isArray(pages) && pages.length > 0 && pages.every((page) => page && Number.isSafeInteger(page.total_count) && page.total_count >= 0 && Array.isArray(page.workflow_runs)), 'Complete GitHub run inventory required.');
        assert(pages.every((page) => page.total_count === 0 && page.workflow_runs.length === 0), 'CI consumers must be quiescent.');
      }
    },
    publish(dsn) { gh(['secret', 'set', SECRET_NAME, '--repo', REPOSITORY], dsn); },
  };
}
export function assertQuiescenceReceipt(path, sourceSha256, now = Date.now(), minimumRemainingMs = 0) {
  privatePath(dirname(path), true); privatePath(path);
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  assert(receipt.project === DEV_REF && receipt.repository === REPOSITORY && receipt.sourceSha256 === sourceSha256 && receipt.localConsumersExcluded === true && receipt.scheduledConsumersExcluded === true && /^[a-f0-9]{64}$/.test(receipt.consumerInventorySha256), 'Root consumer inventory attestation required.');
  assert(Number.isSafeInteger(receipt.issuedAt) && Number.isSafeInteger(receipt.expiresAt) && receipt.issuedAt <= now && receipt.issuedAt >= now - 60000 && receipt.expiresAt > now && receipt.expiresAt <= receipt.issuedAt + 60000 && receipt.expiresAt - now >= minimumRemainingMs, 'Fresh root quiescence lease required.');
}
async function zeroSessions(db) {
  // pg_stat_activity snapshots are cached inside a transaction until explicitly cleared.
  await db.query('select pg_catalog.pg_stat_clear_snapshot()');
  const rows = (await db.query(SESSIONS_SQL)).rows;
  assert(rows.length === 1 && rows[0].complete === true && rows[0].sessions === '0', 'Complete zero-session observer inventory required.');
}
async function state(db) {
  const rows = (await db.query(STATE_SQL)).rows;
  assert(rows.length === 1 && rows[0].state && Array.isArray(rows[0].state.roles) && Array.isArray(rows[0].state.inventory?.roles), 'Complete metadata snapshot required.');
  return rows[0].state;
}
async function bootstrap(db) {
  assert(db.connection?.stream?.encrypted === true && db.connection.stream.authorized === true, 'Verified bootstrap TLS required.');
  await db.query('BEGIN');
  await db.query('SET LOCAL ROLE postgres');
  await db.query("SET LOCAL statement_timeout='10s'");
  await db.query("SET LOCAL lock_timeout='5s'");
  await db.query('select pg_catalog.pg_advisory_xact_lock(734219,118)');
  const rows = (await db.query(IDENTITY)).rows;
  assert(rows.length === 1 && rows[0].role === 'postgres' && rows[0].session_role === 'cli_login_postgres' && rows[0].database === 'postgres', 'Bootstrap identity refused.');
  await verifyInstallation(db); await rejectUnreviewedDefiners(db, () => undefined);
}
export async function proveRotatedObserver(env, expectedCatalog, expectedConstraints, connect = connectSignupObserver) {
  await preflightSignupCleanup(env, connect);
  const observer = await connect(env);
  try {
    await observer.query('BEGIN READ ONLY');
    const rows = (await observer.query('select * from signup_fixture_guard.session_counts($1::uuid)', ['00000000-0000-4000-8000-000000000000'])).rows;
    assert(rows.length === 1 && Object.keys(rows[0]).sort().join(',') === 'project_ref,refresh_tokens,sessions' && rows[0].project_ref === DEV_REF && ['sessions', 'refresh_tokens'].every((key) => /^(0|[1-9]\d*)$/.test(String(rows[0][key]))), 'Count-only observer proof refused.');
    assert(digest((await observer.query(CATALOG_SQL)).rows) === digest(expectedCatalog) && digest((await observer.query(CONSTRAINTS_SQL)).rows) === digest(expectedConstraints), 'Observer catalog proof refused.');
    for (const sql of ['select user_id from auth.sessions limit 0', 'select user_id from auth.refresh_tokens limit 0']) {
      await observer.query('SAVEPOINT denied_probe');
      let denied = false;
      try { await observer.query(sql); } catch (error) { denied = error?.code === '42501'; }
      await observer.query('ROLLBACK TO SAVEPOINT denied_probe'); await observer.query('RELEASE SAVEPOINT denied_probe');
      assert(denied, 'Direct Auth read must remain denied.');
    }
  } finally { await observer.query('ROLLBACK').catch(() => undefined); await observer.end(); }
}

/** Offline injection is for tests only. CLI never accepts a connector or SQL identifier. */
export async function rotateObserver(options, dependencies = {}) {
  assert(['apply', 'resume'].includes(options.phase) && options.reviewedSha256 === rotationSourceDigest() && options.apiUrl === `https://${DEV_REF}.supabase.co`, 'Reviewed exact DEV rotation required.');
  const secrets = dependencies.secrets ?? rotationGithubIO();
  const quiescence = dependencies.quiescence ?? ((minimum = 0) => assertQuiescenceReceipt(options.quiescencePath, options.reviewedSha256, Date.now(), minimum));
  const store = (dependencies.store ?? rotationStore)(options.directory, options.phase === 'resume');
  let db;
  try {
    await secrets.assertExisting(); await secrets.assertQuiescent(); await quiescence();
    const config = await (dependencies.getConfig ?? nonproductionDatabaseConfig)(DEV_REF);
    assert(config.host === HOST && config.port === 5432 && config.database === 'postgres' && config.user === `cli_login_postgres.${DEV_REF}` && typeof config.password === 'string' && config.password.length > 0, 'DEV bootstrap connector refused.');
    db = await (dependencies.connect ?? connectNonproductionDatabase)({ ...config, ssl: { rejectUnauthorized: true, ca: readFileSync(CA_PATH, 'utf8') }, connectionTimeoutMillis: 10000 });
    await bootstrap(db); await zeroSessions(db);
    const before = await state(db);
    const catalog = (await db.query(CATALOG_SQL)).rows;
    const constraints = (await db.query(CONSTRAINTS_SQL)).rows;
    assert(catalog.length > 0 && Array.isArray(constraints));
    let retained;
    if (options.phase === 'apply') {
      const password = randomBytes(32).toString('hex');
      retained = { version: 1, phase: 'prepared', project: DEV_REF, repository: REPOSITORY, sourceSha256: options.reviewedSha256, prestateSha256: digest(before), password, dsn: `postgresql://${OBSERVER_ROLE}.${DEV_REF}:${password}@${HOST}:5432/postgres` };
      store.write('prepared', retained);
      store.write('metadata-backup', { prestate: before, catalog, constraints });
    } else {
      retained = store.read('prepared');
      assert(retained.version === 1 && retained.project === DEV_REF && retained.repository === REPOSITORY && retained.sourceSha256 === options.reviewedSha256 && retained.prestateSha256 === digest(before) && /^[a-f0-9]{64}$/.test(retained.password) && retained.dsn === `postgresql://${OBSERVER_ROLE}.${DEV_REF}:${retained.password}@${HOST}:5432/postgres`, 'Retained rotation prestate refused.');
      const backup = store.read('metadata-backup');
      assert(digest(backup.prestate) === retained.prestateSha256 && digest(backup.catalog) === digest(catalog) && digest(backup.constraints) === digest(constraints), 'Retained catalog refused.');
    }
    const env = { NEXT_PUBLIC_SUPABASE_URL: options.apiUrl, SIGNUP_PROOF_OBSERVER_URL: retained.dsn, SUPABASE_DB_SSL_CA_FILE: CA_PATH };
    let alreadyLive = false;
    if (options.phase === 'resume' && store.has('commit-attempt')) {
      // A failed login is ambiguous. Resume may only confirm the retained value, never guess rollback.
      await db.query('ROLLBACK');
      await (dependencies.prove ?? proveRotatedObserver)(env, catalog, constraints);
      alreadyLive = true;
      await bootstrap(db);
      assert(digest(await state(db)) === retained.prestateSha256, 'Resume metadata drift refused.');
    }
    await secrets.assertExisting(); await secrets.assertQuiescent(); await zeroSessions(db); await quiescence(15000);
    if (!alreadyLive) {
      // Fixed identifier and generated hex only. Driver errors and SQL are never emitted.
      await db.query(`ALTER ROLE signup_fixture_observer PASSWORD '${retained.password}'`);
      // Durable marker precedes sending COMMIT. Without it, a disconnected transaction cannot commit.
      store.write('commit-attempt', { sourceSha256: options.reviewedSha256, at: new Date().toISOString() });
    }
    // Durable marker IO and external reads may consume the lease; reobserve before COMMIT.
    await zeroSessions(db); await quiescence(10000);
    await db.query('COMMIT');
    await bootstrap(db);
    assert(digest(await state(db)) === retained.prestateSha256, 'Non-password metadata changed.');
    await db.query('ROLLBACK');
    await (dependencies.prove ?? proveRotatedObserver)(env, catalog, constraints);
    if (!store.has('local-proof')) store.write('local-proof', { phase: 'locally-verified', sourceSha256: options.reviewedSha256, at: new Date().toISOString() });
    await bootstrap(db);
    assert(digest(await state(db)) === retained.prestateSha256, 'Publication metadata drift refused.');
    await secrets.assertQuiescent(); await secrets.assertExisting();
    if (!store.has('publication-attempt')) store.write('publication-attempt', { phase: 'publication-attempt', sourceSha256: options.reviewedSha256, at: new Date().toISOString() });
    await zeroSessions(db); await db.query('ROLLBACK');
    // The lease must cover the entire bounded 30-second child call plus scheduling headroom.
    await quiescence(PUBLICATION_LEASE_MS);
    await secrets.publish(retained.dsn);
    if (!store.has('published')) store.write('published', { phase: 'published-ci-proof-pending', sourceSha256: options.reviewedSha256, at: new Date().toISOString() });
    // Repeated publication is idempotent. CI consumption is deliberately a separate root-owned gate.
    return { project: DEV_REF, role: OBSERVER_ROLE, localVerified: true, published: true, complete: false, pending: 'fresh-exact-candidate-ci-proof', directory: options.directory };
  } catch {
    await db?.query('ROLLBACK').catch(() => undefined);
    throw new Error('Observer rotation pending. Preserve the private operation directory; resume only the same retained value after quiescence. No permissions or secret deletion were attempted.');
  } finally { await db?.end().catch(() => undefined); store.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === '--plan')) {
    console.log(JSON.stringify({ project: DEV_REF, repository: REPOSITORY, secret: SECRET_NAME, role: OBSERVER_ROLE, reviewedSha256: rotationSourceDigest(), credentialOnly: true, resume: 'retained-value-proof-only', ciProofRequired: true })); return;
  }
  assert(args.length === 7 && ['--apply', '--resume'].includes(args[0]) && args[1] === '--reviewed-sha256' && args[3] === '--directory' && args[5] === '--quiescence', 'Use --plan or --apply/--resume --reviewed-sha256 <digest> --directory <new/private-operation-directory> --quiescence <fresh-private-root-attestation>.');
  console.log(JSON.stringify(await rotateObserver({ phase: args[0].slice(2), reviewedSha256: args[2], directory: args[4], quiescencePath: args[6], apiUrl: process.env.NEXT_PUBLIC_SUPABASE_URL })));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Observer rotation pending. Preserve private recovery state. Credentials and driver diagnostics are suppressed.'); process.exitCode = 1; });
