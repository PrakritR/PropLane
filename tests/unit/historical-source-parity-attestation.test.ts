import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { historicalProof, historicalSourceHashes, attestHistoricalSources, readHistoricalSourceSnapshot } from '../../scripts/historical-source-parity-attestation.mjs';
import { diffMigrations, diffMigrationsWithAttestation, hasFatalMigrationDrift, readParitySnapshot } from '../../scripts/check-migration-parity.mjs';
import { CATALOG_QUERIES, RESIDUAL_SQL } from '../../scripts/migration-parity/historical-catalog-queries.mjs';
import { REMINDER_SUCCESSOR, REMINDER_ATTESTATION, REVIEWED_REMINDER_CONSTRAINTS, REVIEWED_EXPIRY_INDEX } from '../../scripts/historical-migration-parity-attestation.mjs';

type Row = Record<string, unknown>;
type Kind = 'functions' | 'relations' | 'columns' | 'constraints' | 'indexes' | 'policies' | 'triggers' | 'sequences';
function fixture(target = 'staging') {
  const proof = historicalProof(target);
  const rows: Record<Kind, Row[]> = {functions:[],relations:[],columns:[],constraints:[],indexes:[],policies:[],triggers:[],sequences:[]};
  const relationIds = new Map<string, string>();
  const ensureRelation = (name: string) => {
    if (!relationIds.has(name)) {
      relationIds.set(name, String(relationIds.size + 1));
      const [schema, relation] = name.split('.');
      rows.relations.push({oid:relationIds.get(name), schema, name:relation, kind:'r'});
    }
    return relationIds.get(name);
  };
  const applied: Row[] = [];
  const residuals: Record<string, unknown> = {bucket_configuration:[]};
  const kinds: Record<string, Kind> = {column:'columns', 'column-nullability':'columns', 'column-acl':'columns', constraint:'constraints', index:'indexes', policy:'policies', trigger:'triggers'};
  for (const [id, {contract}] of Object.entries(proof.objects) as [string, {contract:Row}][]) {
    const type = id.split(':')[0];
    if (type === 'execution' || type === 'successor') {
      applied.push({version:contract.remoteVersion ?? contract.version, name:contract.remoteName ?? contract.name, statementsSha256:contract.statementsSha256, statementCount:contract.statementCount});
    } else if (type === 'function') rows.functions.push({...contract});
    else if (type === 'relation' || type === 'relation-acl') {
      const oid = ensureRelation(`${contract.schema}.${contract.name}`);
      Object.assign(rows.relations.find((row) => row.oid === oid)!, contract);
    } else if (kinds[type]) {
      const oid = ensureRelation(String(contract.relation));
      const existing = rows[kinds[type]].find((row) => row.relation_oid === oid && row.name === contract.name);
      if (existing) Object.assign(existing, contract);
      else rows[kinds[type]].push({...contract, relation_oid:oid});
    } else if (type === 'sequence') {
      const oid = ensureRelation(`${contract.schema}.${contract.name}`);
      Object.assign(rows.relations.find((row) => row.oid === oid)!, contract);
      rows.sequences.push({...contract, relation_oid:oid});
    } else if (type === 'bucket') (residuals.bucket_configuration as Row[]).push({...contract});
    else if (type === 'residual') residuals[String(contract.name)] = contract.requiredCount;
  }
  for (const [relation, sets] of Object.entries(proof.newTableObjectSets) as [string, Record<string, {required:string[], additionalContextOnly:string[]}>][]) {
    const oid = ensureRelation(relation);
    for (const [kind, set] of Object.entries(sets)) {
      for (const name of [...set.required, ...set.additionalContextOnly]) {
        if (!rows[kind as Kind].some((row) => row.relation_oid === oid && row.name === name)) rows[kind as Kind].push({name, relation_oid:oid});
      }
    }
  }
  const local = [...new Set(proof.coverage.map((row: {file:string}) => row.file))].map((file) => ({version:String(file).slice(0,14), name:String(file).slice(15,-4)}));
  return {target, project:proof.project, local, applied, sourceHashes:{...proof.sourceSha256}, historical:{...rows, residuals, absentFunctions:Object.fromEntries(Object.keys(proof.requiredAbsences).filter((id) => id.startsWith('absent:function:')).map((id) => [id,true]))}};
}
function accepted(input: ReturnType<typeof fixture>) { return attestHistoricalSources(input).accepted; }

describe('literal historical source coverage', () => {
  it.each(['staging','production'])('proves all 86 sources / 877 statements for %s while ordinary diff remains strict', (target) => {
    const input = fixture(target), original = structuredClone(input);
    expect(accepted(input)).toHaveLength(86);
    expect(diffMigrations(input.local,input.applied).missing).toHaveLength(86);
    const result = diffMigrationsWithAttestation(input.local,input.applied,input);
    expect(result.rawMissing).toHaveLength(86);
    expect(result.missing).toEqual([]);
    expect(hasFatalMigrationDrift(result)).toBe(false);
    expect(input).toEqual(original);
    expect(historicalProof(target).coverage).toHaveLength(877);
  });
  it('pins source bytes for the entire derivation and keeps the frozen evidence unmodifiable by callers', () => {
    const input = fixture();
    expect(historicalSourceHashes('supabase/migrations')).toEqual(input.sourceHashes);
    const copy = historicalProof('staging'); copy.coverage.pop();
    expect(historicalProof('staging').coverage).toHaveLength(877);
    const bytes = readFileSync(new URL('../../scripts/migration-parity/historical-proof-20261107.json',import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('9f996427cf04528e57026e9a6f060da610d0b3f54a7d06428a3db60af9473fd8');
  });
  it.each(['wrong project','wrong target','changed source','missing source','incomplete snapshot','missing snapshot','invalid local','duplicate version'])('fails closed for %s', (variant) => {
    const input = fixture();
    if (variant === 'wrong project') input.project = 'qahnczmilgptcedaqype';
    if (variant === 'wrong target') input.target = 'dev';
    if (variant === 'changed source') input.sourceHashes[Object.keys(input.sourceHashes)[0]] = '0'.repeat(64);
    if (variant === 'missing source') delete input.sourceHashes[Object.keys(input.sourceHashes)[0]];
    if (variant === 'incomplete snapshot') Reflect.deleteProperty(input.historical, 'columns');
    if (variant === 'missing snapshot') input.historical = undefined as never;
    const problems = variant === 'invalid local' ? [{source:'repo',kind:'invalid-name'}] : variant === 'duplicate version' ? [{source:'database',kind:'duplicate-version'}] : [];
    expect(attestHistoricalSources({...input, problems}).accepted).toEqual([]);
  });
  it.each([
    ['body','functions','definitionSha256'], ['ACL','functions','acl'], ['RLS','relations','rls'],
    ['default','columns','default_expr'], ['collation','columns','collation'], ['constraint validity','constraints','validated'],
    ['index validity','indexes','valid'], ['index readiness','indexes','ready'], ['trigger function','triggers','function'],
    ['trigger flags','triggers','type'], ['sequence range','sequences','max'],
  ])('rejects changed %s contracts', (_label,kind,field) => {
    const input = fixture();
    const candidate = input.historical[kind as Kind].find((row:Row) => Object.hasOwn(row,field))!;
    candidate[field] = 'changed literal';
    expect(accepted(input).length).toBeLessThan(86);
  });
  it.each(['missing object','extra policy','extra column','extra overload','reappeared signature','reappeared index','reappeared policy','nonzero residual','bucket MIME','missing absence proof'])('rejects %s', (variant) => {
    const input = fixture();
    if (variant === 'missing object') input.historical.columns.shift();
    if (variant === 'extra policy' || variant === 'extra column') {
      const relation = input.historical.relations.find((row:Row) => row.name === 'admin_team_grants')!;
      input.historical[variant === 'extra policy' ? 'policies':'columns'].push({relation_oid:relation.oid,name:'unexpected'});
    }
    if (variant === 'extra overload') input.historical.functions.push({...input.historical.functions[0], identity_arguments:'unexpected integer'});
    if (variant === 'reappeared signature' || variant === 'missing absence proof') {
      const id = Object.keys(input.historical.absentFunctions)[0];
      if (variant === 'reappeared signature') input.historical.absentFunctions[id] = false;
      else delete input.historical.absentFunctions[id];
    }
    if (variant === 'reappeared index') input.historical.relations.push({oid:'9999',schema:'public',name:'vendor_payouts_work_order_unique',kind:'i'});
    if (variant === 'reappeared policy') {
      const relation = input.historical.relations.find((row:Row) => row.name === 'portal_work_order_records')!;
      input.historical.policies.push({relation_oid:relation.oid,name:'portal_work_order_records_vendor_read'});
    }
    if (variant === 'nonzero residual') input.historical.residuals.refund_identity_candidates = 1;
    if (variant === 'bucket MIME') (input.historical.residuals.bucket_configuration as Row[])[0].allowed_mime_types = ['*'];
    expect(accepted(input).length).toBeLessThan(86);
  });
  it.each(['execution','successor'])('pins exact unique %s remote name, version, count, and array hash without adding catalog conditions', (type) => {
    const proof = historicalProof('staging');
    const id = Object.keys(proof.objects).find((id) => id.startsWith(`${type}:`))!;
    const contract = proof.objects[id].contract;
    const file = proof.coverage.find((row: {proofIds:string[]}) => row.proofIds.includes(id)).file;
    const sourceName = file.slice(15,-4);
    for (const field of ['name','version','statementCount','statementsSha256','duplicate']) {
      const input = fixture();
      const row = input.applied.find((row) => row.name === (contract.remoteName ?? contract.name))!;
      if (field === 'duplicate') input.applied.push({...row,version:'20990101000000'});
      else row[field] = field === 'statementCount' ? 999 : 'changed';
      expect(accepted(input).some((row: {name:string}) => row.name === sourceName)).toBe(false);
    }
    const input = fixture();
    input.historical.functions = [];
    expect(accepted(input).some((row: {name:string}) => row.name === sourceName)).toBe(true);
  });
  it('retains unrelated vendor/tour missing identities despite context-only tour columns', () => {
    const input = fixture();
    input.local.push({version:'20261101000000',name:'tour_email_handoff_slot_key'},{version:'20261102000000',name:'vendor_new_migration'});
    const result = diffMigrationsWithAttestation(input.local,input.applied,input);
    expect(result.missing.map((row: {name:string}) => row.name)).toEqual(['tour_email_handoff_slot_key','vendor_new_migration']);
    expect(hasFatalMigrationDrift(result)).toBe(true);
  });
});

describe('bounded runtime evidence reads', () => {
  it('uses only metadata projections and hashes bodies inside PostgreSQL', async () => {
    const query = vi.fn(async (sql:string) => {
      if (sql.includes('to_regprocedure')) return {rows:[{identity:null}]};
      if (sql === RESIDUAL_SQL) return {rows:[{evidence:{}}]};
      return {rows:[]};
    });
    await readHistoricalSourceSnapshot({query},'staging');
    for (const [sql] of query.mock.calls) expect(sql.trim()).toMatch(/^(select|-- Read-only)/i);
    expect(CATALOG_QUERIES.functions).toContain("sha256(convert_to(pg_get_functiondef(p.oid),'UTF8'))");
    expect(CATALOG_QUERIES.functions).not.toContain(' definition,');
    expect(query.mock.calls.every(([sql]) => !/select[^;]*\bstatements\s+from/i.test(sql))).toBe(true);
    const count = query.mock.calls.length;
    expect(await readHistoricalSourceSnapshot({query},'dev')).toBeUndefined();
    expect(query.mock.calls).toHaveLength(count);
  });
  it('rolls back on a catalog failure with no stored function execution', async () => {
    const query = vi.fn(async (sql:string) => {
      if (sql.includes('information_schema.tables')) return {rowCount:1,rows:[{}]};
      if (sql === CATALOG_QUERIES.functions) throw Error('private detail');
      return {rows:[]};
    });
    await expect(readParitySnapshot({query},'staging')).rejects.toThrow();
    expect(query.mock.calls[0][0]).toContain('REPEATABLE READ READ ONLY');
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
});

describe('production reminder constraint successor', () => {
  function input() {
    const applied: {version:string,name:string,statementsSha256:string,statementCount:number}[] = Object.entries(REMINDER_ATTESTATION.statements).map(([version,statementsSha256]) => ({version,name:REMINDER_ATTESTATION.name,statementsSha256,statementCount:1}));
    applied.push({...REMINDER_SUCCESSOR});
    const evidence = {target:'production',project:REMINDER_ATTESTATION.project,sourceSha256:REMINDER_ATTESTATION.sourceSha256,reminderSuccessorSourceSha256:String(REMINDER_SUCCESSOR.sourceSha256),schema:{
      constraints:Object.entries(REVIEWED_REMINDER_CONSTRAINTS).map(([name,sha256]) => ({name,sha256:String(name==='portal_reminder_records_kind_check'?REMINDER_SUCCESSOR.constraintSha256:sha256),table:name.startsWith('portal_')?'portal_reminder_records':'work_order_vendor_offers',validated:true})),
      columns:[{type:'timestamp with time zone',notNull:false,default:null}], indexes:[{definition:REVIEWED_EXPIRY_INDEX,valid:true,ready:true}],
    }};
    return {applied,evidence,local:[{version:'20260915120000',name:REMINDER_ATTESTATION.name}]};
  }
  it('requires the reviewed source, execution, and literal current digest together', () => {
    const {local,applied,evidence} = input();
    expect(hasFatalMigrationDrift(diffMigrationsWithAttestation(local,applied,evidence))).toBe(false);
    expect(createHash('sha256').update(readFileSync(`supabase/migrations/${REMINDER_SUCCESSOR.file}`)).digest('hex')).toBe(REMINDER_SUCCESSOR.sourceSha256);
  });
  it.each(['source','array','version','count','missing','current constraint','old constraint'])('rejects changed %s', (variant) => {
    const {local,applied,evidence} = input();
    if (variant === 'source') evidence.reminderSuccessorSourceSha256 = 'changed';
    if (variant === 'array') applied[2].statementsSha256 = 'changed';
    if (variant === 'version') applied[2].version = 'changed';
    if (variant === 'count') applied[2].statementCount = 2;
    if (variant === 'missing') applied.pop();
    if (variant.includes('constraint')) evidence.schema.constraints[0].sha256 = variant === 'old constraint' ? REVIEWED_REMINDER_CONSTRAINTS.portal_reminder_records_kind_check : 'changed';
    expect(hasFatalMigrationDrift(diffMigrationsWithAttestation(local,applied,evidence))).toBe(true);
  });
});
