/** Bounded, literal historical source-effect attestations. Never repairs the ledger. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CATALOG_QUERIES, RESIDUAL_SQL } from './migration-parity/historical-catalog-queries.mjs';

export const HISTORICAL_PROOF_SHA256 = '9f996427cf04528e57026e9a6f060da610d0b3f54a7d06428a3db60af9473fd8';
const bytes = readFileSync(new URL('./migration-parity/historical-proof-20261107.json', import.meta.url));
const sha = (value) => createHash('sha256').update(value).digest('hex');
if (sha(bytes) !== HISTORICAL_PROOF_SHA256) throw Error('Historical proof integrity failed');
const proof = JSON.parse(bytes);
export function historicalProof(target) {
  // Return a copy so a caller cannot change the immutable acceptance register.
  return structuredClone(proof.targets.find((entry) => entry.target === target));
}
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const equal = (a, b) => stableJson(a) === stableJson(b);
export function historicalSourceHashes(directory) {
  const files = new Set(proof.targets.flatMap((entry) => Object.keys(entry.sourceSha256)));
  return Object.fromEntries([...files].map((file) => {
    try { return [file, sha(readFileSync(join(directory, file)))]; }
    catch { return [file, null]; }
  }));
}

/** Caller owns the target-verified REPEATABLE READ READ ONLY transaction. */
export async function readHistoricalSourceSnapshot(client, target) {
  const expected = historicalProof(target);
  if (!expected) return undefined;
  const functionNames = Object.keys(expected.functionIdentitySets);
  for (const absent of Object.values(expected.requiredAbsences)) {
    if (absent.kind === 'function-signature' && !functionNames.includes(absent.name)) functionNames.push(absent.name);
  }
  const relationNames = new Set(Object.keys(expected.scopes).map((name) => name.split('.')[1]));
  for (const { contract } of Object.values(expected.objects)) {
    if (contract.schema && contract.name && !('identity_arguments' in contract)) relationNames.add(contract.name);
    if (contract.relation) relationNames.add(contract.relation.split('.')[1]);
  }
  for (const absent of Object.values(expected.requiredAbsences)) {
    if (absent.relation) relationNames.add(absent.relation.split('.')[1]);
    if (absent.kind === 'index') relationNames.add(absent.name);
  }
  const functions = (await client.query(CATALOG_QUERIES.functions, [functionNames])).rows;
  const relations = (await client.query(CATALOG_QUERIES.rels, [[...relationNames]])).rows;
  const ids = relations.map((row) => row.oid);
  const snapshot = { functions, relations };
  for (const kind of ['columns', 'constraints', 'indexes', 'policies', 'triggers', 'sequences']) {
    snapshot[kind] = (await client.query(CATALOG_QUERIES[kind], [ids])).rows;
  }
  snapshot.residuals = (await client.query(RESIDUAL_SQL)).rows[0]?.evidence;
  // Absence of an obsolete signature is checked by PostgreSQL's exact type resolver.
  snapshot.absentFunctions = {};
  for (const [id, absent] of Object.entries(expected.requiredAbsences)) {
    if (absent.kind !== 'function-signature') continue;
    const signature = `${absent.name}(${absent.argumentTypes.join(',')})`;
    snapshot.absentFunctions[id] = (await client.query('select to_regprocedure($1)::text as identity', [signature])).rows[0]?.identity === null;
  }
  return snapshot;
}

function projectContract(actual, expected) {
  // Field projection only. Never normalize SQL text, ACLs, arrays, or definitions.
  if (!actual) return undefined;
  return Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key]]));
}
function currentObjects(snapshot) {
  const objects = new Map();
  const insert = (key, value) => objects.set(key, [...(objects.get(key) ?? []), value]);
  const relations = new Map(snapshot.relations.map((row) => [String(row.oid), `${row.schema}.${row.name}`]));
  for (const row of snapshot.functions) insert(`function:${row.schema}.${row.name}(${row.identity_arguments})`, row);
  for (const row of snapshot.relations) {
    insert(`relation:${row.schema}.${row.name}`, row);
    insert(`relation-acl:${row.schema}.${row.name}`, row);
  }
  const kinds = {columns:'column', constraints:'constraint', indexes:'index', policies:'policy', triggers:'trigger'};
  for (const [kind, prefix] of Object.entries(kinds)) {
    for (const row of snapshot[kind]) {
      const value = {...row, relation:relations.get(String(row.relation_oid))};
      insert(`${prefix}:${value.relation}.${row.name}`, value);
      if (kind === 'columns') {
        insert(`column-nullability:${value.relation}.${row.name}`, value);
        insert(`column-acl:${value.relation}.${row.name}`, value);
      }
    }
  }
  for (const row of snapshot.sequences) {
    const relation = snapshot.relations.find((r) => String(r.oid) === String(row.relation_oid));
    if (relation) insert(`sequence:${relation.schema}.${relation.name}`, {...row, ...projectContract(relation, {schema:0, name:0, owner:0, acl:0})});
  }
  for (const row of snapshot.residuals?.bucket_configuration ?? []) insert(`bucket:${row.id}`, row);
  for (const [key, count] of Object.entries(snapshot.residuals ?? {})) {
    if (key !== 'bucket_configuration') insert(`residual:${key}`, {name:key, requiredCount:count});
  }
  return { objects, relations };
}

/** Each source succeeds only when every reached literal proof succeeds. */
export function attestHistoricalSources({target, project, local, applied, sourceHashes, historical, problems = /** @type {{source:string,kind:string}[]} */ ([])}) {
  const expected = historicalProof(target);
  const rejected = {accepted:[], warnings:[]};
  if (!expected || expected.project !== project || !historical || !sourceHashes ||
      problems.some((p) => p.source === 'repo' || p.kind === 'duplicate-version')) return rejected;
  if (Object.entries(expected.sourceSha256).some(([file, hash]) => sourceHashes[file] !== hash)) return rejected;
  if (expected.coverage.length !== 877 || new Set(expected.coverage.map((row) => row.file)).size !== 86) return rejected;
  // A complete snapshot is required, even for empty child sets.
  if (['functions','relations','columns','constraints','indexes','policies','triggers','sequences'].some((key) => !Array.isArray(historical[key]))) return rejected;
  const {objects, relations} = currentObjects(historical);
  const passed = new Map();
  for (const [id, {contract, sha256}] of Object.entries(expected.objects)) {
    if (sha(stableJson(contract)) !== sha256) return rejected;
    if (id.startsWith('execution:') || id.startsWith('successor:')) {
      const name = contract.remoteName ?? contract.name;
      const version = contract.remoteVersion ?? contract.version;
      const rows = applied.filter((row) => row.name === name);
      passed.set(id, rows.length === 1 && rows[0].version === version && rows[0].statementsSha256 === contract.statementsSha256 && rows[0].statementCount === contract.statementCount);
    } else {
      const rows = objects.get(id) ?? [];
      passed.set(id, rows.length === 1 && equal(projectContract(rows[0], contract), contract));
    }
  }
  for (const [id, absent] of Object.entries(expected.requiredAbsences)) {
    if (absent.kind === 'function-signature') passed.set(id, historical.absentFunctions?.[id] === true);
    else if (absent.kind === 'index') passed.set(id, !historical.relations.some((row) => row.schema === absent.schema && row.name === absent.name));
    else passed.set(id, !(objects.get(`${absent.kind}:${absent.relation}.${absent.name}`)?.length));
  }
  for (const [name, ids] of Object.entries(expected.scopes)) passed.set(`scope:${name}`, ids.length > 0 && ids.every((id) => passed.get(id) === true));
  const setResults = {};
  for (const [relation, sets] of Object.entries(expected.newTableObjectSets)) {
    setResults[relation] = Object.entries(sets).every(([kind, set]) => equal(
      historical[kind].filter((row) => relations.get(String(row.relation_oid)) === relation).map((row) => row.name).sort(),
      [...set.required, ...set.additionalContextOnly].sort()));
  }
  const functionSetResults = Object.fromEntries(Object.entries(expected.functionIdentitySets).map(([name, identities]) => [name, equal(
    historical.functions.filter((row) => `${row.schema}.${row.name}` === name).map((row) => row.identity_arguments).sort(), [...identities].sort())]));
  const files = [...new Set(expected.coverage.map((row) => row.file))];
  const accepted = [];
  const warnings = [];
  for (const file of files) {
    const version = file.slice(0, 14), name = file.slice(15, -4);
    if (local.filter((row) => row.version === version && row.name === name).length !== 1) continue;
    const coverage = expected.coverage.filter((row) => row.file === file);
    const reached = new Set(coverage.flatMap((row) => row.proofIds.flatMap((id) => id.startsWith('scope:') ? expected.scopes[id.slice(6)] : [id])));
    if (coverage.some((row) => !row.proofIds.length || row.proofIds.some((id) => passed.get(id) !== true))) continue;
    if ([...reached].some((id) => {
      const contract = expected.objects[id]?.contract;
      if (id.startsWith('function:') && functionSetResults[`${contract.schema}.${contract.name}`] !== true) return true;
      return contract?.relation && setResults[contract.relation] === false || id.startsWith('relation:') && setResults[id.slice(9)] === false;
    })) continue;
    accepted.push({version, name});
    warnings.push({name, versions:[version], message:`Historical source attested by ${[...new Set(coverage.map((row) => row.mode))].join(', ')}; ${coverage.length} statements verified.`, proofIds:[...reached]});
  }
  return {accepted, warnings};
}
