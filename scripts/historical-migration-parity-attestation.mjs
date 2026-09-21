/** One immutable historical identity attestation. Never repairs migration history. */
export const REMINDER_ATTESTATION = Object.freeze({
  target: 'production', project: 'qahnczmilgptcedaqype', name: 'automated_communication_reminder_kinds',
  file: '20260915120000_automated_communication_reminder_kinds.sql',
  sourceSha256: '26b0070e4326528ca654b6d1486c64bd3859d68de389043374570c81dce9f0fe',
  statements: Object.freeze({
    '20260915120000': 'adc09111f8e299bcf90d432b90c0f6dfe119044cbe830d0bd54f441c9df94530',
    '20260916063005': '230a957a6ae5b36842cf802e14b3cca2aaa758c4708fd839f9346368134ea47b',
  }),
});
export const REVIEWED_REMINDER_CONSTRAINTS = Object.freeze({
  portal_reminder_records_kind_check: '89fb76a2f4cfc607f72af4639fe06fc5e1e9d93258268020bc8f64bea34f2603',
  portal_reminder_records_role_check: '35cc35596b4e9c045bcf0e44987608cc7ac91a8d8ecaed7f6ed74d2b4461b974',
  portal_reminder_records_lead_check: 'ad1f4d9d3302d953256be1091e162972cf27fc28a51fa95aba44eb079efd39ff',
  work_order_vendor_offers_status_check: 'ab04751a08a28adec1217a662d95a4454025d5bbd861dcb020ab1dbf5b5fb697',
});
export const REVIEWED_EXPIRY_INDEX = "CREATE INDEX work_order_vendor_offers_expires_idx ON public.work_order_vendor_offers USING btree (expires_at) WHERE (status = 'sent'::text)";

// JSON string encoding comes from PostgreSQL, preserving spaces inside values.
// This is compact JSON.stringify(text[]), not jsonb::text with whitespace removed.
// Historical statement bodies never leave PostgreSQL.
export const COMPACT_STATEMENTS_SHA_SQL = `case when statements is null then null else
 encode(sha256(convert_to('[' || coalesce((select string_agg(coalesce(to_json(item)::text,'null'),',' order by ordinal)
 from unnest(statements) with ordinality as items(item,ordinal)),'') || ']','UTF8')),'hex') end`;
export const REMINDER_SCHEMA_SQL = `select jsonb_build_object(
 'constraints',(select coalesce(jsonb_agg(jsonb_build_object('name',k.conname,'table',c.relname,'validated',k.convalidated,
 'sha256',encode(sha256(convert_to('CONSTRAINT '||k.conname||' '||pg_get_constraintdef(k.oid),'UTF8')),'hex')) order by k.conname),'[]'::jsonb)
 from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and k.conname = any($1::text[])),
 'columns',(select coalesce(jsonb_agg(jsonb_build_object('type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,
 'default',pg_get_expr(d.adbin,d.adrelid))),'[]'::jsonb) from pg_attribute a join pg_class c on c.oid=a.attrelid
 join pg_namespace n on n.oid=c.relnamespace left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
 where n.nspname='public' and c.relname='work_order_vendor_offers' and a.attname='expires_at' and a.attnum>0 and not a.attisdropped),
 'indexes',(select coalesce(jsonb_agg(jsonb_build_object('definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready)),'[]'::jsonb)
 from pg_index i join pg_class x on x.oid=i.indexrelid join pg_class c on c.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname='work_order_vendor_offers' and x.relname='work_order_vendor_offers_expires_idx')
) as evidence`;

export function attestHistoricalReminderDuplicate({target,project,local,applied,sourceSha256,schema,problems}) {
  const no = (reason) => ({accepted:false,reason});
  if (target!==REMINDER_ATTESTATION.target || project!==REMINDER_ATTESTATION.project) return no('target');
  if (sourceSha256!==REMINDER_ATTESTATION.sourceSha256) return no('source');
  if (!Array.isArray(problems) || problems.some((p)=>p.source==='repo' || p.kind==='duplicate-version')) return no('identity');
  const canonical=local.filter((r)=>r.name===REMINDER_ATTESTATION.name);
  if (canonical.length!==1 || canonical[0].version!=='20260915120000') return no('local-identity');
  const pair=applied.filter((r)=>r.name===REMINDER_ATTESTATION.name);
  if (pair.length!==2 || new Set(pair.map((r)=>r.version)).size!==2 || pair.some((r)=>
    !Object.hasOwn(REMINDER_ATTESTATION.statements,r.version) || r.statementsSha256!==REMINDER_ATTESTATION.statements[r.version])) return no('historical-pair');
  const duplicate=problems.filter((p)=>p.source==='database' && p.kind==='duplicate-name' && p.name===REMINDER_ATTESTATION.name);
  if (duplicate.length!==1 || !Object.hasOwn(REMINDER_ATTESTATION.statements,duplicate[0].version)) return no('duplicate-problem');
  if (!schema || !Array.isArray(schema.constraints) || schema.constraints.length!==4 || Object.entries(REVIEWED_REMINDER_CONSTRAINTS).some(([name,hash])=>{
    const matches=schema.constraints.filter((c)=>c.name===name);
    const table=name.startsWith('portal_')?'portal_reminder_records':'work_order_vendor_offers';
    return matches.length!==1 || matches[0].table!==table || matches[0].sha256!==hash || matches[0].validated!==true;
  })) return no('constraints');
  if (!Array.isArray(schema.columns) || schema.columns.length!==1 || schema.columns[0].type!=='timestamp with time zone'
    || schema.columns[0].notNull!==false || schema.columns[0].default!==null) return no('expiry-column');
  if (!Array.isArray(schema.indexes) || schema.indexes.length!==1 || schema.indexes[0].definition!==REVIEWED_EXPIRY_INDEX
    || schema.indexes[0].valid!==true || schema.indexes[0].ready!==true) return no('expiry-index');
  return {accepted:true,problem:duplicate[0],warning:{name:REMINDER_ATTESTATION.name,versions:Object.keys(REMINDER_ATTESTATION.statements),
    message:'Audited historical duplicate preserved; exact source, statement hashes and current schema verified.'}};
}
