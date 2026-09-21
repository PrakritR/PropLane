/** Offline only. Preparation does not authorize or execute any database change. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS, sha256, assertTransactionalSql, ledgerRowDigest, validateSnapshot, parseArgs } from './prepare-test-workspace-release-migrations.mjs';

const SOURCE_DIR = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
const PINS = Object.freeze([
  ['20260916140000_team_delivery_recipient_key', '9fa78347b89f0a43bd0e247e90e4bf874407d944be2d8d0e987fa314f1293ac0'],
  ['20260917010000_invite_workspace', 'c2bdaeaf6b5fc78ad4a2b36a85d57e26cd8c14446054b6a74f71093aef8ab5a8'],
  ['20260918153000_workspace_permissions', '33daaa488aeda67acc6539a268ddc57c4b8c1c22077cb2d6821905eb52000bdb'],
  ['20260918180000_account_link_team_role', '5c88cf478d034945ea5483b426fe9d6d3832dc58cb9c59624148300c2daa5838'],
  ['20260919010000_booking_com_calendar_provider', 'a5ba46c5a08f55c5963b8b256ebb73a4b64efc1fcd90fc80da02eb9be553f964'],
]);
const TABLES = ['account_link_invites', 'manager_invite_links', 'external_calendar_connections'];
export const REVIEWED_RECOVERY_BODIES = Object.freeze({
  account_identity_hash: '0a6f0868bd3f9eb1807917c5c91b9c3ada34d64dd91672640796d4ebf3ff3d2f',
  account_json_has_deleted_identity: 'aab62e5f85dd165f746cef284d7971aaf5e1b3e1d481efb326bd71f170b6e58c',
  account_recovery_write_guard: 'bf41bc54ac8d286b3648b363ffcd82bd78544f3067d222dc00bc81927ba23271',
  account_recovery_capture_delete: '896fb2dc02b8c3d823921ab6ad6a79fe00ad214b7b2695cbdfa3b1362fa014a9',
  account_recovery_key_hash: '28310e82beebfddb889787f8e7eb0021e1683f82d480c5d026cee95c1fb4f44a',
  account_recovery_matches: '7ad2f8467c4f73844609f149f3cf2cbd1bca7654e4ea926dc2c634b3e34b2a36',
  account_recovery_recreatable: 'ef1f65a72697b68f7d8e82c55d48fa924877c7e7361a440f96b15d411d1476a4',
  account_recovery_row_key: '00eab500b27d4b37d75e6f41e22ac4c768b2ac5b2d4bc11f632d73b7c490e44e',
});
// Exact pg_get_functiondef fingerprints from both reviewed target captures. These
// cover signatures, language, volatility, strictness, security mode and all SET
// clauses (including search_path). Body-only equality cannot authorize a GUC.
export const REVIEWED_RECOVERY_DEFINITIONS = Object.freeze({
  "account_identity_hash": {
    "identity": "value text",
    "definitionSha256": "e4946f0ddac14b6bb840d9b5d73baff856c486996cbf208608bcc4a5b68cb466",
    "acl": "{postgres=X/postgres,service_role=X/postgres}"
  },
  "account_json_has_deleted_identity": {
    "identity": "value jsonb, hashes text[]",
    "definitionSha256": "0c440ebc0a6e0880850b1ad396dc90796ee38d9bbe5a257b5d61be1720c3ff1e",
    "acl": "{postgres=X/postgres,service_role=X/postgres}"
  },
  "account_recovery_capture_delete": {
    "identity": "",
    "definitionSha256": "9d826c65dd2abdf565da8b7b3860475f841d1a1cf4fab295a51d17b29cbae699",
    "acl": "{postgres=X/postgres,service_role=X/postgres}"
  },
  "account_recovery_key_hash": {
    "identity": "p_key jsonb",
    "definitionSha256": "896b6355b5d7b0c710b4d95c6f0f35cfa528112a2f85aecac554f29d020cecd6",
    "acl": "{postgres=X/postgres,service_role=X/postgres}"
  },
  "account_recovery_matches": {
    "identity": "p_row jsonb, p_rule jsonb, p_user uuid, p_email text, p_reference boolean",
    "definitionSha256": "062f571336da86c02029dc00500f79d12ef9310b3a1d2bdd3fef00cb3197b25d",
    "acl": "{postgres=X/postgres,service_role=X/postgres}"
  },
  "account_recovery_recreatable": {
    "identity": "p_table text",
    "definitionSha256": "ad987a3515b128dbd697d60e638fcb4b1947f17d1f71f4ecf13fa8681775532c",
    "acl": "{postgres=X/postgres,service_role=X/postgres}"
  },
  "account_recovery_row_key": {
    "identity": "p_table text, p_row jsonb",
    "definitionSha256": "41b6d4f26b7b8e51414fa7f8ba1772aca6abf8ddcc8d8480023b7fdbedf0f304",
    "acl": "{postgres=X/postgres,service_role=X/postgres}"
  },
  "account_recovery_write_guard": {
    "identity": "",
    "definitionSha256": "a5b3bbc6bd00ba0e8b0f8f92d2048ab0a84dc8a35af03904e74a994d80ef5134",
    "acl": "{postgres=X/postgres,service_role=X/postgres}"
  }
});
export const REVIEWED_INVITATION_TRIGGERS = Object.freeze([
  {
    "name": "account_recovery_capture_delete",
    "type": 9,
    "table": "account_link_invites",
    "schema": "public",
    "enabled": "O",
    "function": "account_recovery_capture_delete",
    "definition": "CREATE TRIGGER account_recovery_capture_delete AFTER DELETE ON public.account_link_invites FOR EACH ROW EXECUTE FUNCTION account_recovery_capture_delete()"
  },
  {
    "name": "account_recovery_write_guard",
    "type": 31,
    "table": "account_link_invites",
    "schema": "public",
    "enabled": "O",
    "function": "account_recovery_write_guard",
    "definition": "CREATE TRIGGER account_recovery_write_guard BEFORE INSERT OR DELETE OR UPDATE ON public.account_link_invites FOR EACH ROW EXECUTE FUNCTION account_recovery_write_guard()"
  }
]);
export const REVIEWED_BASELINE_CHECKS = Object.freeze([
  {
    "name": "account_link_invites_team_role_check",
    "table": "account_link_invites",
    "validated": true,
    "definition": "CHECK (((team_role IS NULL) OR (team_role = ANY (ARRAY['viewer'::text, 'leasing'::text, 'property_manager'::text, 'bookkeeper'::text, 'maintenance'::text, 'full'::text, 'custom'::text]))))"
  },
  {
    "name": "external_calendar_connections_provider_check",
    "table": "external_calendar_connections",
    "validated": true,
    "definition": "CHECK ((provider = ANY (ARRAY['airbnb'::text, 'booking_com'::text])))"
  },
  {
    "name": "manager_invite_links_team_role_check",
    "table": "manager_invite_links",
    "validated": true,
    "definition": "CHECK (((team_role IS NULL) OR (team_role = ANY (ARRAY['viewer'::text, 'leasing'::text, 'property_manager'::text, 'bookkeeper'::text, 'maintenance'::text, 'full'::text, 'custom'::text]))))"
  }
]);
const literal = (s) => `'${s.replaceAll("'", "''")}'`;
const json = (v) => `${literal(JSON.stringify(v))}::jsonb`;
const names = (items) => items.map(literal).join(',');
const fingerprints = (rows) => [...rows].sort((a,b) => a.version < b.version ? -1 : a.version > b.version ? 1 : 0)
  .map((r) => ({ version: r.version, name: r.name, sha256: ledgerRowDigest(r) }));

// Exported for root-owned read-only capture. No SQL is executed by this module.
// Definitions are hashed in PostgreSQL so private function bodies never enter output artifacts.
export const BASELINE_CATALOG_SQL = `(select jsonb_build_object(
  'columns', (select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) order by c.relname,a.attnum),'[]'::jsonb)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where n.nspname='public' and c.relname in (${names(TABLES)})),
  'constraints', (select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',k.conname,'definition',pg_get_constraintdef(k.oid),'validated',k.convalidated) order by c.relname,k.conname),'[]'::jsonb)
    from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in (${names(TABLES)})),
  'indexes', (select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',i.relname,'definition',pg_get_indexdef(x.indexrelid),'valid',x.indisvalid) order by c.relname,i.relname),'[]'::jsonb)
    from pg_index x join pg_class c on c.oid=x.indrelid join pg_class i on i.oid=x.indexrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in (${names(TABLES)})),
  'triggers', (select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',t.tgname,'type',t.tgtype,'enabled',t.tgenabled,'function',p.proname,'schema',pn.nspname,'definition',pg_get_triggerdef(t.oid)) order by c.relname,t.tgname),'[]'::jsonb)
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace join pg_proc p on p.oid=t.tgfoid join pg_namespace pn on pn.oid=p.pronamespace
    where not t.tgisinternal and n.nspname='public' and c.relname in (${names(TABLES)})),
  'rules', (select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',w.rulename,'definition',pg_get_ruledef(w.oid)) order by c.relname,w.rulename),'[]'::jsonb)
    from pg_rewrite w join pg_class c on c.oid=w.ev_class join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in (${names(TABLES)})),
  'functions', (select coalesce(jsonb_agg(jsonb_build_object('name',p.proname,'identity',pg_get_function_identity_arguments(p.oid),'bodySha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'definitionSha256',encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex'),'acl',p.proacl::text) order by p.proname,pg_get_function_identity_arguments(p.oid)),'[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'account_recovery_%' or p.proname in ('account_identity_hash','account_json_has_deleted_identity','persist_lease_with_action_event')))
))`;
const ROW_DIGEST_SQL = `encode(sha256(convert_to('S'||octet_length(version)::text||':'||version ||
 case when name is null then 'N' else 'S'||octet_length(name)::text||':'||name end ||
 case when statements is null then 'N' else 'A'||cardinality(statements)::text||':'||coalesce((select string_agg(case when item is null then 'N' else 'S'||octet_length(item)::text||':'||item end,'' order by ordinal) from unnest(statements) with ordinality as items(item,ordinal)),'') end,'UTF8')),'hex')`;
const LEDGER_SQL = `(select coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name,'sha256',digest) order by version collate "C"),'[]'::jsonb) from (select version,name,${ROW_DIGEST_SQL} digest from supabase_migrations.schema_migrations) d)`;
const TABLE_INVENTORY_SQL = `(select coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'rls',c.relrowsecurity) order by c.relname collate "C"),'[]'::jsonb) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p'))`;
export const INVITATION_DIGEST_SQL = `(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(i) order by i.id)::text,'[]'),'UTF8')),'hex') from public.account_link_invites i)`;
export const ZERO_PERMISSION_CHANGE_SQL = `NOT EXISTS (SELECT 1 FROM public.account_link_invites WHERE status IN ('pending','accepted') AND
 (jsonb_typeof(workspace_permissions) IS DISTINCT FROM 'object' OR workspace_permissions IS DISTINCT FROM
 (coalesce(workspace_permissions,'{}'::jsonb) || '{"addProperties":true}'::jsonb)))`;

export function baselineMigrations(target, readSource = (file) => readFileSync(join(SOURCE_DIR,file))) {
  if (!Object.hasOwn(TARGETS,target)) throw new Error('Exact staging or production target required.');
  return PINS.filter((_,i) => target === 'production' || i !== 0).map(([stem,hash]) => {
    const file = `${stem}.sql`; const bytes = readSource(file);
    if (sha256(bytes) !== hash) throw new Error(`Immutable baseline source changed: ${file}`);
    const sql = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes;
    assertTransactionalSql(sql);
    return {file,version:stem.slice(0,14),name:stem.slice(15),sha256:hash,sql,statements:[sql]};
  });
}

export function validateBaselineCatalog(catalog) {
  if (!catalog || ['columns','constraints','indexes','triggers','rules','functions'].some((k) => !Array.isArray(catalog[k]))) throw new Error('Complete baselineCatalog capture required.');
  if (catalog.rules.length) throw new Error('Unexpected baseline table rules.');
  for (const [name,hash] of Object.entries(REVIEWED_RECOVERY_BODIES)) {
    const matches = catalog.functions.filter((f) => f.name === name);
    if (matches.length !== 1 || matches[0].bodySha256 !== hash
      || Object.entries(REVIEWED_RECOVERY_DEFINITIONS[name]).some(([key,value]) => matches[0][key] !== value)) throw new Error(`Reviewed recovery function drift: ${name}`);
  }
  const triggers = catalog.triggers.filter((t) => t.table === 'account_link_invites');
  if (triggers.length !== REVIEWED_INVITATION_TRIGGERS.length || REVIEWED_INVITATION_TRIGGERS.some((expected) =>
    !triggers.some((actual) => Object.entries(expected).every(([key,value]) => actual[key] === value)))) throw new Error('Unexpected or disabled invitation recovery triggers.');
  for (const name of ['account_identity_hash','account_json_has_deleted_identity']) {
    if (catalog.functions.filter((f) => f.name === name).length !== 1) throw new Error(`Missing recovery helper: ${name}`);
  }
  if (catalog.constraints.some((c) => c.validated !== true) || catalog.indexes.some((i) => i.valid !== true)) throw new Error('Invalid baseline constraints or indexes.');
  for (const expected of REVIEWED_BASELINE_CHECKS) {
    const matches=catalog.constraints.filter((c) => c.table===expected.table && c.name===expected.name);
    if (matches.length!==1 || matches[0].definition!==expected.definition || matches[0].validated!==true) throw new Error('Existing role/provider check differs from reviewed schema.');
  }
  if (catalog.indexes.some((i) => i.name==='manager_invite_links_workspace_idx')) throw new Error('Unledgered invite workspace index.');
  const col = (table,name,type,notNull) => catalog.columns.some((c) => c.table===table && c.name===name && c.type===type && c.notNull===notNull);
  if (!col('account_link_invites','workspace_permissions','jsonb',true) || !col('account_link_invites','workspace_id','uuid',false)
    || !col('account_link_invites','team_role','text',false) || !col('manager_invite_links','team_role','text',false)) throw new Error('Unexpected existing workspace schema.');
  if (catalog.columns.some((c) => c.table==='manager_invite_links' && ['workspace_id','workspace_name_snapshot','property_labels','token_ciphertext'].includes(c.name))) throw new Error('Unledgered partial invite-workspace schema.');
  if (!catalog.constraints.some((c) => c.table==='account_link_invites' && c.name==='account_link_invites_workspace_id_fkey' && c.definition==='FOREIGN KEY (workspace_id) REFERENCES portal_workspaces(id) ON DELETE SET NULL')
    || !catalog.indexes.some((i) => i.table==='account_link_invites' && i.name==='account_link_invites_workspace_idx' && i.definition==='CREATE INDEX account_link_invites_workspace_idx ON public.account_link_invites USING btree (workspace_id)')
    || !catalog.columns.some((c) => c.table==='account_link_invites' && c.name==='workspace_permissions' && c.default==="'{}'::jsonb")) throw new Error('Workspace FK/index/default differs from canonical schema.');
  if (catalog.functions.some((f) => !/^[a-f0-9]{64}$/.test(f.definitionSha256 ?? ''))) throw new Error('Exact function definition digests required.');
  return catalog;
}

export function buildBaselineBundle({target,snapshot,backupSha256,readSource}) {
  const migrations = baselineMigrations(target,readSource);
  const state = validateSnapshot(snapshot,target);
  const present = migrations.filter((m) => {
    const matches = state.ledger.filter((r) => r.version===m.version || r.name===m.name);
    if (matches.length>1 || (matches.length===1 && ledgerRowDigest(matches[0])!==ledgerRowDigest(m))) throw new Error('Conflicting baseline migration identity or statements.');
    return matches.length===1;
  });
  if (present.length===migrations.length) return {sql:null,plan:{status:'already_complete',target,project:TARGETS[target]}};
  if (present.length) throw new Error('Partial baseline state requires separate review.');
  if (!/^[a-f0-9]{64}$/.test(backupSha256 ?? '')) throw new Error('Verified backup-manifest SHA-256 required.');
  if (typeof snapshot.invitationRowsSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.invitationRowsSha256)) throw new Error('Reviewed invitationRowsSha256 is required.');
  const catalog = validateBaselineCatalog(snapshot.baselineCatalog);
  const finalLedger = fingerprints([...state.ledger,...migrations]);
  const inserts = migrations.map((m) => `INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES (${literal(m.version)},${literal(m.name)},ARRAY[${literal(m.sql)}]::text[]);`).join('\n');
  const productionFunction = migrations.find((m) => m.version==='20260916140000');
  const body = productionFunction && /as\s+\$\$([\s\S]*?)\$\$/i.exec(productionFunction.sql)?.[1];
  if (productionFunction && !body) throw new Error('Pinned function body missing.');
  const sql = `-- OFFLINE prerequisite artifact; root verifies actual endpoint and backups independently.
BEGIN;
SET LOCAL standard_conforming_strings = on;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SET LOCAL idle_in_transaction_session_timeout = '180s';
DO $baseline_identity$ BEGIN
 IF current_setting('proplane.release_project_ref',true) IS DISTINCT FROM ${literal(TARGETS[target])}
 OR current_setting('proplane.release_backup_sha256',true) IS DISTINCT FROM ${literal(backupSha256)}
 THEN RAISE EXCEPTION 'Target or backup attestation rejected'; END IF;
 IF current_setting('session_replication_role') IS DISTINCT FROM 'origin' THEN RAISE EXCEPTION 'Origin replication mode required'; END IF;
 IF current_setting('server_encoding') <> 'UTF8' OR current_setting('proplane.account_recovery_internal',true)='on'
 THEN RAISE EXCEPTION 'Encoding or recovery bypass rejected'; END IF;
END $baseline_identity$;
LOCK TABLE supabase_migrations.schema_migrations IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.account_link_invites IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.manager_invite_links, public.external_calendar_connections IN SHARE ROW EXCLUSIVE MODE;
DO $baseline_before$ BEGIN
 IF NOT pg_try_advisory_xact_lock(20260919123000::bigint) THEN RAISE EXCEPTION 'Release already locked'; END IF;
 IF ${LEDGER_SQL} IS DISTINCT FROM ${json(fingerprints(state.ledger))} THEN RAISE EXCEPTION 'Historical ledger drift'; END IF;
 IF ${TABLE_INVENTORY_SQL} IS DISTINCT FROM ${json(state.tables)} THEN RAISE EXCEPTION 'Public table inventory drift'; END IF;
 IF ${BASELINE_CATALOG_SQL} IS DISTINCT FROM ${json(catalog)} THEN RAISE EXCEPTION 'Baseline schema or trigger drift'; END IF;
 IF ${INVITATION_DIGEST_SQL} IS DISTINCT FROM ${literal(snapshot.invitationRowsSha256)} THEN RAISE EXCEPTION 'Reviewed invitation beforeimage changed'; END IF;
 IF NOT (${ZERO_PERMISSION_CHANGE_SQL}) THEN RAISE EXCEPTION 'Permission change prohibited'; END IF;
END $baseline_before$;
CREATE TEMP TABLE baseline_invitation_evidence(digest text NOT NULL) ON COMMIT DROP;
INSERT INTO pg_temp.baseline_invitation_evidence SELECT ${INVITATION_DIGEST_SQL};
${migrations.map((m) => `-- Canonical ${m.file}\n${m.sql}`).join('\n')}
${inserts}
DO $baseline_after$ BEGIN
 IF ${INVITATION_DIGEST_SQL} IS DISTINCT FROM (SELECT digest FROM pg_temp.baseline_invitation_evidence)
 THEN RAISE EXCEPTION 'Invitation row change prohibited'; END IF;
 IF NOT (${ZERO_PERMISSION_CHANGE_SQL}) THEN RAISE EXCEPTION 'Permission postcondition failed'; END IF;
 IF (${BASELINE_CATALOG_SQL})->'triggers' IS DISTINCT FROM ${json(catalog.triggers)} OR (${BASELINE_CATALOG_SQL})->'rules' IS DISTINCT FROM ${json(catalog.rules)} THEN RAISE EXCEPTION 'Trigger or rule changed during replay'; END IF;
 IF ${TABLE_INVENTORY_SQL} IS DISTINCT FROM ${json(state.tables)} THEN RAISE EXCEPTION 'Public table inventory changed'; END IF;
 IF ${LEDGER_SQL} IS DISTINCT FROM ${json(finalLedger)} THEN RAISE EXCEPTION 'Final exact ledger mismatch'; END IF;
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='manager_invite_links' AND column_name='workspace_id' AND data_type='uuid')
 OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='manager_invite_links' AND column_name='workspace_name_snapshot' AND data_type='text')
 OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='manager_invite_links' AND column_name='token_ciphertext' AND data_type='text')
 OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='manager_invite_links' AND column_name='property_labels' AND data_type='jsonb' AND is_nullable='NO' AND column_default='''[]''::jsonb')
 THEN RAISE EXCEPTION 'Invite workspace columns missing'; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.manager_invite_links'::regclass AND conname='manager_invite_links_workspace_id_fkey' AND contype='f' AND confrelid='public.portal_workspaces'::regclass AND confdeltype='n' AND convalidated AND pg_get_constraintdef(oid)='FOREIGN KEY (workspace_id) REFERENCES portal_workspaces(id) ON DELETE SET NULL')
 OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.manager_invite_links_workspace_idx') AND indisvalid AND pg_get_indexdef(indexrelid)='CREATE INDEX manager_invite_links_workspace_idx ON public.manager_invite_links USING btree (workspace_id)')
 THEN RAISE EXCEPTION 'Invite workspace FK/index missing'; END IF;
 IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.account_link_invites'::regclass AND conname='account_link_invites_team_role_check') IS DISTINCT FROM 'CHECK (((team_role IS NULL) OR (team_role = ANY (ARRAY[''viewer''::text, ''leasing''::text, ''property_manager''::text, ''bookkeeper''::text, ''maintenance''::text, ''full''::text, ''custom''::text]))))'
 OR (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.manager_invite_links'::regclass AND conname='manager_invite_links_team_role_check') IS DISTINCT FROM 'CHECK (((team_role IS NULL) OR (team_role = ANY (ARRAY[''viewer''::text, ''leasing''::text, ''property_manager''::text, ''bookkeeper''::text, ''maintenance''::text, ''full''::text, ''custom''::text]))))'
 OR (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.external_calendar_connections'::regclass AND conname='external_calendar_connections_provider_check') IS DISTINCT FROM 'CHECK ((provider = ANY (ARRAY[''airbnb''::text, ''booking_com''::text])))'
 THEN RAISE EXCEPTION 'Role or calendar constraint postcondition failed'; END IF;
 ${body ? `IF (SELECT prosrc FROM pg_proc WHERE oid='public.persist_lease_with_action_event(jsonb,timestamptz,jsonb)'::regprocedure) IS DISTINCT FROM ${literal(body)} THEN RAISE EXCEPTION 'Team recipient function mismatch'; END IF;` : ''}
 IF has_function_privilege('anon','public.persist_lease_with_action_event(jsonb,timestamptz,jsonb)','EXECUTE') OR has_function_privilege('authenticated','public.persist_lease_with_action_event(jsonb,timestamptz,jsonb)','EXECUTE') OR NOT has_function_privilege('service_role','public.persist_lease_with_action_event(jsonb,timestamptz,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Lease RPC privilege mismatch'; END IF;
END $baseline_after$;
COMMIT;
`;
  // SQL string escaping does not escape a surrounding dollar-quoted DO body.
  // Fail before emitting any artifact if captured text collides with its tags.
  for (const tag of ['$baseline_identity$','$baseline_before$','$baseline_after$']) {
    if (sql.split(tag).length !== 3) throw new Error('Captured text contains a reserved DO delimiter collision.');
  }
  return {sql,plan:{status:'ready',target,project:TARGETS[target],backupSha256,invitationRowsSha256:snapshot.invitationRowsSha256,bundleSha256:sha256(sql),baselineCatalogSha256:sha256(JSON.stringify(catalog)),migrations:migrations.map(({file,version,name,sha256:hash}) => ({file,version,name,sha256:hash})),historicalLedger:fingerprints(state.ledger),limitations:['Offline preparation only; root must independently verify actual target and backups.','Fresh independent review and local rehearsal required before application.']}};
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!Object.keys(args).length) {
    baselineMigrations('production');
    console.log(JSON.stringify({status:'manifest_only',targets:TARGETS,migrations:PINS.map(([name,hash])=>({file:`${name}.sql`,sha256:hash})),baselineCatalogSql:BASELINE_CATALOG_SQL},null,2)); return;
  }
  const bundle=buildBaselineBundle({target:args['--target'],snapshot:JSON.parse(readFileSync(args['--snapshot'],'utf8')),backupSha256:args['--backup-sha256']});
  if (!bundle.sql) { console.log(JSON.stringify(bundle.plan)); return; }
  const output=resolve(args['--out']); mkdirSync(output,{mode:0o700});
  writeFileSync(join(output,'bundle.sql'),bundle.sql,{flag:'wx',mode:0o600});
  writeFileSync(join(output,'plan.json'),JSON.stringify(bundle.plan,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({status:'ready',output,bundleSha256:bundle.plan.bundleSha256}));
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : 'Preparation refused.'); process.exitCode=1; }
}
