/** Fixed resident read-scope release. Offline preparation; root-only sealed transport. */
import { readFileSync, lstatSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIVATE_ROOT, PINNED_CLI, readPinned, sha256, ledgerGuardSql, doBlock, cliTransactionGuardSql, serializeHistoricalStatements, assertPinnedCli, assertExactDryRun, throwPrivateCliFailure } from './release-conversation-schema-reconciliation.mjs';

export const RESIDENT_TARGETS = Object.freeze({ dev: 'emstjswhotsnyksqhqyf', staging: 'xwszcafaontidfgznlxd', production: 'qahnczmilgptcedaqype' });
export const RESIDENT_IDENTITY = '20260919161700_mark_portal_inbox_source_read_resident_scope';
export const RESIDENT_SOURCE_SHA256 = 'a408f5bd035530daf70480f1f8c6a9f0d9b68335d5d90d73c4ac154cc20a25fc';
const ORIGINAL_SHA256 = '8a6007c229d637f3eb4d6091650ddb8c546a7f5dee353abcb157e4bd99f5bad6';
const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SELF = fileURLToPath(import.meta.url);
const HELPER = fileURLToPath(new URL('./release-conversation-schema-reconciliation.mjs', import.meta.url));
const SIGNATURE = 'public.mark_portal_inbox_source_read(text,text,uuid,text,text,timestamp with time zone,jsonb)';
const OLD_SCOPE = "scope = 'axis_portal_inbox_manager_v1'";
const NEW_SCOPE = "scope in ('axis_portal_inbox_manager_v1', 'axis_portal_inbox_resident_v1')";
const fail = reason => new Error(`Resident read release refused: ${reason}`);
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const canonical = value => JSON.stringify(stable(value));
const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
const json = value => `${literal(JSON.stringify(value))}::jsonb`;
const project = target => { if (!Object.hasOwn(RESIDENT_TARGETS, target)) throw fail('exact target required'); return RESIDENT_TARGETS[target]; };
const source = () => readPinned(join(REPO, 'supabase/migrations', `${RESIDENT_IDENTITY}.sql`), RESIDENT_SOURCE_SHA256, false).toString('utf8');
const original = () => readPinned(join(REPO, 'supabase/migrations/20260913170000_mark_portal_inbox_source_read.sql'), ORIGINAL_SHA256, false).toString('utf8');
const body = sql => { const match = sql.match(/\bas \$\$([\s\S]*?)\$\$;/); if (!match) throw fail('pinned SQL body'); return match[1]; };

export function expectedResidentFunction(fn) {
  if (!fn || fn.securityDefiner !== false || typeof fn.definition !== 'string' || typeof fn.owner !== 'string' || !Array.isArray(fn.acl) || !Array.isArray(fn.config)) throw fail('function metadata');
  const match = fn.definition.match(/\bAS (\$[A-Za-z_0-9]*\$)([\s\S]*?)\1/);
  if (!match || match[2] !== body(original()) || source() !== original().replace(OLD_SCOPE, NEW_SCOPE)) throw fail('original function or reviewed source differs');
  return { ...fn, definition: fn.definition.replace(match[0], `AS ${match[1]}${body(source())}${match[1]}`) };
}

export function residentFunctionGuardSql(fn) {
  if (!fn || fn.securityDefiner !== false || typeof fn.definition !== 'string' || typeof fn.owner !== 'string' || !Array.isArray(fn.acl) || !Array.isArray(fn.config)) throw fail('function metadata');
  return doBlock(`begin
 if not exists(select 1 from pg_proc f where f.oid=${literal(SIGNATURE)}::regprocedure
 and pg_get_functiondef(f.oid)=${literal(fn.definition)} and pg_get_userbyid(f.proowner)=${literal(fn.owner)}
 and not f.prosecdef and f.prolang=(select oid from pg_language where lanname='sql') and f.provolatile='v'
 and to_jsonb(f.proconfig) is not distinct from ${json(fn.config)} and to_jsonb(f.proacl) is not distinct from ${json(fn.acl)}
 and f.proconfig=array['search_path=""']::text[]
 and has_function_privilege('service_role',f.oid,'EXECUTE')
 and not has_function_privilege('anon',f.oid,'EXECUTE') and not has_function_privilege('authenticated',f.oid,'EXECUTE')
 and not exists(select 1 from aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a where a.grantee=0 or a.grantee not in (f.proowner,(select oid from pg_roles where rolname='service_role'))))
 then raise exception 'resident read function contract differs'; end if;
 end`, 'resident_function_guard');
}

const transactionGuard = cliTransactionGuardSql({
  lockTimeout: '5s',
  statementTimeout: '30s',
  locks: [
    { relations: ['supabase_migrations.schema_migrations'], mode: 'exclusive' },
    { relations: ['public.portal_inbox_thread_records'], mode: 'share row exclusive' },
  ],
  tag: 'resident_read_transaction',
});
export function guardedResidentMigrationSql(evidence, migrationSql = source()) {
  if (sha256(migrationSql) !== RESIDENT_SOURCE_SHA256) throw fail('migration source digest');
  if (evidence.ledger.some(row => row.version === RESIDENT_IDENTITY.slice(0, 14))) throw fail('feature migration already present');
  const expected = expectedResidentFunction(evidence.inbox_function);
  // The pinned CLI batches headerless SQL and its history INSERT atomically.
  // Authored BEGIN/COMMIT would instead release locks before that INSERT.
  if (!migrationSql.startsWith('begin;\n') || !migrationSql.endsWith('commit;\n')) throw fail('source transaction boundaries');
  const inner = migrationSql.slice('begin;\n'.length, -'commit;\n'.length);
  return `${transactionGuard}\n${ledgerGuardSql(evidence.ledger)}\n${residentFunctionGuardSql(evidence.inbox_function)}\n${inner}\n${residentFunctionGuardSql(expected)}\n`;
}

export function residentRecoverySql(fn) {
  return `-- Function-only recovery. Apply only as a NEW reviewed migration after adding the actual post-apply full ledger guard. Never erase history.\n${transactionGuard}\n${residentFunctionGuardSql(expectedResidentFunction(fn))}\n${fn.definition};\n${residentFunctionGuardSql(fn)}\n`;
}

function privateDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) throw fail('private directory');
}
function privatePath(path) {
  if (typeof path !== 'string' || path !== resolve(path) || !path.startsWith(`${PRIVATE_ROOT}/`)) throw fail('private artifact path');
  privateDirectory(PRIVATE_ROOT);
  let parent = dirname(path);
  while (parent !== PRIVATE_ROOT) { privateDirectory(parent); parent = dirname(parent); }
  return path;
}
function readArtifact(ref) { return readPinned(privatePath(ref?.path), ref?.sha256); }
function capture(target, ref) {
  const data = JSON.parse(readArtifact(ref));
  if (data.target !== project(target) || !Number.isFinite(Date.parse(data.capturedAt))) throw fail('capture target/time');
  ledgerGuardSql(data.ledger); expectedResidentFunction(data.inbox_function);
  return data;
}
const semantic = ({ capturedAt: ignored, ...rest }) => canonical(rest);
const writePrivate = (path, bytes) => writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
function generatedFiles(evidence) {
  const files = { 'supabase/config.toml': 'project_id = "resident-read-feature"\n[db.migrations]\nenabled = true\n[db.seed]\nenabled = false\n' };
  for (const row of evidence.ledger) files[`supabase/migrations/${row.version}_recorded_${row.version}.sql`] = serializeHistoricalStatements(row.statements);
  files[`supabase/migrations/${RESIDENT_IDENTITY}.sql`] = guardedResidentMigrationSql(evidence);
  files['recovery.sql'] = residentRecoverySql(evidence.inbox_function);
  return files;
}
export function prepareResidentRead({ target, evidence: evidenceRef, backup }) {
  const evidence = capture(target, evidenceRef), saved = capture(target, backup);
  if (semantic(evidence) !== semantic(saved)) throw fail('backup differs from evidence');
  assertPinnedCli();
  const files = generatedFiles(evidence);
  const directory = join(PRIVATE_ROOT, `resident-read-${target}-${sha256(canonical({ evidenceRef, backup, files })).slice(0, 16)}`);
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(join(directory, 'supabase'), { mode: 0o700 });
  mkdirSync(join(directory, 'supabase/migrations'), { mode: 0o700 });
  for (const [path, bytes] of Object.entries(files)) writePrivate(join(directory, path), bytes);
  const manifest = { format: 1, target, projectRef: project(target), identity: RESIDENT_IDENTITY, evidence: evidenceRef, backup, runnerSha256: sha256(readFileSync(SELF)), helperSha256: sha256(readFileSync(HELPER)), sourceSha256: RESIDENT_SOURCE_SHA256, files: Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, sha256(bytes)])) };
  const bytes = JSON.stringify(manifest, null, 2) + '\n', manifestPath = join(directory, 'manifest.json');
  writePrivate(manifestPath, bytes);
  return { manifestPath, manifestSha256: sha256(bytes), identity: RESIDENT_IDENTITY, applyReady: false };
}

function verifiedManifest(request) {
  const path = privatePath(request?.manifestPath);
  if (!path.startsWith(`${PRIVATE_ROOT}/resident-read-`) || !path.endsWith('/manifest.json')) throw fail('manifest path');
  const manifest = JSON.parse(readPinned(path, request.manifestSha256)), directory = dirname(path);
  if (manifest.format !== 1 || manifest.projectRef !== project(manifest.target) || manifest.identity !== RESIDENT_IDENTITY || manifest.sourceSha256 !== RESIDENT_SOURCE_SHA256 || manifest.runnerSha256 !== sha256(readFileSync(SELF)) || manifest.helperSha256 !== sha256(readFileSync(HELPER))) throw fail('manifest source/target');
  const evidence = capture(manifest.target, manifest.evidence), backup = capture(manifest.target, manifest.backup);
  if (semantic(evidence) !== semantic(backup)) throw fail('backup differs');
  const files = generatedFiles(evidence);
  if (canonical(Object.keys(files).sort()) !== canonical(Object.keys(manifest.files).sort())) throw fail('manifest inventory');
  for (const [relative, bytes] of Object.entries(files)) {
    if (manifest.files[relative] !== sha256(bytes)) throw fail('generated artifact digest');
    readPinned(privatePath(join(directory, relative)), sha256(bytes));
  }
  const exact = (relative, names) => { const dir = join(directory, relative); privateDirectory(dir); if (canonical(readdirSync(dir).sort()) !== canonical(names.sort())) throw fail('extra workspace file'); };
  exact('', ['manifest.json', 'recovery.sql', 'supabase']);
  exact('supabase/migrations', Object.keys(files).filter(name => name.startsWith('supabase/migrations/')).map(name => name.slice('supabase/migrations/'.length)));
  const entries = readdirSync(join(directory, 'supabase'));
  if (entries.some(name => !['config.toml', 'migrations', '.temp'].includes(name))) throw fail('extra Supabase file');
  // The CLI may create private link metadata, but no caller-controlled symlinks.
  if (entries.includes('.temp')) {
    const temp = join(directory, 'supabase/.temp'), stat = lstatSync(temp);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('CLI metadata directory');
    for (const name of readdirSync(temp)) { const entry = lstatSync(join(temp, name)); if (!entry.isFile() || entry.isSymbolicLink()) throw fail('CLI metadata entry'); }
  }
  assertPinnedCli();
  return { manifest, evidence, directory };
}
function fresh(stamp, now, window) { const age = now - Date.parse(stamp); if (!Number.isFinite(age) || age < 0 || age > window) throw fail('expired evidence/review'); }
function verifiedApproval(request, state) {
  const approval = JSON.parse(readArtifact({ path: request.approvalPath, sha256: request.approvalSha256 }));
  const now = Date.now(); fresh(state.evidence.capturedAt, now, 600_000); fresh(approval.reviewedAt, now, 3_600_000);
  if (approval.approved !== true || approval.authorizationSource !== 'existing-session-release-authorization' || approval.projectRef !== state.manifest.projectRef || approval.manifestSha256 !== request.manifestSha256 || approval.runnerSha256 !== state.manifest.runnerSha256 || approval.sourceToBinaryVerified !== true || approval.recoveryRehearsalPassed !== true || !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= now || Date.parse(approval.expiresAt) - Date.parse(approval.reviewedAt) > 3_600_000) throw fail('review/recovery receipt');
  readPinned(approval.reviewReportPath, approval.reviewReportSha256, false);
  const recovery = readArtifact({ path: approval.recoveryArtifactPath, sha256: approval.recoveryArtifactSha256 });
  if (sha256(recovery) !== state.manifest.files['recovery.sql']) throw fail('reviewed recovery differs');
}
function invoke(state, dryRun) {
  const env = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'SUPABASE_ACCESS_TOKEN']) if (process.env[key]) env[key] = process.env[key];
  if (!env.HOME || !env.PATH) throw fail('CLI environment');
  env.NO_COLOR = '1'; env.SUPABASE_TELEMETRY_DISABLED = 'true';
  const result = spawnSync(PINNED_CLI, ['db', 'push', '--linked', '--project-ref', state.manifest.projectRef, '--skip-vault', '--include-all', '--yes', ...(dryRun ? ['--dry-run'] : [])], { cwd: state.directory, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.signal || result.status !== 0) throwPrivateCliFailure({ projectRef: state.manifest.projectRef, phase: dryRun ? 'dry-run' : 'apply', identity: state.manifest.identity }, result);
  return String(result.stdout ?? '') + '\n' + String(result.stderr ?? '');
}
const tokens = new WeakMap();
function cliMetadataFingerprint(directory) {
  const supabase = join(directory, 'supabase');
  if (!readdirSync(supabase).includes('.temp')) return null;
  const temp = join(supabase, '.temp'), stat = lstatSync(temp);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('CLI metadata directory');
  return sha256(canonical(readdirSync(temp).sort().map(name => {
    const path = join(temp, name), entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink()) throw fail('CLI metadata entry');
    return [name, sha256(readFileSync(path))];
  })));
}
export function runResidentReadDryRun(request) {
  const state = verifiedManifest(request); verifiedApproval(request, state);
  if (cliMetadataFingerprint(state.directory) !== null) throw fail('unexpected pre-dry-run CLI metadata; prepare a fresh workspace');
  assertExactDryRun(invoke(state, true), [RESIDENT_IDENTITY], 0);
  const token = Object.freeze({ identity: RESIDENT_IDENTITY });
  tokens.set(token, { manifestSha256: request.manifestSha256, approvalSha256: request.approvalSha256, finishedAt: Date.now(), used: false, cliMetadata: cliMetadataFingerprint(state.directory) });
  return token;
}
export function assertResidentReadReady(request, token) {
  const receipt = token && tokens.get(token);
  if (!receipt || receipt.used || receipt.manifestSha256 !== request?.manifestSha256 || receipt.approvalSha256 !== request?.approvalSha256 || Date.now() - receipt.finishedAt > 60_000 || Date.now() < receipt.finishedAt) throw fail('actual one-use dry-run token required');
  const state = verifiedManifest(request); verifiedApproval(request, state);
  if (cliMetadataFingerprint(state.directory) !== receipt.cliMetadata || Date.now() - receipt.finishedAt > 60_000) throw fail('dry-run metadata changed or token expired');
  return state;
}
export function executeResidentRead(request, token) {
  const state = assertResidentReadReady(request, token), receipt = tokens.get(token);
  receipt.used = true;
  invoke(state, false); receipt.appliedAt = Date.now();
  return { applied: true, verificationRequired: true, projectRef: state.manifest.projectRef, identity: RESIDENT_IDENTITY };
}

export function assertResidentPostState(before, after) {
  if (after.target !== before.target || canonical(after.inbox_function) !== canonical(expectedResidentFunction(before.inbox_function))) throw fail('post function/target differs');
  ledgerGuardSql(after.ledger);
  const historic = after.ledger.filter(row => row.version !== RESIDENT_IDENTITY.slice(0, 14));
  if (canonical([...historic].sort((a,b) => a.version.localeCompare(b.version))) !== canonical([...before.ledger].sort((a,b) => a.version.localeCompare(b.version)))) throw fail('historical ledger differs');
  const added = after.ledger.filter(row => row.version === RESIDENT_IDENTITY.slice(0, 14));
  if (added.length !== 1 || added[0].name !== RESIDENT_IDENTITY.slice(15) || !Array.isArray(added[0].statements) || !added[0].statements.length || added[0].statements.some(statement => typeof statement !== 'string' || !statement.trim())) throw fail('truthful new ledger row required');
  return { identity: RESIDENT_IDENTITY, ledgerRowSha256: sha256(canonical(added[0])) };
}
export function verifyResidentRead(request, token, postCapture) {
  const receipt = tokens.get(token);
  if (!receipt?.appliedAt || receipt.manifestSha256 !== request?.manifestSha256) throw fail('successful apply token required');
  const state = verifiedManifest(request), after = JSON.parse(readArtifact(postCapture));
  fresh(after.capturedAt, Date.now(), 600_000);
  if (Date.parse(after.capturedAt) < receipt.appliedAt) throw fail('post-apply capture required');
  return { verified: true, receipt: assertResidentPostState(state.evidence, after), independentReviewRequired: true };
}

// Direct invocation never accepts apply arguments or opens a transport.
if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  if (process.argv.length !== 4 || process.argv[2] !== '--target') throw fail('offline usage: --target dev|staging|production');
  process.stdout.write(JSON.stringify({ projectRef: project(process.argv[3]), identity: RESIDENT_IDENTITY, mode: 'offline', applyReady: false }) + '\n');
}
