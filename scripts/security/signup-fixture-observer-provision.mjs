/** Initial DEV installation only. No network activity on import or plan. Never upload a PAT. */
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nonproductionDatabaseConfig, connectNonproductionDatabase } from './nonproduction-database.mjs';

export const DEV_REF = 'emstjswhotsnyksqhqyf';
export const OBSERVER_ROLE = 'signup_fixture_observer';
export const REPOSITORY = 'PrakritR/PropLane';
export const SECRET_NAME = 'TEST_SIGNUP_PROOF_OBSERVER_URL';
const HOST = 'aws-1-us-west-2.pooler.supabase.com';
const CA = readFileSync(new URL('./supabase-prod-ca-2021.crt', import.meta.url), 'utf8');
export const OBSERVER_FUNCTION_BODY = `
  SELECT '${DEV_REF}'::text,
    (SELECT count(*) FROM auth.sessions s WHERE s.user_id = p_actor_id),
    (SELECT count(*) FROM auth.refresh_tokens r WHERE r.user_id::text = p_actor_id::text);
`;
export const OBSERVER_SETUP_SQL = `
CREATE ROLE signup_fixture_observer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;
ALTER ROLE signup_fixture_observer SET default_transaction_read_only = on;
ALTER ROLE signup_fixture_observer SET statement_timeout = '10s';
ALTER ROLE signup_fixture_observer SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE signup_fixture_observer SET search_path = pg_catalog;
GRANT CONNECT ON DATABASE postgres TO signup_fixture_observer;
CREATE SCHEMA signup_fixture_guard AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA signup_fixture_guard FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION signup_fixture_guard.session_counts(p_actor_id uuid)
RETURNS TABLE(project_ref text, sessions bigint, refresh_tokens bigint)
LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = '' SET row_security = off
AS $guard$${OBSERVER_FUNCTION_BODY}$guard$;
ALTER FUNCTION signup_fixture_guard.session_counts(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION signup_fixture_guard.session_counts(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA signup_fixture_guard TO signup_fixture_observer;
GRANT EXECUTE ON FUNCTION signup_fixture_guard.session_counts(uuid) TO signup_fixture_observer;
`;

// Only catalog metadata. Never pg_authid, Auth rows, tokens, passwords or rolpassword.
export const INVENTORY_SQL = `select jsonb_build_object(
 'roles', (select coalesce(jsonb_agg(jsonb_build_object('name',rolname,'super',rolsuper,'inherit',rolinherit,'create_role',rolcreaterole,'create_db',rolcreatedb,'login',rolcanlogin,'replication',rolreplication,'bypass',rolbypassrls,'limit',rolconnlimit,'config',rolconfig)), '[]'::jsonb) from pg_catalog.pg_roles where rolname in ('signup_fixture_observer','postgres','anon','authenticated','service_role')),
 'memberships', (select coalesce(jsonb_agg(jsonb_build_object('role',r.rolname,'member',m.rolname,'admin',a.admin_option,'inherit',(to_jsonb(a)->>'inherit_option')::boolean,'set',(to_jsonb(a)->>'set_option')::boolean)), '[]'::jsonb) from pg_catalog.pg_auth_members a join pg_catalog.pg_roles r on r.oid=a.roleid join pg_catalog.pg_roles m on m.oid=a.member where r.rolname='signup_fixture_observer' or m.rolname='signup_fixture_observer'),
 'schema', (select jsonb_build_object('name',nspname,'owner',pg_catalog.pg_get_userbyid(nspowner),'acl',nspacl::text) from pg_catalog.pg_namespace where nspname='signup_fixture_guard'),
 'functions', (select coalesce(jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',pg_catalog.pg_get_userbyid(p.proowner),'definition',pg_catalog.pg_get_functiondef(p.oid),'acl',p.proacl::text)), '[]'::jsonb) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='signup_fixture_guard'),
 'database_acl', (select datacl::text from pg_catalog.pg_database where datname='postgres')
) as inventory`;
export const CATALOG_SQL = `select n.nspname as schema,c.relname as table_name,c.relkind,a.attname as column_name,a.attnum
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
join pg_catalog.pg_attribute a on a.attrelid=c.oid
where n.nspname='public' and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped
order by n.nspname,c.relname,a.attnum`;
export const CONSTRAINTS_SQL = `select k.oid::text as constraint_oid,k.conname,k.contype,k.conrelid::text as relation_oid,k.confrelid::text as target_oid,k.conkey,k.confkey
from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid=k.conrelid
join pg_catalog.pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind in ('r','p') order by k.oid`;
const IDENTITY_SQL = 'select current_user as role,session_user as session_role,current_database() as database';
function assert(condition, message) { if (!condition) throw new Error(message); }
export function sourceDigest() { return createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'); }
export function assertApplyOptions(options) {
  assert(options.ref === DEV_REF && options.repository === REPOSITORY, 'Exact DEV target and repository required.');
  assert(options.apiUrl === `https://${DEV_REF}.supabase.co`, 'Exact DEV API URL required.');
  assert(options.reviewedSha256 === sourceDigest(), 'Reviewed source digest required.');
  assert(typeof options.backupPath === 'string' && options.backupPath === resolve(options.backupPath), 'Absolute encrypted backup path required.');
  assert(typeof options.backupKey === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(options.backupKey) && Buffer.from(options.backupKey, 'base64').length === 32, 'Independent 32-byte base64 backup encryption key required.');
}
function assertConfig(config) {
  assert(config?.host === HOST && config.port === 5432 && config.database === 'postgres' && config.user === `cli_login_postgres.${DEV_REF}` && typeof config.password === 'string' && config.password.length > 0, 'DEV bootstrap connector refused.');
}
function verifiedTls(db) { assert(db.connection?.stream?.encrypted === true && db.connection?.stream?.authorized === true, 'Verified TLS required.'); }
function encryptBackup(inventory, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  cipher.setAAD(Buffer.from(`signup-observer:${DEV_REF}:v1`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ version: 1, project: DEV_REF, createdAt: new Date().toISOString(), inventory })), cipher.final()]);
  return JSON.stringify({ version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
}
export function githubSecretIO(run = spawnSync) {
  function gh(args, input) {
    const result = run('gh', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
    assert(!result.error && result.status === 0, 'GitHub secret operation failed.');
    return result.stdout;
  }
  return {
    assertAbsent() {
      let list;
      try { list = JSON.parse(gh(['secret', 'list', '--repo', REPOSITORY, '--json', 'name'])); } catch { throw new Error('GitHub secret inventory failed.'); }
      assert(Array.isArray(list) && list.every((row) => typeof row.name === 'string') && !list.some((row) => row.name === SECRET_NAME), 'Existing observer secret requires separate rotation review.');
    },
    publish(dsn) { gh(['secret', 'set', SECRET_NAME, '--repo', REPOSITORY], dsn); },
    remove() { gh(['secret', 'delete', SECRET_NAME, '--repo', REPOSITORY]); },
  };
}
async function inventory(db) {
  const rows = (await db.query(INVENTORY_SQL)).rows;
  assert(rows.length === 1 && rows[0].inventory && Array.isArray(rows[0].inventory.roles) && Array.isArray(rows[0].inventory.memberships) && Array.isArray(rows[0].inventory.functions), 'Catalog inventory incomplete.');
  return rows[0].inventory;
}
function absent(state) {
  assert(!state.roles.some((r) => r.name === OBSERVER_ROLE) && state.schema === null && state.functions.length === 0 && state.memberships.length === 0, 'Existing observer objects require separate drift or rotation review.');
}
/** PG16+ automatically grants the non-superuser creator ADMIN, INHERIT FALSE, SET FALSE.
 * This safe postgres-admin-of-observer direction grants the observer no privileges.
 * https://www.postgresql.org/docs/16/role-attributes.html
 */
export function observerMembershipsMeetBoundary(rows) {
  return Array.isArray(rows) && (rows.length === 0 || (rows.length === 1 &&
    rows[0].role === OBSERVER_ROLE && rows[0].member === 'postgres' &&
    rows[0].admin === true && rows[0].inherit === false && rows[0].set === false));
}
export async function verifyInstallation(db, expectedLogin = true) {
  const check = (await db.query(`select
    (select count(*)=1 from pg_catalog.pg_namespace where nspname='signup_fixture_guard' and nspowner='postgres'::regrole) as schema_ok,
    (select count(*)=1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='signup_fixture_guard') as only_function,
    (select p.prosrc=$1 and p.proowner='postgres'::regrole and p.prosecdef and p.proisstrict and p.provolatile='s' and p.prolang=(select oid from pg_catalog.pg_language where lanname='sql') and p.proconfig @> array['search_path=""','row_security=off'] and cardinality(p.proconfig)=2 and pg_catalog.pg_get_function_result(p.oid)='TABLE(project_ref text, sessions bigint, refresh_tokens bigint)' from pg_catalog.pg_proc p where p.oid='signup_fixture_guard.session_counts(uuid)'::regprocedure) as function_ok,
    coalesce((select jsonb_agg(jsonb_build_object('role',r.rolname,'member',m.rolname,'admin',a.admin_option,'inherit',(to_jsonb(a)->>'inherit_option')::boolean,'set',(to_jsonb(a)->>'set_option')::boolean)) from pg_catalog.pg_auth_members a join pg_catalog.pg_roles r on r.oid=a.roleid join pg_catalog.pg_roles m on m.oid=a.member where a.member='signup_fixture_observer'::regrole or a.roleid='signup_fixture_observer'::regrole),'[]'::jsonb) as memberships,
    (select not rolsuper and not rolcreatedb and not rolcreaterole and not rolinherit and not rolreplication and not rolbypassrls and rolconnlimit=3 and rolcanlogin=$2 and rolconfig @> array['default_transaction_read_only=on','statement_timeout=10s','idle_in_transaction_session_timeout=15s','search_path=pg_catalog'] and cardinality(rolconfig)=4 from pg_catalog.pg_roles where rolname='signup_fixture_observer') as role_ok,
    not exists(select 1 from unnest(array['anon','authenticated','service_role']) r where has_function_privilege(r,'signup_fixture_guard.session_counts(uuid)','EXECUTE') or has_schema_privilege(r,'signup_fixture_guard','USAGE')) as api_denied,
    not exists(select 1 from pg_catalog.pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x where p.oid='signup_fixture_guard.session_counts(uuid)'::regprocedure and (x.grantee not in ('postgres'::regrole::oid,'signup_fixture_observer'::regrole::oid) or x.is_grantable)) as function_acl_ok,
    not exists(select 1 from pg_catalog.pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) x where n.nspname='signup_fixture_guard' and x.grantee not in ('postgres'::regrole::oid,'signup_fixture_observer'::regrole::oid)) as schema_acl_ok,
    not exists(select 1 from pg_catalog.pg_db_role_setting s cross join lateral unnest(s.setconfig) v where v like 'pgrst.db_schemas=%' and position('signup_fixture_guard' in v)>0) and position('signup_fixture_guard' in coalesce(current_setting('pgrst.db_schemas',true),''))=0 as unexposed,
    has_function_privilege('signup_fixture_observer','signup_fixture_guard.session_counts(uuid)','EXECUTE') and has_schema_privilege('signup_fixture_observer','signup_fixture_guard','USAGE') and not has_schema_privilege('signup_fixture_observer','signup_fixture_guard','CREATE') as observer_access,
    not exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) v where n.nspname in ('public','auth') and c.relkind in ('r','p','v','m','f') and has_table_privilege('signup_fixture_observer',c.oid,v)) and not exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace cross join unnest(array['SELECT','INSERT','UPDATE','REFERENCES']) v where n.nspname in ('public','auth') and c.relkind in ('r','p','v','m','f') and has_any_column_privilege('signup_fixture_observer',c.oid,v)) as tables_denied,
    not exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','auth') and c.relkind='S' and (has_sequence_privilege('signup_fixture_observer',c.oid,'USAGE') or has_sequence_privilege('signup_fixture_observer',c.oid,'SELECT') or has_sequence_privilege('signup_fixture_observer',c.oid,'UPDATE'))) as sequences_denied`, [OBSERVER_FUNCTION_BODY, expectedLogin])).rows;
  assert(check.length === 1, 'Observer privilege boundary refused.');
  const { memberships, ...checks } = check[0];
  assert(Object.keys(checks).length === 11 && Object.values(checks).every((value) => value === true) && observerMembershipsMeetBoundary(memberships), 'Observer privilege boundary refused.');
}
export const CALLABLE_DEFINERS_SQL = String.raw`select n.nspname as schema_name,p.proname as routine_name,p.provolatile as volatility,
 case when p.prosrc ~* '\m(insert|update|delete|merge|execute|call)\M' then 'write-or-dynamic-body' else 'body-requires-review' end as classification
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
where n.nspname in ('public','auth') and p.prosecdef and p.prokind='f'
and p.prorettype not in ('pg_catalog.trigger'::regtype,'pg_catalog.event_trigger'::regtype)
and has_schema_privilege('signup_fixture_observer',n.oid,'USAGE')
and has_function_privilege('signup_fixture_observer',p.oid,'EXECUTE') order by n.nspname,p.proname,p.oid`;
/** PUBLIC EXECUTE is inherited even by NOINHERIT roles. Never revoke shared ACLs here. */
export async function rejectUnreviewedDefiners(db, recordEvidence = console.log) {
  const rows = (await db.query(CALLABLE_DEFINERS_SQL)).rows;
  assert(Array.isArray(rows), 'Effective routine inventory incomplete.');
  if (!rows.length) return;
  const routines = rows.map((row) => {
    assert(['public','auth'].includes(row.schema_name) && typeof row.routine_name === 'string' && /^[a-zA-Z_][a-zA-Z_0-9]{0,62}$/.test(row.routine_name) && ['write-or-dynamic-body','body-requires-review'].includes(row.classification), 'Unsafe routine inventory format.');
    return { name: `${row.schema_name}.${row.routine_name}`, classification: row.classification };
  });
  recordEvidence(JSON.stringify({ project: DEV_REF, unreviewedCallableDefiners: routines }));
  throw new Error('Effective SECURITY DEFINER privileges require separate review; no shared ACLs were changed.');
}
async function deniedRead(db, sql) {
  await db.query('SAVEPOINT denied_probe');
  let denied = false;
  try { await db.query(sql); } catch (error) { denied = error?.code === '42501'; }
  await db.query('ROLLBACK TO SAVEPOINT denied_probe');
  await db.query('RELEASE SAVEPOINT denied_probe');
  assert(denied, 'Direct Auth read unexpectedly permitted.');
}
async function verifyObserver(db, expectedCatalog, expectedConstraints) {
  verifiedTls(db);
  await db.query('BEGIN READ ONLY');
  try {
    const id = (await db.query(IDENTITY_SQL)).rows;
    assert(id.length === 1 && id[0].role === OBSERVER_ROLE && id[0].session_role === OBSERVER_ROLE && id[0].database === 'postgres', 'Observer identity refused.');
    const rows = (await db.query('select * from signup_fixture_guard.session_counts($1::uuid)', ['00000000-0000-4000-8000-000000000000'])).rows;
    assert(rows.length === 1 && Object.keys(rows[0]).sort().join(',') === 'project_ref,refresh_tokens,sessions' && rows[0].project_ref === DEV_REF && ['sessions','refresh_tokens'].every((key) => /^(0|[1-9]\d*)$/.test(String(rows[0][key]))), 'Count-only capability refused.');
    assert(JSON.stringify((await db.query(CATALOG_SQL)).rows) === JSON.stringify(expectedCatalog), 'Observer catalog incomplete or changed.');
    assert(JSON.stringify((await db.query(CONSTRAINTS_SQL)).rows) === JSON.stringify(expectedConstraints), 'Observer constraints incomplete or changed.');
    await deniedRead(db, 'select user_id from auth.sessions limit 0');
    await deniedRead(db, 'select user_id from auth.refresh_tokens limit 0');
  } finally { await db.query('ROLLBACK'); }
}

/** Dependency injection exists for offline tests. CLI uses fixed production IO implementations below. */
export async function provisionObserver(options, dependencies = {}) {
  assertApplyOptions(options);
  const config = (dependencies.getConfig ?? nonproductionDatabaseConfig)(DEV_REF);
  assertConfig(config);
  config.ssl = { rejectUnauthorized: true, ca: CA };
  config.connectionTimeoutMillis = 10000;
  const secrets = dependencies.secrets ?? githubSecretIO();
  await secrets.assertAbsent();
  const connect = dependencies.connect ?? connectNonproductionDatabase;
  const db = await connect(config);
  let commitAttempted = false;
  let publicationAttempted = false;
  let observer;
  let containment = true;
  try {
    verifiedTls(db);
    await db.query('BEGIN');
    await db.query('SET LOCAL ROLE postgres');
    await db.query("SET LOCAL statement_timeout='10s'");
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("select pg_catalog.pg_advisory_xact_lock(734219,117)");
    const identity = (await db.query(IDENTITY_SQL)).rows;
    assert(identity.length === 1 && identity[0].role === 'postgres' && identity[0].session_role === 'cli_login_postgres' && identity[0].database === 'postgres', 'Bootstrap identity refused.');
    const before = await inventory(db);
    absent(before);
    (dependencies.writeBackup ?? ((path, content) => writeFileSync(path, content, { flag: 'wx', mode: 0o600 })))(options.backupPath, encryptBackup(before, options.backupKey));
    const catalog = (await db.query(CATALOG_SQL)).rows;
    assert(catalog.length > 0, 'Public catalog snapshot empty.');
    const constraints = (await db.query(CONSTRAINTS_SQL)).rows;
    await db.query(OBSERVER_SETUP_SQL);
    await verifyInstallation(db, false);
    await rejectUnreviewedDefiners(db, dependencies.recordEvidence);
    const password = randomBytes(32).toString('hex');
    // Password is generated hex, never caller input. PostgreSQL utility grammar does not accept bind parameters here.
    // This query is never logged; all driver errors are replaced below.
    await db.query(`ALTER ROLE signup_fixture_observer PASSWORD '${password}' LOGIN`);
    commitAttempted = true;
    await db.query('COMMIT');
    observer = await connect({ host: HOST, port: 5432, database: 'postgres', user: `${OBSERVER_ROLE}.${DEV_REF}`, password, ssl: { rejectUnauthorized: true, ca: CA }, connectionTimeoutMillis: 10000 });
    await verifyObserver(observer, catalog, constraints);
    await observer.end();
    observer = undefined;
    await db.query('BEGIN READ ONLY');
    await db.query('SET LOCAL ROLE postgres');
    await verifyInstallation(db);
    await rejectUnreviewedDefiners(db, dependencies.recordEvidence);
    await db.query('ROLLBACK');
    const dsn = `postgresql://${OBSERVER_ROLE}.${DEV_REF}:${encodeURIComponent(password)}@${HOST}:5432/postgres`;
    publicationAttempted = true;
    await secrets.publish(dsn);
    return { project: DEV_REF, repository: REPOSITORY, role: OBSERVER_ROLE, secret: SECRET_NAME, backupPath: options.backupPath, verified: true };
  } catch {
    await db.query('ROLLBACK').catch(() => undefined);
    if (commitAttempted) {
      try {
        await db.query('BEGIN');
        await db.query('SET LOCAL ROLE postgres');
        await db.query('ALTER ROLE signup_fixture_observer NOLOGIN');
        await db.query('REVOKE EXECUTE ON FUNCTION signup_fixture_guard.session_counts(uuid) FROM signup_fixture_observer');
        await db.query('COMMIT');
      } catch { containment = false; await db.query('ROLLBACK').catch(() => undefined); }
    }
    if (publicationAttempted) { try { await secrets.remove(); } catch { containment = false; } }
    throw new Error(containment ? 'Observer provisioning refused; any committed login was disabled and helper access revoked. Inspect encrypted backup before retrying.' : 'Observer provisioning failed and containment was incomplete. Operator must disable the dedicated login/revoke helper access and remove the dedicated GitHub secret.');
  } finally {
    await observer?.end().catch(() => undefined);
    await db.end().catch(() => undefined);
    // No session termination: only task-owned clients are opened and explicitly closed.
  }
}

// Complete removal is deliberately a separate operator-reviewed step: require no consumers,
// verify exact current definitions first, then NOLOGIN, reject any pg_stat_activity session,
// DROP FUNCTION signup_fixture_guard.session_counts(uuid); REVOKE USAGE ON SCHEMA
// signup_fixture_guard FROM signup_fixture_observer; REVOKE CONNECT ON DATABASE postgres
// FROM signup_fixture_observer; DROP SCHEMA signup_fixture_guard; DROP ROLE signup_fixture_observer.
// Never DROP OWNED, CASCADE, modify shared privileges, or terminate other sessions.
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === '--plan')) {
    console.log(JSON.stringify({ project: DEV_REF, repository: REPOSITORY, reviewedSha256: sourceDigest(), initialInstallOnly: true, sql: OBSERVER_SETUP_SQL }));
    return;
  }
  assert(args.length === 5 && args[0] === '--apply' && args[1] === '--reviewed-sha256' && args[3] === '--backup', 'Use --plan or --apply --reviewed-sha256 <reviewed digest> --backup <absolute new encrypted path>.');
  const result = await provisionObserver({ ref: DEV_REF, repository: REPOSITORY, apiUrl: process.env.NEXT_PUBLIC_SUPABASE_URL, reviewedSha256: args[2], backupPath: args[4], backupKey: process.env.SIGNUP_OBSERVER_BACKUP_KEY });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('Observer provisioning refused. No credentials are logged. Review target, digest, encrypted backup and dedicated role/secret containment before retrying.');
  process.exitCode = 1;
});
