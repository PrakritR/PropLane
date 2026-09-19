/** Offline, single-migration release reconciliation. Never use migration repair.
 * Private evidence is deliberately not printed. Root owns execution and review.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, lstatSync, mkdirSync, writeFileSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const PRIVATE_ROOT = '/Users/akhilvemuri/.local/state/proplane-release/2026-09-19-conversation-identity';
export const TARGETS = Object.freeze({
  staging: Object.freeze({ projectRef: 'xwszcafaontidfgznlxd', migrations: Object.freeze(['invite_workspace','workspace_permissions','account_link_team_role','booking_com_calendar_provider']) }),
  production: Object.freeze({ projectRef: 'qahnczmilgptcedaqype', migrations: Object.freeze(['team_delivery_recipient_key','invite_workspace','workspace_permissions','account_link_team_role','booking_com_calendar_provider']) }),
});
export const HISTORY_IDENTITY = '20260919020000_release_reminder_history_name_reconciliation';
export const PINNED_CLI = '/Users/akhilvemuri/.npm/_npx/6f1b058a4d9555af/node_modules/@supabase/cli-darwin-arm64/bin/supabase';
const CLI_SHA256 = 'c2ca0770b4634e85a01254ffdfda1999063e5d424f41dc345839e62171d8bb4b';
const CLI_SOURCES = {
 list:'0e08085a541b29070bdb374f9fa40c1168c7f723bda091b92b75eea8fa9fb5bc',
 push:'7ab1871fd9aea6880462b5950e6f1b4e425349b7bfd50757d3110d575e232e46',
 'push-core':'ef76b6f72a94b098b616eed021d1ad86f0cc039ceeefe0f4cba627e071b5b3f9',
 apply:'38be04d04510a443bbe9f2b039645e4ec79c711b03843774d32c1b8558d9a5d6',
 'migration-file':'67d248efbec4eec0189bde42294241113217c66c3fe8a4f0ce7b49a3832bed48',
 'migration-history':'f2a155ab35943b117c3821b1a540131899706523390a9da9c051cebf4b880fff',
};
const OLD_NAME = 'automated_communication_reminder_kinds';
const NEW_NAME = 'automated_communication_reminder_kinds_reapplied_20260916063005';
const RENAME_VERSION = '20260916063005';
const SOURCES = {
  invite_workspace: ['20260917010000','c2bdaeaf6b5fc78ad4a2b36a85d57e26cd8c14446054b6a74f71093aef8ab5a8'],
  workspace_permissions: ['20260918153000','33daaa488aeda67acc6539a268ddc57c4b8c1c22077cb2d6821905eb52000bdb'],
  account_link_team_role: ['20260918180000','5c88cf478d034945ea5483b426fe9d6d3832dc58cb9c59624148300c2daa5838'],
  booking_com_calendar_provider: ['20260919010000','a5ba46c5a08f55c5963b8b256ebb73a4b64efc1fcd90fc80da02eb9be553f964'],
  team_delivery_recipient_key: ['20260916140000','9fa78347b89f0a43bd0e247e90e4bf874407d944be2d8d0e987fa314f1293ac0'],
};
const PINS = {
 staging: {
  'pre-release.json': '79dc1ccde1aaf0c02fbbc53e70bfaf2c01d76aff43bfc45406fecd87e63b93ac',
  'catalog-pre-release.json': 'a174974f007cf683ab4d093d352b73eb9b0bd7dcaaa0f8af944d2c905ed539ad',
  'public-schema.sql': 'a3ad3873f8e5acd62167c8130a0aa9c9bd67d55ecd0db123b74bd7686ef67a09',
 },
 production: {
  'pre-release.json': '258def66e42b25a33dbd497ac9ba0a4a8206f8590bc2acb33299ab8e9c42050b',
  'catalog-pre-release.json': '70aa7075220aae737cfe3249a1ecde371ecbfe1884842b2916a5d3159eabe116',
  'public-schema.sql': 'e08e2245ef14f607037759954d242659ba4358bfd966364ca3cc34a29bb52f71',
 },
};
const fail = (reason) => new Error(`Reconciliation refused: ${reason}`);
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k,stable(value[k])])) : value;
const canonical = (value) => JSON.stringify(stable(value));
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const jsonLiteral = (value) => `${literal(JSON.stringify(value))}::jsonb`;
function targetConfig(target) { if (!Object.hasOwn(TARGETS,target)) throw fail('exact target required'); return TARGETS[target]; }
export function readPinned(path, digest, privateFile = true) {
 const stat = lstatSync(path);
 if (!stat.isFile() || stat.isSymbolicLink() || (privateFile && (stat.mode & 0o777) !== 0o600)) throw fail('file type or permissions');
 const bytes = readFileSync(path);
 if (!/^[a-f0-9]{64}$/.test(digest ?? '') || sha256(bytes) !== digest) throw fail('file digest');
 return bytes;
}
export function loadPinnedEvidence(target) {
 const config = targetConfig(target), data = {};
 for (const [suffix,digest] of Object.entries(PINS[target])) data[suffix] = readPinned(join(PRIVATE_ROOT,`${target}-${suffix}`),digest);
 const snapshot = JSON.parse(data['pre-release.json']), catalog = JSON.parse(data['catalog-pre-release.json']);
 if (snapshot.target !== config.projectRef || catalog.target !== config.projectRef) throw fail('pinned target');
 return {...snapshot,catalog:catalog.catalog};
}
export function evidenceFingerprint(snapshot) {
 const { capturedAt: _capture, catalogCapturedAt: _catalogCapture, ...semantic } = snapshot;
 return sha256(canonical(semantic));
}
export function assertFreshEvidenceMatches(pinned,fresh) {
 if (evidenceFingerprint(pinned) !== evidenceFingerprint(fresh)) throw fail('fresh evidence differs');
 return true;
}
export function expectedMigrationIdentities(target) {
 return targetConfig(target).migrations.map(name => `${SOURCES[name][0]}_${name}`);
}
export function extractPlannedMigrationIdentities(output) {
 return [...output.matchAll(/\b(\d{14}_[a-z][a-z0-9_]*)\.sql\b/g)].map(match => match[1]);
}
export function assertExactDryRun(output, expected, exitCode = 0) {
 if (exitCode !== 0 || canonical(extractPlannedMigrationIdentities(output)) !== canonical(expected)) throw fail('dry-run must succeed with exact ordered selection');
 return true;
}
export function parseArgs(args) {
 if (args.includes('--apply')) throw fail('preparation-only entry point');
 if (args.length !== 2 || args[0] !== '--target') throw fail('Usage: --target staging|production');
 targetConfig(args[1]); return {target:args[1]};
}
function sourceSql(name) {
 if (!Object.hasOwn(SOURCES,name)) throw fail('unreviewed migration');
 const [version,digest] = SOURCES[name];
 return readPinned(join(REPO,'supabase/migrations',`${version}_${name}.sql`),digest,false).toString('utf8');
}
export function serializeHistoricalStatements(statements) {
 if (statements === null) return '-- Historical null payload: never selected for execution.\n';
 if (!Array.isArray(statements) || statements.some(s => typeof s !== 'string')) throw fail('unsupported historical statement shape');
 return statements.map(s => s.trimEnd().endsWith(';') ? s : `${s};`).join('\n');
}
function validateLedger(ledger) {
 if (!Array.isArray(ledger) || ledger.length === 0) throw fail('empty ledger');
 const versions = new Set();
 for (const row of ledger) {
  if (!/^\d{14}$/.test(row.version) || typeof row.name !== 'string' || versions.has(row.version)) throw fail('invalid ledger identity');
  versions.add(row.version);
  serializeHistoricalStatements(row.statements);
 }
}
// Dollar quoting is lexical: even a delimiter inside an inner SQL literal
// terminates the outer body. Inspect the complete body, including captures.
export function doBlock(body, tag = 'ledger_guard') {
 if (!/^[a-z_]+$/.test(tag)) throw fail('invalid DO tag');
 let delimiter = `$${tag}$`, suffix = 0;
 while (body.includes(delimiter)) delimiter = `$${tag}_${++suffix}$`;
 return `do ${delimiter} ${body} ${delimiter};`;
}
/** The TypeScript CLI sends every migration statement plus its history INSERT
 * as one extended-protocol batch. PostgreSQL keeps that batch atomic, but it is
 * not an explicit transaction block. Run block-only settings and locks from a
 * non-top-level DO body so they remain in force through the CLI history INSERT. */
export function cliTransactionGuardSql({ lockTimeout = null, statementTimeout = null, locks = [], tag = 'cli_transaction_guard' } = {}) {
 const timeout = value => value === null || /^\d+(?:ms|s|min)$/.test(value);
 if (!timeout(lockTimeout) || !timeout(statementTimeout) || !Array.isArray(locks)) throw fail('invalid CLI transaction guard');
 const lockSql = locks.map(lock => {
  if (!lock || !Array.isArray(lock.relations) || lock.relations.length === 0 || !['exclusive','share row exclusive'].includes(lock.mode) || lock.relations.some(relation => !/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(relation))) throw fail('invalid CLI transaction lock');
  return `lock table ${lock.relations.join(', ')} in ${lock.mode} mode;`;
 });
 return doBlock(`begin
 set local standard_conforming_strings = on;
 ${lockTimeout === null ? '' : `set local lock_timeout = ${literal(lockTimeout)};\n `}${statementTimeout === null ? '' : `set local statement_timeout = ${literal(statementTimeout)};\n `}${lockSql.join('\n ')}
 end`, tag);
}
export function ledgerGuardSql(ledger) {
 validateLedger(ledger);
 const expected = [...ledger].sort((a,b) => a.version.localeCompare(b.version));
 // Full row metadata remains exact. Hash each unmodified UTF-8 statement in
 // order instead of recursively embedding previous guards in durable history.
 const compact = expected.map(({statements, ...metadata}) => ({
  metadata, statements: statements === null ? null : statements.map(s => sha256(Buffer.from(s, 'utf8'))),
 }));
 const dimensions = expected.map(r => ({version:r.version,dims:r.statements?.length ? `[1:${r.statements.length}]` : null}));
 return doBlock(`begin
 if (select coalesce(jsonb_agg(jsonb_build_object('metadata',to_jsonb(m)-'statements','statements',case when m.statements is null then null else (select coalesce(jsonb_agg(encode(sha256(convert_to(s.statement,'UTF8')),'hex') order by s.ordinality),'[]'::jsonb) from unnest(m.statements) with ordinality s(statement,ordinality)) end) order by version),'[]'::jsonb) from supabase_migrations.schema_migrations m) is distinct from ${jsonLiteral(compact)} then raise exception 'full ledger differs'; end if;
 if (select jsonb_agg(jsonb_build_object('version',version,'dims',array_dims(statements)) order by version) from supabase_migrations.schema_migrations) is distinct from ${jsonLiteral(dimensions)} then raise exception 'ledger array dimensions differ'; end if;
 end`);
}
const TABLES = ['account_link_invites','external_calendar_connections','manager_invite_links','portal_workspaces'];
const tableList = TABLES.map(literal).join(',');
export const CATALOG_SQL = `jsonb_build_object(
 'columns',(select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'comment',col_description(c.oid,a.attnum)) order by c.relname,a.attnum),'[]'::jsonb) from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where n.nspname='public' and c.relname in (${tableList}) and a.attnum>0 and not a.attisdropped),
 'constraints',(select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',k.conname,'type',k.contype,'definition',pg_get_constraintdef(k.oid,true),'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred) order by c.relname,k.conname),'[]'::jsonb) from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in (${tableList})),
 'indexes',(select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',ic.relname,'definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive) order by c.relname,ic.relname),'[]'::jsonb) from pg_index i join pg_class c on c.oid=i.indrelid join pg_class ic on ic.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in (${tableList})))`;
export function catalogGuardSql(catalog) {
 if (!catalog || !['columns','constraints','indexes'].every(k => Array.isArray(catalog[k]) && catalog[k].length > 0)) throw fail('catalog evidence missing');
 // Compare arrays as sets, since the capture may order columns by name instead
 // of ordinal. Counts plus bidirectional containment retain duplicate detection.
 return doBlock(`declare actual jsonb := ${CATALOG_SQL}; expected jsonb := ${jsonLiteral(catalog)}; k text; begin
 foreach k in array array['columns','constraints','indexes'] loop
 if jsonb_array_length(actual->k) <> jsonb_array_length(expected->k) or not ((actual->k) @> (expected->k) and (expected->k) @> (actual->k)) then raise exception 'catalog differs: %', k; end if;
 end loop; end`, 'catalog_guard');
}
export function renameHistorySql(ledger) {
 validateLedger(ledger);
 const rows = ledger.filter(r => r.name === OLD_NAME), selected = rows.find(r => r.version === RENAME_VERSION);
 if (rows.length !== 2 || !selected || ledger.some(r => r.name === NEW_NAME || r.version === HISTORY_IDENTITY.slice(0,14))) throw fail('reviewed reminder duplicate pair required');
 const after = ledger.map(r => r.version === RENAME_VERSION ? {...r,name:NEW_NAME} : r);
 return doBlock(`declare changed integer; begin
 update supabase_migrations.schema_migrations set name=${literal(NEW_NAME)} where version=${literal(RENAME_VERSION)} and name=${literal(OLD_NAME)} and to_jsonb(statements) is not distinct from ${jsonLiteral(selected.statements)};
 get diagnostics changed = row_count;
 if changed <> 1 then raise exception 'history rename count differs'; end if;
 end`, 'rename_history') + `\n${ledgerGuardSql(after)}`;
}
/** Preparation only. A separate new reviewed migration must record this SQL.
 * Never delete the correction row or alter its SQL/version. */
export function historyNameRecoverySql(ledger) {
 validateLedger(ledger);
 const selected = ledger.find(r => r.version === RENAME_VERSION);
 if (selected?.name !== NEW_NAME || !ledger.some(r => `${r.version}_${r.name}` === HISTORY_IDENTITY)) throw fail('reconciled history required for recovery');
 const after = ledger.map(r => r.version === RENAME_VERSION ? {...r,name:OLD_NAME} : r);
 return `${cliTransactionGuardSql({locks:[{relations:['supabase_migrations.schema_migrations'],mode:'exclusive'}],tag:'history_recovery_transaction'})}
 ${ledgerGuardSql(ledger)}
 ${doBlock(`declare changed integer; begin
 update supabase_migrations.schema_migrations set name=${literal(OLD_NAME)} where version=${literal(RENAME_VERSION)} and name=${literal(NEW_NAME)};
 get diagnostics changed = row_count;
 if changed <> 1 then raise exception 'history recovery count differs'; end if;
 end`, 'history_recovery')}
 ${ledgerGuardSql(after)}`;
}
/** Restores only the captured function body, keeping owner/configuration/ACL.
 * Root must review the concrete private SQL; this does not authorize execution. */
export function functionRecoverySql(current, original) {
 if (canonical(current) !== canonical(expectedFunctionAfter(original))) throw fail('corrected function required for recovery');
 return `${cliTransactionGuardSql({tag:'function_recovery_transaction'})}
 ${functionGuardSql(current)}
 ${original.definition};
 ${functionGuardSql(original)}`;
}
export function reconciliationSql(name, evidence) {
 if (!evidence) throw fail('authenticated transaction evidence required');
 let body;
 if (name === 'release_reminder_history_name_reconciliation') body = renameHistorySql(evidence.ledger);
 else {
  body = sourceSql(name);
  if (name === 'workspace_permissions') {
   const marker = '\n-- Existing teammates were invited';
   if (!body.includes(marker)) throw fail('permission source boundary changed');
   body = `do $permissions$ begin if exists(select 1 from public.account_link_invites where status in ('pending','accepted') and (workspace_permissions->'addProperties') is distinct from 'true'::jsonb) then raise exception 'workspace permission backfill is not authorized'; end if; end $permissions$;\n-- Historical permission UPDATE intentionally omitted; existing values asserted.\n` + body.slice(0,body.indexOf(marker));
  }
  if (name === 'invite_workspace') body = `do $invite$ begin if exists(select 1 from pg_attribute where attrelid='public.manager_invite_links'::regclass and attname in ('workspace_id','workspace_name_snapshot','property_labels','token_ciphertext') and not attisdropped) then raise exception 'invite column precondition differs'; end if; end $invite$;\n` + body;
  if (name === 'team_delivery_recipient_key') {
   // The exact function snapshot is checked separately before replacement.
   if (!evidence.lease_function?.definition) throw fail('function snapshot missing');
   body = functionGuardSql(evidence.lease_function) + '\n' + body;
  }
 }
 const afterCatalog=expectedPostCatalog(evidence.catalog,name);
 const invites=activeInvitesGuardSql(evidence.active_invites);
 const functionPost=name==='team_delivery_recipient_key'?functionGuardSql(expectedFunctionAfter(evidence.lease_function)):'';
 const transactionGuard=cliTransactionGuardSql({
  lockTimeout:'3s', statementTimeout:'60s',
  locks:[
   {relations:['supabase_migrations.schema_migrations'],mode:'exclusive'},
   {relations:TABLES.map(table=>`public.${table}`),mode:'share row exclusive'},
  ],
  tag:'reconciliation_transaction',
 });
 return `${transactionGuard}\n${ledgerGuardSql(evidence.ledger)}\n${catalogGuardSql(evidence.catalog)}\n${invites}\n${body}\n${catalogGuardSql(afterCatalog)}\n${functionPost}\n${invites}\n`;
}
function activeInvitesGuardSql(rows) {
 if (!Array.isArray(rows)) throw fail('active invite snapshot missing');
 // Guard every permission field, without copying names, token hashes or other
 // personal capture fields into the new durable migration-history SQL.
 const keys=['id','status','workspace_permissions','property_co_manager_permissions','co_manager_permissions','assigned_property_ids'];
 const sorted=rows.map(row=>Object.fromEntries(keys.map(k=>[k,row[k]]))).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
 const projection=keys.map(k=>`${literal(k)},i.${k}`).join(',');
 return doBlock(`begin if (select coalesce(jsonb_agg(jsonb_build_object(${projection}) order by id),'[]'::jsonb) from public.account_link_invites i where status in ('pending','accepted')) is distinct from ${jsonLiteral(sorted)} then raise exception 'active invite permission snapshot differs'; end if; end`, 'invite_rows');
}
export function expectedPostCatalog(catalog,name) {
 const result=structuredClone(catalog);
 if (name!=='invite_workspace') return result;
 const table='manager_invite_links';
 for (const [column,type,not_null,defaultValue,comment] of [
  ['workspace_id','uuid',false,null,null],
  ['workspace_name_snapshot','text',false,null,null],
  ['property_labels','jsonb',true,"'[]'::jsonb",null],
  ['token_ciphertext','text',false,null,'AES-GCM ciphertext of the bearer token for same-URL copy. Null on links minted before this column or when encryption was unavailable.'],
 ]) {
  if (result.columns.some(c=>c.table===table && c.name===column)) throw fail('invite catalog column already present');
  result.columns.push({table,name:column,type,not_null,default:defaultValue,comment});
 }
 result.constraints.push({table,name:'manager_invite_links_workspace_id_fkey',type:'f',definition:'FOREIGN KEY (workspace_id) REFERENCES portal_workspaces(id) ON DELETE SET NULL',validated:true,deferrable:false,deferred:false});
 result.indexes.push({table,name:'manager_invite_links_workspace_idx',definition:'CREATE INDEX manager_invite_links_workspace_idx ON public.manager_invite_links USING btree (workspace_id)',valid:true,ready:true,live:true});
 return result;
}
const catalogFingerprint=catalog=>sha256(canonical(Object.fromEntries(['columns','constraints','indexes'].map(k=>[k,[...catalog[k]].sort((a,b)=>canonical(a).localeCompare(canonical(b)))]))));
export function functionGuardSql(fn) {
 // pg_get_functiondef includes signature; identify the exact captured overload
 // by definition, then compare owner, config, and ACL representation directly.
 return doBlock(`begin
 if not exists(select 1 from pg_proc f where f.oid='public.persist_lease_with_action_event(jsonb,timestamptz,jsonb)'::regprocedure and pg_get_functiondef(f.oid)=${literal(fn.definition)} and pg_get_userbyid(f.proowner)=${literal(fn.owner)} and f.prosecdef and to_jsonb(f.proconfig) is not distinct from ${jsonLiteral(fn.config)} and to_jsonb(f.proacl) is not distinct from ${jsonLiteral(fn.acl)} and not exists(select 1 from aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a where a.grantee=0 or a.grantee not in (f.proowner,(select oid from pg_roles where rolname='service_role')))) then raise exception 'function contract differs'; end if;
 end`, 'function_guard');
}
export function pgFunctionDefinitionDelimiter(body) {
 // PostgreSQL 16 ruleutils.c checks the prefix before appending its final '$'.
 // '$function_guard$' therefore requires '$functionx$', too.
 let prefix='$function';
 while (body.includes(prefix)) prefix += 'x';
 return `${prefix}$`;
}
export function expectedFunctionAfter(fn) {
 const sql=sourceSql('team_delivery_recipient_key');
 const pieces=sql.split('$$');
 if (pieces.length!==3) throw fail('reviewed function delimiter');
 const expression=/\bAS\s+(\$[a-zA-Z0-9_]*\$)([\s\S]*?)\1/;
 if (!expression.test(fn.definition)) throw fail('captured function delimiter');
 const body=pieces[1];
 const delimiter=pgFunctionDefinitionDelimiter(body);
 return {...fn,definition:fn.definition.replace(expression,()=>`AS ${delimiter}${body}${delimiter}`)};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 try {
  const {target} = parseArgs(process.argv.slice(2));
  loadPinnedEvidence(target);
  for (const name of targetConfig(target).migrations) sourceSql(name);
  process.stdout.write(JSON.stringify({target:targetConfig(target).projectRef,mode:'offline',identities:expectedMigrationIdentities(target),historyCorrection:target==='production'?HISTORY_IDENTITY:null,applyReady:false})+'\n');
 } catch { process.stderr.write('Reconciliation refused; inspect private evidence and reviewed source.\n'); process.exitCode=1; }
}

export function assertPinnedCli() {
 const stat = lstatSync(PINNED_CLI);
 if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 70_785_296) throw fail('CLI binary size/type');
 const digest = createHash('sha256'), buffer = Buffer.alloc(1024*1024), fd = openSync(PINNED_CLI,'r');
 try { let size; while ((size=readSync(fd,buffer,0,buffer.length,null))>0) digest.update(buffer.subarray(0,size)); } finally { closeSync(fd); }
 if (digest.digest('hex') !== CLI_SHA256) throw fail('CLI binary digest');
 for (const [name,pin] of Object.entries(CLI_SOURCES)) readPinned(`/tmp/akhil-cli-${name}.ts`,pin,false);
 return true;
}
function loadCapture(target, capture) {
 const config = targetConfig(target);
 if (!capture || !['path','catalogPath'].every(k => typeof capture[k]==='string' && resolve(capture[k]).startsWith(`${PRIVATE_ROOT}/`))) throw fail('private capture paths');
 const snapshot = JSON.parse(readPinned(capture.path,capture.sha256));
 const catalog = JSON.parse(readPinned(capture.catalogPath,capture.catalogSha256));
 if (snapshot.target !== config.projectRef || catalog.target !== config.projectRef || !Number.isFinite(Date.parse(snapshot.capturedAt)) || !Number.isFinite(Date.parse(catalog.capturedAt))) throw fail('capture identity');
 validateLedger(snapshot.ledger);
 catalogGuardSql(catalog.catalog);
 return {...snapshot,catalog:catalog.catalog,catalogCapturedAt:catalog.capturedAt};
}
export function releaseSequence(target) {
 return [...(target==='production'?[HISTORY_IDENTITY]:[]),...expectedMigrationIdentities(target)];
}
export function assertCapturedProgress(target, initial, fresh, completed) {
 const sequence = releaseSequence(target);
 if (!Array.isArray(completed) || completed.length>sequence.length) throw fail('step count');
 if (fresh.target !== targetConfig(target).projectRef || initial.target !== fresh.target) throw fail('capture target');
 validateLedger(initial.ledger); validateLedger(fresh.ledger);
 if (canonical(initial.active_invites)!==canonical(fresh.active_invites)) throw fail('business snapshot differs');
 const renamed = target==='production' && completed.length>0;
 const old = initial.ledger.map(row => renamed && row.version===RENAME_VERSION ? {...row,name:NEW_NAME} : row);
 const originalVersions = new Set(old.map(r => r.version));
 for (const row of old) {
  if (canonical(fresh.ledger.find(r => r.version===row.version))!==canonical(row)) throw fail('historical ledger differs');
 }
 const added = fresh.ledger.filter(r => !originalVersions.has(r.version));
 if (added.length!==completed.length) throw fail('unexpected migration inventory');
 for (let index=0;index<completed.length;index++) {
  const receipt=completed[index], identity=sequence[index];
  const row=added.find(r => `${r.version}_${r.name}`===identity);
  if (receipt.identity!==identity || !row || sha256(canonical(row))!==receipt.ledgerRowSha256) throw fail('completed step requires exact reviewed actual ledger row');
 }
 if (completed.length===0) {
  const {catalogCapturedAt:_time,...semantic}=fresh;
  assertFreshEvidenceMatches(initial,semantic);
 } else if (canonical(initial.lease_function?.acl)!==canonical(fresh.lease_function?.acl) || canonical(initial.lease_function?.config)!==canonical(fresh.lease_function?.config) || initial.lease_function?.owner!==fresh.lease_function?.owner) throw fail('function privileges differ');
 const functionApplied=completed.some(r => r.identity.endsWith('_team_delivery_recipient_key'));
 if (!functionApplied && canonical(initial.lease_function)!==canonical(fresh.lease_function)) throw fail('unexpected function change');
 if (functionApplied && canonical(expectedFunctionAfter(initial.lease_function))!==canonical(fresh.lease_function)) throw fail('corrected function differs');
 let expectedCatalog=initial.catalog;
 for (const receipt of completed) expectedCatalog=expectedPostCatalog(expectedCatalog,receipt.identity.slice(15));
 if (catalogFingerprint(expectedCatalog)!==catalogFingerprint(fresh.catalog)) throw fail('post-step catalog differs');
 return sequence[completed.length];
}
function privateDirectory(path) {
 const stat=lstatSync(path);
 if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode&0o777)!==0o700) throw fail('private directory');
}
const writePrivate=(path,bytes)=>writeFileSync(path,bytes,{mode:0o600,flag:'wx'});

function processErrorMetadata(error) {
 if (!error) return null;
 const metadata={name:String(error.name??'Error'),message:String(error.message??error)};
 for (const key of ['code','errno','syscall']) {
  if (typeof error[key]==='string' || typeof error[key]==='number') metadata[key]=error[key];
 }
 return metadata;
}

/** Persist bounded CLI output without exposing it through the calling terminal.
 * The fixed root is verified before an exclusive 0600 create. Test operations
 * can replace system calls, but cannot redirect the production artifact path. */
export function writePrivateCliFailureDiagnostic({projectRef,phase,identity,result}, operations={}) {
 if (!/^[a-z]{20}$/.test(projectRef??'') || !['dry-run','apply'].includes(phase) || !/^\d{14}_[a-z][a-z0-9_]*$/.test(identity??'') || !result || typeof result!=='object') throw fail('CLI failure diagnostic identity');
 const stat=(operations.lstatSync??lstatSync)(PRIVATE_ROOT);
 if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode&0o777)!==0o700) throw fail('private directory');
 const now=operations.now??Date.now;
 const random=operations.randomBytes??randomBytes;
 const write=operations.writeFileSync??writeFileSync;
 const recordedAt=new Date(now()).toISOString();
 const nonce=Buffer.from(random(16)).toString('hex');
 if (!/^[a-f0-9]{32}$/.test(nonce)) throw fail('CLI failure diagnostic nonce');
 const path=join(PRIVATE_ROOT,`cli-failure-${phase}-${Date.parse(recordedAt)}-${process.pid}-${nonce}.json`);
 const artifact={
  format:1,
  projectRef,
  phase,
  identity,
  recordedAt,
  process:{status:result.status??null,signal:result.signal??null,error:processErrorMetadata(result.error)},
  stdout:String(result.stdout??''),
  stderr:String(result.stderr??''),
 };
 write(path,JSON.stringify(artifact,null,2)+'\n',{mode:0o600,flag:'wx'});
 return path;
}

/** Always throws. If private logging itself fails, preserve fail-closed behavior
 * and do not attach either the logging error or captured CLI output. */
export function throwPrivateCliFailure(context,result,operations) {
 let path;
 try { path=writePrivateCliFailureDiagnostic({...context,result},operations); }
 catch { throw new Error('Supported CLI operation failed; private diagnostic unavailable'); }
 throw new Error(`Supported CLI operation failed; private diagnostic: ${path}`);
}

function makeFiles(target,evidence,identity) {
 const files={};
 files['supabase/config.toml']='project_id = "conversation-release-reconciliation"\n[db.migrations]\nenabled = true\n[db.seed]\nenabled = false\n';
 for (const row of evidence.ledger) {
  // Unique local aliases do not change remote names. CLI matches versions.
  files[`supabase/migrations/${row.version}_recorded_${row.version}.sql`]=serializeHistoricalStatements(row.statements);
 }
 const name=identity.slice(15);
 if (evidence.ledger.some(r => r.version===identity.slice(0,14))) throw fail('new migration version already present');
 if (name==='release_reminder_history_name_reconciliation' && target!=='production') throw fail('production-only history correction');
 files[`supabase/migrations/${identity}.sql`]=reconciliationSql(name,evidence);
 return files;
}
/** Completed receipts contain hashes of ACTUAL captured ledger rows approved by
 * the independent reviewer. We never simulate the CLI SQL parser. */
export function prepareStep({target,capture,completed=[]}) {
 const initial=loadPinnedEvidence(target), evidence=loadCapture(target,capture);
 const identity=assertCapturedProgress(target,initial,evidence,completed);
 if (!identity) throw fail('release sequence already complete');
 assertPinnedCli();
 const files=makeFiles(target,evidence,identity);
 const seal=sha256(canonical({target,capture,completed,files}));
 const directory=join(PRIVATE_ROOT,`step-${target}-${completed.length}-${seal.slice(0,16)}`);
 privateDirectory(PRIVATE_ROOT);
 mkdirSync(directory,{mode:0o700});
 mkdirSync(join(directory,'supabase'),{mode:0o700});
 mkdirSync(join(directory,'supabase/migrations'),{mode:0o700});
 for (const [path,bytes] of Object.entries(files)) writePrivate(join(directory,path),bytes);
 const manifest={format:1,target,projectRef:targetConfig(target).projectRef,identity,capture,completed,cliSha256:CLI_SHA256,runnerSha256:sha256(readFileSync(fileURLToPath(import.meta.url))),evidenceFingerprint:evidenceFingerprint(evidence),files:Object.fromEntries(Object.entries(files).map(([path,bytes])=>[path,sha256(bytes)]))};
 const path=join(directory,'manifest.json'), bytes=JSON.stringify(manifest,null,2)+'\n';
 writePrivate(path,bytes);
 return {manifestPath:path,manifestSha256:sha256(bytes),identity,applyReady:false};
}
function verifiedManifest({manifestPath,manifestSha256}) {
 if (typeof manifestPath!=='string' || !resolve(manifestPath).startsWith(`${PRIVATE_ROOT}/step-`) || !manifestPath.endsWith('/manifest.json')) throw fail('manifest path');
 const manifest=JSON.parse(readPinned(manifestPath,manifestSha256));
 const directory=resolve(manifestPath,'..'); privateDirectory(directory);
 if (manifest.format!==1 || manifest.projectRef!==targetConfig(manifest.target).projectRef || manifest.cliSha256!==CLI_SHA256 || manifest.runnerSha256!==sha256(readFileSync(fileURLToPath(import.meta.url)))) throw fail('manifest identity/source');
 const initial=loadPinnedEvidence(manifest.target), evidence=loadCapture(manifest.target,manifest.capture);
 if (assertCapturedProgress(manifest.target,initial,evidence,manifest.completed)!==manifest.identity || evidenceFingerprint(evidence)!==manifest.evidenceFingerprint) throw fail('manifest evidence');
 const files=makeFiles(manifest.target,evidence,manifest.identity);
 if (canonical(Object.keys(manifest.files).sort())!==canonical(Object.keys(files).sort())) throw fail('manifest file inventory');
 for (const [path,bytes] of Object.entries(files)) {
  if (manifest.files[path]!==sha256(bytes)) throw fail('generated SQL differs');
  readPinned(join(directory,path),sha256(bytes));
 }
 privateDirectory(join(directory,'supabase')); privateDirectory(join(directory,'supabase/migrations'));
 if (canonical(readdirSync(join(directory,'supabase/migrations')).sort())!==canonical(Object.keys(files).filter(p=>p.startsWith('supabase/migrations/')).map(p=>p.slice('supabase/migrations/'.length)).sort())) throw fail('extra migration file');
 // CLI can create .temp itself; no project env overrides or seeds are allowed.
 if (readdirSync(join(directory,'supabase')).some(p=>!['config.toml','migrations','.temp'].includes(p)) || readdirSync(directory).some(p=>!['supabase','manifest.json'].includes(p))) throw fail('unexpected workspace file');
 assertPinnedCli();
 return {manifest,evidence,directory};
}
const freshCapture=(evidence,now)=>{
 for (const stamp of [evidence.capturedAt,evidence.catalogCapturedAt]) {
  const age=now-Date.parse(stamp);
  if (!Number.isFinite(age) || age<0 || age>10*60*1000) throw fail('fresh capture expired');
 }
};
/** A reviewed approval binds every private artifact, a rehearsed recovery file,
 * the inspected source-to-binary provenance, and this exact runner. It is an
 * owner input, never generated or inferred by this helper. */
function verifiedApproval(request,state) {
 const approval=JSON.parse(readPinned(request.approvalPath,request.approvalSha256));
 const now=Date.now(); freshCapture(state.evidence,now);
 if (approval.approved!==true || approval.authorizationSource!=='existing-session-release-authorization' || approval.manifestSha256!==request.manifestSha256 || approval.projectRef!==state.manifest.projectRef || approval.runnerSha256!==state.manifest.runnerSha256 || approval.sourceToBinaryVerified!==true || approval.recoveryRehearsalPassed!==true || !Number.isFinite(Date.parse(approval.reviewedAt)) || Date.parse(approval.reviewedAt)>now || now-Date.parse(approval.reviewedAt)>60*60*1000 || !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt)<=now || Date.parse(approval.expiresAt)-Date.parse(approval.reviewedAt)>60*60*1000) throw fail('independent review/recovery approval required');
 readPinned(approval.reviewReportPath,approval.reviewReportSha256,false);
 readPinned(approval.recoveryArtifactPath,approval.recoveryArtifactSha256);
 return approval;
}
// Tokens cannot be fabricated from caller-provided matching snapshots or CLI text.
const dryRunTokens=new WeakMap();
export function assertReleaseReadiness(request,token) {
 if (!request || typeof request!=='object' || !dryRunTokens.has(token)) throw fail('owner transport requires authenticated review and successful dry-run');
 const state=verifiedManifest(request); verifiedApproval(request,state);
 const dry=dryRunTokens.get(token);
 if (dry.manifestSha256!==request.manifestSha256 || dry.approvalSha256!==request.approvalSha256 || Date.now()-dry.finishedAt>60_000 || dry.used) throw fail('dry-run token expired or differs');
 return state;
}
function cliEnvironment() {
 // Deliberately exclude PG*, SUPABASE_DB_*, NODE_OPTIONS and arbitrary config.
 const env={};
 for (const key of ['HOME','PATH','TMPDIR','SUPABASE_ACCESS_TOKEN']) if (process.env[key]) env[key]=process.env[key];
 if (!env.HOME || !env.PATH) throw fail('CLI environment unavailable');
 env.NO_COLOR='1'; env.SUPABASE_TELEMETRY_DISABLED='true';
 return env;
}
function invokeCli(state,dryRun) {
 const args=['db','push','--linked','--project-ref',state.manifest.projectRef,'--skip-vault','--include-all','--yes',...(dryRun?['--dry-run']:[])];
 const result=spawnSync(PINNED_CLI,args,{cwd:state.directory,env:cliEnvironment(),encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90_000,maxBuffer:4*1024*1024});
 // Never forward raw output, which may include temporary credentials or SQL.
 if (result.error || result.signal || result.status!==0) throwPrivateCliFailure({projectRef:state.manifest.projectRef,phase:dryRun?'dry-run':'apply',identity:state.manifest.identity},result);
 return String(result.stdout??'')+'\n'+String(result.stderr??'');
}
export function runReviewedDryRun(request) {
 const state=verifiedManifest(request); verifiedApproval(request,state);
 const output=invokeCli(state,true);
 assertExactDryRun(output,[state.manifest.identity],0);
 const token=Object.freeze({identity:state.manifest.identity});
 dryRunTokens.set(token,{manifestSha256:request.manifestSha256,approvalSha256:request.approvalSha256,finishedAt:Date.now(),used:false});
 return token;
}
/** Explicit root-owner API only; default CLI entry point remains offline.
 * Returns pending verification: capture, inspect, and review the actual ledger
 * and catalog before preparing the next single migration. */
export function executeReviewedStep(request,token) {
 const state=assertReleaseReadiness(request,token);
 dryRunTokens.get(token).used=true;
 invokeCli(state,false);
 dryRunTokens.get(token).appliedAt=Date.now();
 return {projectRef:state.manifest.projectRef,identity:state.manifest.identity,applied:true,verificationRequired:true};
}
export function verifyAppliedStep(request,token,postCapture) {
 const record=dryRunTokens.get(token);
 if (!record?.appliedAt || record.manifestSha256!==request.manifestSha256) throw fail('successful owner apply token required');
 const state=verifiedManifest(request), post=loadCapture(state.manifest.target,postCapture);
 freshCapture(post,Date.now());
 if (Date.parse(post.capturedAt)<record.appliedAt || Date.parse(post.catalogCapturedAt)<record.appliedAt) throw fail('post-apply capture required');
 const row=post.ledger.find(r=>`${r.version}_${r.name}`===state.manifest.identity);
 if (!row || !Array.isArray(row.statements) || !row.statements.length) throw fail('truthful new migration history required');
 const receipt={identity:state.manifest.identity,ledgerRowSha256:sha256(canonical(row))};
 const completed=[...state.manifest.completed,receipt];
 assertCapturedProgress(state.manifest.target,loadPinnedEvidence(state.manifest.target),post,completed);
 return {verified:true,receipt,completed,nextIdentity:releaseSequence(state.manifest.target)[completed.length]??null,independentReviewRequired:true};
}
