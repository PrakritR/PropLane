import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { diffMigrations, diffMigrationsWithAttestation, hasFatalMigrationDrift, readParitySnapshot } from '../../scripts/check-migration-parity.mjs';
import { REMINDER_ATTESTATION, REVIEWED_REMINDER_CONSTRAINTS, REVIEWED_EXPIRY_INDEX, COMPACT_STATEMENTS_SHA_SQL } from '../../scripts/historical-migration-parity-attestation.mjs';

const local=[{version:'20260915120000',name:REMINDER_ATTESTATION.name}];
const pair=()=>Object.entries(REMINDER_ATTESTATION.statements).map(([version,statementsSha256])=>({version,name:REMINDER_ATTESTATION.name,statementsSha256}));
function evidence() {
  return {target:'production',project:REMINDER_ATTESTATION.project,sourceSha256:REMINDER_ATTESTATION.sourceSha256,schema:{
    constraints:Object.entries(REVIEWED_REMINDER_CONSTRAINTS).map(([name,sha256])=>({name,sha256,table:name.startsWith('portal_')?'portal_reminder_records':'work_order_vendor_offers',validated:true})),
    columns:[{type:'timestamp with time zone',notNull:false,default:null}],
    indexes:[{definition:REVIEWED_EXPIRY_INDEX,valid:true,ready:true}],
  }};
}
const hash=(text: string | Buffer)=>createHash('sha256').update(text).digest('hex');

describe('one historical production duplicate attestation',()=>{
  it('leaves ordinary parity strict and preserves input rows when acknowledging the exact pair',()=>{
    const rows=pair(); const original=structuredClone(rows);
    expect(hasFatalMigrationDrift(diffMigrations(local,rows))).toBe(true);
    const result=diffMigrationsWithAttestation(local,rows,evidence());
    expect(hasFatalMigrationDrift(result)).toBe(false);
    expect(result.attestations).toHaveLength(1);
    expect(result.attestations[0].versions).toEqual(['20260915120000','20260916063005']);
    expect(rows).toEqual(original);
  });
  it('pins the committed source and independently captured constraint hashes',()=>{
    expect(hash(readFileSync(new URL(`../../supabase/migrations/${REMINDER_ATTESTATION.file}`,import.meta.url)))).toBe(REMINDER_ATTESTATION.sourceSha256);
    const captures=JSON.parse(readFileSync(new URL('../../docs/plans/production-test-accounts/release-reminder-constraint-evidence.json',import.meta.url),'utf8'));
    for(const target of ['production','staging']) for(const [name,digest] of Object.entries(REVIEWED_REMINDER_CONSTRAINTS)) {
      expect(captures[target][name].sha256).toBe(digest);
      expect(hash(captures[target][name].definition)).toBe(digest);
    }
  });
  it.each(['', 'staging', 'dev'])('rejects target %s',target=>{
    expect(hasFatalMigrationDrift(diffMigrationsWithAttestation(local,pair(),{...evidence(),target}))).toBe(true);
  });
  it('rejects a wrong project or source digest',()=>{
    expect(hasFatalMigrationDrift(diffMigrationsWithAttestation(local,pair(),{...evidence(),project:'xwszcafaontidfgznlxd'}))).toBe(true);
    expect(hasFatalMigrationDrift(diffMigrationsWithAttestation(local,pair(),{...evidence(),sourceSha256:'a'.repeat(64)}))).toBe(true);
  });
  it.each(['changed hash','null statements','extra duplicate','changed version','missing expected version'])('rejects %s',variant=>{
    const rows=pair();
    if(variant==='changed hash') rows[0].statementsSha256='a'.repeat(64);
    if(variant==='null statements') rows[0].statementsSha256=null as never;
    if(variant==='extra duplicate') rows.push({...rows[0],version:'20260917000000'});
    if(variant==='changed version') rows[0].version='20260917000000';
    if(variant==='missing expected version') rows.pop();
    const result=diffMigrationsWithAttestation(local,rows,evidence());
    expect(result.attestations).toEqual([]);
    expect(hasFatalMigrationDrift(result)).toBe(true);
  });
  it.each(['constraint','missing constraint','constraint table','invalid constraint','column type','column nullability','column default','index','invalid index'])('rejects wrong %s evidence',variant=>{
    const input=evidence();
    if(variant==='constraint') input.schema.constraints[0].sha256='a'.repeat(64);
    if(variant==='missing constraint') input.schema.constraints.pop();
    if(variant==='constraint table') input.schema.constraints[0].table='unrelated';
    if(variant==='invalid constraint') input.schema.constraints[0].validated=false;
    if(variant==='column type') input.schema.columns[0].type='timestamp without time zone';
    if(variant==='column nullability') input.schema.columns[0].notNull=true;
    if(variant==='column default') input.schema.columns[0].default='now()' as never;
    if(variant==='index') input.schema.indexes[0].definition+=' WHERE false';
    if(variant==='invalid index') input.schema.indexes[0].valid=false;
    expect(hasFatalMigrationDrift(diffMigrationsWithAttestation(local,pair(),input))).toBe(true);
  });
  it('keeps invalid local identities, duplicate versions and unrelated missing migrations fatal',()=>{
    const invalid=[...local,{name:' ',version:'20200101000000'}];
    expect(hasFatalMigrationDrift(diffMigrationsWithAttestation(invalid,pair(),evidence()))).toBe(true);
    const duplicateVersion=[...pair(),{name:'unrelated',version:'20260915120000',statementsSha256:'a'.repeat(64)}];
    expect(hasFatalMigrationDrift(diffMigrationsWithAttestation(local,duplicateVersion,evidence()))).toBe(true);
    const missing=[...local,{name:'new_missing_feature',version:'20260919000000'}];
    const result=diffMigrationsWithAttestation(missing,pair(),evidence());
    expect(result.attestations).toHaveLength(1);
    expect(result.missing).toEqual([missing[1]]);
    expect(hasFatalMigrationDrift(result)).toBe(true);
  });
});

describe('bounded private evidence reads',()=>{
  it('reads a consistent read-only snapshot and exposes hashes without statement bodies',async()=>{
    const query=vi.fn(async(sql: string)=>{
      if(sql.includes('information_schema.tables')) return {rowCount:1,rows:[{}]};
      if(sql.includes('as "statementsSha256"')) return {rows:pair()};
      if(sql.includes('as evidence')) return {rows:[{evidence:evidence().schema}]};
      return {rows:[]};
    });
    const result=await readParitySnapshot({query},'production');
    expect(query.mock.calls[0][0]).toBe('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(result).toEqual({applied:pair(),schema:evidence().schema});
    expect(query.mock.calls.some(([sql])=>sql.includes("SET LOCAL statement_timeout = '15s'"))).toBe(true);
    expect(COMPACT_STATEMENTS_SHA_SQL).toContain("coalesce(to_json(item)::text,'null')");
    expect(COMPACT_STATEMENTS_SHA_SQL).not.toContain('replace(');
  });
  it('rolls back when an evidence query fails',async()=>{
    const query=vi.fn(async(sql: string)=>{
      if(sql.includes('information_schema.tables')) throw new Error('private driver detail');
      return {rows:[]};
    });
    await expect(readParitySnapshot({query},'production')).rejects.toThrow();
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
  it('does not collect attestation schema or statement digests for an absent target',async()=>{
    const query=vi.fn(async(sql: string)=>sql.includes('information_schema.tables')?{rowCount:1,rows:[{}]}:{rows:[]});
    await readParitySnapshot({query},'');
    expect(query.mock.calls.some(([sql])=>sql.includes('as "statementsSha256"')||sql.includes('as evidence'))).toBe(false);
  });
});
