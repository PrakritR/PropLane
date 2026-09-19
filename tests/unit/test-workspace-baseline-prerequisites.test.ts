import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TARGETS } from '../../scripts/prepare-test-workspace-release-migrations.mjs';
import {
  baselineMigrations, buildBaselineBundle, REVIEWED_RECOVERY_BODIES, REVIEWED_RECOVERY_DEFINITIONS,
  REVIEWED_INVITATION_TRIGGERS, REVIEWED_BASELINE_CHECKS, ZERO_PERMISSION_CHANGE_SQL,
} from '../../scripts/prepare-test-workspace-baseline-prerequisites.mjs';

function snapshot(target: 'staging' | 'production' = 'staging') {
  return {project: TARGETS[target], read_only:'on', invitationRowsSha256:'e'.repeat(64), tables:[{name:'account_link_invites',rls:true}],
    ledger:[{version:'20200101000000',name:'duplicate_history',statements:["select 'private 🛩️';",null]},
      {version:'20200102000000',name:'duplicate_history',statements:null}],
    baselineCatalog:{
      columns:[
        {table:'account_link_invites',name:'workspace_permissions',type:'jsonb',notNull:true,default:"'{}'::jsonb"},
        {table:'account_link_invites',name:'workspace_id',type:'uuid',notNull:false},
        {table:'account_link_invites',name:'team_role',type:'text',notNull:false},
        {table:'manager_invite_links',name:'team_role',type:'text',notNull:false},
      ],
      constraints:[...structuredClone(REVIEWED_BASELINE_CHECKS),{table:'account_link_invites',name:'account_link_invites_workspace_id_fkey',definition:'FOREIGN KEY (workspace_id) REFERENCES portal_workspaces(id) ON DELETE SET NULL',validated:true}],
      indexes:[{table:'account_link_invites',name:'account_link_invites_workspace_idx',definition:'CREATE INDEX account_link_invites_workspace_idx ON public.account_link_invites USING btree (workspace_id)',valid:true}],
      rules:[],
      triggers:structuredClone(REVIEWED_INVITATION_TRIGGERS),
      functions:Object.entries(REVIEWED_RECOVERY_BODIES).map(([name,bodySha256])=>({name,bodySha256,...REVIEWED_RECOVERY_DEFINITIONS[name]})),
    }};
}
const backupSha256='b'.repeat(64);
const prepare=(s=snapshot())=>buildBaselineBundle({target:'staging',snapshot:s,backupSha256});

describe('offline canonical baseline prerequisite preparation',()=>{
  it('selects exactly four staging and five production immutable sources',()=>{
    expect(baselineMigrations('staging')).toHaveLength(4);
    expect(baselineMigrations('production')).toHaveLength(5);
    expect(baselineMigrations('production')[0].version).toBe('20260916140000');
    for(const migration of baselineMigrations('production')) {
      expect(migration.statements).toEqual([readFileSync(new URL(`../../supabase/migrations/${migration.file}`,import.meta.url),'utf8')]);
    }
    expect(()=>baselineMigrations('production',()=>Buffer.from('select 1;'))).toThrow(/source changed/);
  });
  it('keeps historical duplicate names/nulls/Unicode private and appends only canonical entries',()=>{
    const result=prepare();
    expect(result.plan.historicalLedger).toHaveLength(2);
    expect(result.sql).not.toContain('private 🛩️');
    expect(result.sql?.match(/INSERT INTO supabase_migrations.schema_migrations/g)).toHaveLength(4);
    expect(result.sql).not.toMatch(/(?:DELETE FROM|UPDATE) supabase_migrations.schema_migrations/i);
    for(const m of baselineMigrations('staging')) expect(result.sql).toContain(m.sql);
  });
  it('places locked null-safe zero-change guard before all canonical DDL',()=>{
    const sql=prepare().sql!;
    const guard=sql.indexOf('Permission change prohibited');
    expect(sql.indexOf('LOCK TABLE public.account_link_invites IN SHARE ROW EXCLUSIVE MODE')).toBeLessThan(guard);
    expect(guard).toBeLessThan(sql.indexOf('-- Canonical'));
    expect(ZERO_PERMISSION_CHANGE_SQL).toContain("jsonb_typeof(workspace_permissions) IS DISTINCT FROM 'object'");
    expect(ZERO_PERMISSION_CHANGE_SQL).toContain("coalesce(workspace_permissions,'{}'::jsonb) || '{\"addProperties\":true}'::jsonb");
    expect(sql).toContain("current_setting('session_replication_role') IS DISTINCT FROM 'origin'");
    expect(sql.indexOf('Origin replication mode required')).toBeLessThan(sql.indexOf('-- Canonical'));
    expect(sql).toContain('Invitation row change prohibited');
    expect(sql).toContain('Final exact ledger mismatch');
    expect(sql).toContain('Baseline schema or trigger drift');
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
  });
  it('refuses wrong target, absent backup, incomplete metadata and recovery drift',()=>{
    expect(()=>buildBaselineBundle({target:'production',snapshot:snapshot(),backupSha256})).toThrow(/exact-target/);
    expect(()=>buildBaselineBundle({target:'staging',snapshot:snapshot()})).toThrow(/backup/);
    const noCatalog={...snapshot(),baselineCatalog:undefined};
    expect(()=>prepare(noCatalog as never)).toThrow(/baselineCatalog/);
    const disabled=snapshot(); disabled.baselineCatalog.triggers[0].enabled='D';
    expect(()=>prepare(disabled)).toThrow(/triggers/);
    const drift=snapshot(); drift.baselineCatalog.functions[0].bodySha256='c'.repeat(64);
    expect(()=>prepare(drift)).toThrow(/function drift/);
    const schema=snapshot(); schema.baselineCatalog.columns[0].default="'[]'::jsonb";
    expect(()=>prepare(schema)).toThrow(/default/);
  });
  it.each(['function-local bypass GUC','changed search path','security mode'])('rejects %s despite an unchanged recovery body',()=>{
    const drift=snapshot();
    const guard=drift.baselineCatalog.functions.find((f: {name:string})=>f.name==='account_recovery_write_guard')!;
    // Every pg_get_functiondef change has a different digest, including SET clauses.
    guard.definitionSha256='d'.repeat(64);
    expect(()=>prepare(drift)).toThrow(/function drift/);
  });
  it('rejects a trigger WHEN clause and changed or missing preexisting constraints',()=>{
    const when=snapshot(); when.baselineCatalog.triggers[0].definition+=' WHEN (false)';
    expect(()=>prepare(when)).toThrow(/triggers/);
    const changed=snapshot(); changed.baselineCatalog.constraints[0].definition='CHECK (true)';
    expect(()=>prepare(changed)).toThrow(/role\/provider check/);
    const missing=snapshot(); missing.baselineCatalog.constraints.shift();
    expect(()=>prepare(missing)).toThrow(/role\/provider check/);
    const index=snapshot(); index.baselineCatalog.indexes[0].definition+=' WHERE false';
    expect(()=>prepare(index)).toThrow(/FK\/index\/default/);
  });
  it.each(['$baseline_identity$','$baseline_before$','$baseline_after$'])('refuses reserved delimiter %s in ledger names and catalog text',tag=>{
    const history=snapshot(); history.ledger[0].name=tag;
    expect(()=>prepare(history)).toThrow(/delimiter collision/);
    const catalog=snapshot();
    catalog.baselineCatalog.columns.push({table:'account_link_invites',name:'unrelated',type:'text',notNull:false,default:tag});
    expect(()=>prepare(catalog)).toThrow(/delimiter collision/);
  });
  it('requires a reviewed invitation digest and rejects mismatch before canonical DDL',()=>{
    const missing=snapshot(); delete (missing as Partial<typeof missing>).invitationRowsSha256;
    expect(()=>prepare(missing)).toThrow(/invitationRowsSha256/);
    const invalid=snapshot(); invalid.invitationRowsSha256='not-a-hash';
    expect(()=>prepare(invalid)).toThrow(/invitationRowsSha256/);
    const sql=prepare().sql!;
    expect(sql).toContain(`IS DISTINCT FROM '${'e'.repeat(64)}' THEN RAISE EXCEPTION 'Reviewed invitation beforeimage changed'`);
    expect(sql.indexOf('LOCK TABLE public.account_link_invites')).toBeLessThan(sql.indexOf('Reviewed invitation beforeimage changed'));
    expect(sql.indexOf('Reviewed invitation beforeimage changed')).toBeLessThan(sql.indexOf('-- Canonical'));
    const different=snapshot(); different.invitationRowsSha256='f'.repeat(64);
    expect(prepare(different).plan.bundleSha256).not.toBe(prepare().plan.bundleSha256);
  });
  it('refuses partial or conflicting ledger state and emits no SQL for a fully applied set',()=>{
    const migration=baselineMigrations('staging')[0];
    const partial=snapshot(); partial.ledger.push(migration);
    expect(()=>prepare(partial)).toThrow(/Partial baseline/);
    const conflict=snapshot(); conflict.ledger.push({...migration,statements:['select 1;']});
    expect(()=>prepare(conflict)).toThrow(/Conflicting/);
    const full=snapshot(); full.ledger.push(...baselineMigrations('staging'));
    expect(prepare(full)).toEqual({sql:null,plan:{status:'already_complete',target:'staging',project:TARGETS.staging}});
  });
});
