#!/usr/bin/env node
/** Fixed-purpose transport. Default is offline; artifact preparation is separate. */
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { TARGETS, sha256, buildAtomicBundle, ledgerRowDigest } from './prepare-test-workspace-release-migrations.mjs';
import { buildBaselineBundle, baselineMigrations, BASELINE_CATALOG_SQL, INVITATION_DIGEST_SQL } from './prepare-test-workspace-baseline-prerequisites.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const STATE='/Users/akhilvemuri/.local/state';
export const CLI='/Users/akhilvemuri/.npm/_npx/7f5b665083e1c57c/node_modules/supabase/bin/supabase';
export const CA_FILE=`${STATE}/proplane-release-backups/supabase-prod-ca-2021.crt`;
export const CA_SHA256='700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7';
const HASH=/^[a-f0-9]{64}$/;
const ENV_KEYS=['PATH','HOME','USER','LOGNAME','TMPDIR','LANG','LC_ALL','SUPABASE_ACCESS_TOKEN'];
const REHEARSAL_FILES={scriptSha256:'scripts/testing/test-workspace-release-local-rehearsal.mjs',stagingLogSha256:'docs/plans/production-test-accounts/logs/release-combined-staging-rehearsal-rerun1.log',productionLogSha256:'docs/plans/production-test-accounts/logs/release-combined-production-rehearsal.log'};
const GENERATORS={baseline:'scripts/prepare-test-workspace-baseline-prerequisites.mjs',feature:'scripts/prepare-test-workspace-release-migrations.mjs'};
const fail=(stage)=>{const e=new Error(`Test-workspace transport failed: ${stage}. Details suppressed.`); e.code=`RELEASE_${stage.toUpperCase().replaceAll(/[^A-Z0-9]+/g,'_')}`;return e;};
const digestRows=(rows)=>rows.map((r)=>({version:r.version,name:r.name,sha256:ledgerRowDigest(r)})).sort((a,b)=>a.version<b.version?-1:a.version>b.version?1:0);
const stable=(v)=>JSON.stringify(v,(_,value)=>value && !Array.isArray(value) && typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);

export function parseTransportArgs(args) {
  if(!args.length)return {operation:'manifest'};
  const m=/^--(preflight|verify|apply)-(baseline|feature)-(staging|production)$/.exec(args[0]);
  if(!m)throw fail('arguments');
  const [,operation,phase,target]=m;
  if(operation!=='apply') {if(args.length!==1)throw fail('arguments');return {operation,phase,target};}
  if(args.length!==7 || args[1]!=='--artifact-sha256' || args[3]!=='--bundle-sha256' || args[5]!=='--backup-sha256'
    || [args[2],args[4],args[6]].some((x)=>!HASH.test(x)))throw fail('apply acknowledgements');
  return {operation,phase,target,artifactSha256:args[2],bundleSha256:args[4],backupSha256:args[6]};
}
export function pathsFor(target,phase) {
  if(!Object.hasOwn(TARGETS,target)||!Object.hasOwn(GENERATORS,phase))throw fail('target phase');
  const backup=`${STATE}/proplane-release-backups/20260919-${target}-test-workspace`;
  return {backup,cliRoot:`${STATE}/proplane-release-cli-${target}-20260919`,
    artifact:join(backup,`apply-artifact-${phase}.json`),manifest:join(backup,phase==='baseline'?'backup-manifest-final.json':'backup-manifest-feature-final.json')};
}
function privateBytes(file) {
  const stat=lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||realpathSync(file)!==resolve(file)||(stat.mode&0o077)!==0
    || (process.getuid && stat.uid!==process.getuid()))throw fail('private artifact file');
  return readFileSync(file);
}
export function validateArtifact({operation,artifactBytes,manifestBytes,snapshotBytes,files,sourceHashes}) {
  const {target,phase}=operation;
  const artifact=JSON.parse(artifactBytes.toString('utf8')); const manifest=JSON.parse(manifestBytes.toString('utf8'));
  const bound=(v)=>v.target===target&&v.project===TARGETS[target];
  if(artifact.schemaVersion!==1||!bound(artifact)||artifact.phase!==phase||!bound(manifest)||manifest.status!=='verified'
    ||manifest.combinedPrerequisiteAndFeatureRestoreRehearsal!=='passed'||stable(manifest.rehearsal?.exitCodes)!=='[0,0]'
    ||manifest.rehearsal?.cleanupVerified!==true||manifest.sourceLedgerAndTablesMatchOriginalBackup!==true)throw fail('final backup manifest');
  // No cycle: only the separate apply artifact contains the generated bundle hash.
  if(Object.hasOwn(manifest,'bundleSha256')||Object.hasOwn(manifest,'artifactSha256')||!HASH.test(artifact.bundleSha256??'')
    ||artifact.backupManifestSha256!==sha256(manifestBytes)||artifact.snapshotSha256!==sha256(snapshotBytes))throw fail('artifact binding');
  if(operation.operation==='apply'&&(operation.artifactSha256!==sha256(artifactBytes)||operation.bundleSha256!==artifact.bundleSha256
    ||operation.backupSha256!==artifact.backupManifestSha256))throw fail('artifact acknowledgements');
  if(!Array.isArray(manifest.files)||new Set(manifest.files.map((f)=>f.name)).size!==manifest.files.length)throw fail('backup inventory');
  const required=phase==='baseline'
    ? ['schema-with-acl.sql','migration-ledger.sql','full-catalog-baseline-beforeimage.json']
    : ['schema-before-feature-with-acl.sql','migration-ledger-before-feature.sql','full-catalog-feature-beforeimage.json'];
  if(phase==='baseline')required.push('account-link-invites-beforeimage.json');
  if(required.some((name)=>!manifest.files.some((f)=>f.name===name)))throw fail('required backup missing');
  for(const f of manifest.files)if(!/^[a-z0-9][a-z0-9.-]*$/.test(f.name)||!HASH.test(f.sha256??'')||!files[f.name]||sha256(files[f.name])!==f.sha256||files[f.name].length!==f.size)throw fail('backup digest');
  if(artifact.snapshotFile!==required[2]||!files[artifact.snapshotFile]||sha256(files[artifact.snapshotFile])!==artifact.snapshotSha256)throw fail('snapshot binding');
  if(manifest.generators?.baselineSha256!==sourceHashes[GENERATORS.baseline]||manifest.generators?.featureSha256!==sourceHashes[GENERATORS.feature]
    ||artifact.transportSha256!==sourceHashes['scripts/apply-test-workspace-release-migrations.mjs'])throw fail('reviewed source digest');
  for(const [key,path] of Object.entries(REHEARSAL_FILES))if(!HASH.test(manifest.rehearsal[key]??'')||manifest.rehearsal[key]!==sourceHashes[path])throw fail('rehearsal evidence file');
  const snapshot=JSON.parse(snapshotBytes.toString('utf8'));
  if(phase==='baseline'&&(manifest.invitationRowsSha256!==snapshot.invitationRowsSha256||!Number.isSafeInteger(manifest.affectedInvitationRows)||manifest.affectedInvitationRows<0))throw fail('invitation backup binding');
  if(phase==='feature'&&baselineMigrations(target).some((m)=>{const rows=snapshot.ledger?.filter((r)=>r.version===m.version||r.name===m.name);return rows?.length!==1||ledgerRowDigest(rows[0])!==ledgerRowDigest(m);}))throw fail('feature requires exact installed baseline');
  const bundle=phase==='baseline'?buildBaselineBundle({target,snapshot,backupSha256:artifact.backupManifestSha256}):buildAtomicBundle({target,snapshot,backupSha256:artifact.backupManifestSha256});
  if(!bundle.sql||sha256(bundle.sql)!==artifact.bundleSha256)throw fail('generated bundle digest');
  return {artifact,manifest,snapshot,bundle};
}
function loadArtifacts(operation) {
  const paths=pathsFor(operation.target,operation.phase);
  const artifactBytes=privateBytes(paths.artifact),manifestBytes=privateBytes(paths.manifest);
  const artifact=JSON.parse(artifactBytes.toString('utf8')),manifest=JSON.parse(manifestBytes.toString('utf8'));
  if(!Array.isArray(manifest.files))throw fail('backup inventory');
  const files={};for(const f of manifest.files){if(!/^[a-z0-9][a-z0-9.-]*$/.test(f.name))throw fail('backup path');files[f.name]=privateBytes(join(paths.backup,f.name));}
  if(!/^[a-z0-9][a-z0-9.-]*$/.test(artifact.snapshotFile??''))throw fail('snapshot path');
  const snapshotBytes=files[artifact.snapshotFile];if(!snapshotBytes)throw fail('snapshot missing');
  const sourcePaths=['scripts/apply-test-workspace-release-migrations.mjs',...new Set(Object.values(GENERATORS)),...Object.values(REHEARSAL_FILES)];
  const sourceHashes=Object.fromEntries(sourcePaths.map((file)=>[file,sha256(readFileSync(join(ROOT,file)))]));
  return validateArtifact({operation,artifactBytes,manifestBytes,snapshotBytes,files,sourceHashes});
}
export function credentialEnvironment(environment) {
  const env={};for(const key of ENV_KEYS)if(typeof environment[key]==='string'&&environment[key])env[key]=environment[key];
  if(!env.PATH||!env.HOME)throw fail('credential environment');return env;
}
// Non-executing shell-word tokenizer for one export assignment. No interpolation.
function shellWords(line) {
  const words=[];let word='',active=false,quote='';
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(quote==="'"){if(ch==="'")quote='';else word+=ch;active=true;continue;}
    if(quote==='"'){
      if(ch==='"'){quote='';continue;}
      if(ch==='\\'){const next=line[++i];if(next===undefined)throw fail('credential quoting');word+=['$','`','"','\\'].includes(next)?next:'\\'+next;continue;}
      // Dry-run exports must quote literal dollar/backtick characters safely.
      if(ch==='$'||ch==='`')throw fail('credential interpolation');word+=ch;continue;
    }
    if(ch==="'"||ch==='"'){quote=ch;active=true;continue;}
    if(ch==='\\'){if(i+1===line.length)throw fail('credential quoting');word+=line[++i];active=true;continue;}
    if(/\s/.test(ch)){if(active){words.push(word);word='';active=false;}continue;}
    if(/[;$`|&<>]/.test(ch))throw fail('credential shell syntax');word+=ch;active=true;
  }
  if(quote)throw fail('credential quoting');if(active)words.push(word);return words;
}
export function connectionFromDryRun(output,target,caBytes) {
  if(!Object.hasOwn(TARGETS,target)||sha256(caBytes)!==CA_SHA256)throw fail('target or TLS CA');
  const fields={};
  for(const line of output.split(/\r?\n/)){
    if(!/^\s*export\s+PG(?:HOST|PORT|DATABASE|USER|PASSWORD)\b/.test(line))continue;
    const words=shellWords(line);if(words.length!==2||words[0]!=='export')throw fail('credential export');
    const m=/^(PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD)=(.*)$/.exec(words[1]);
    if(!m||Object.hasOwn(fields,m[1])||!m[2]||/[\0\r\n]/.test(m[2]))throw fail('credential fields');fields[m[1]]=m[2];
  }
  if(Object.keys(fields).length!==5)throw fail('credential fields');
  const project=TARGETS[target];
  const direct=fields.PGHOST===`db.${project}.supabase.co`&&fields.PGUSER==='cli_login_postgres';
  const pooler=/^[a-z0-9-]+(?:\.[a-z0-9-]+)?\.pooler\.supabase\.com$/.test(fields.PGHOST)&&fields.PGUSER===`cli_login_postgres.${project}`;
  if((!direct&&!pooler)||fields.PGPORT!=='5432'||fields.PGDATABASE!=='postgres')throw fail('credential target binding');
  return {host:fields.PGHOST,port:5432,database:'postgres',user:fields.PGUSER,password:fields.PGPASSWORD,
    ssl:{ca:caBytes.toString('utf8'),servername:fields.PGHOST,rejectUnauthorized:true},connectionTimeoutMillis:15_000,statement_timeout:15_000};
}
function acquireConnectionConfig(operation) {
  const paths=pathsFor(operation.target,operation.phase);
  const cliRootStat=lstatSync(paths.cliRoot),projectFile=join(paths.cliRoot,'supabase/.temp/project-ref');
  if(!cliRootStat.isDirectory()||cliRootStat.isSymbolicLink()||(cliRootStat.mode&0o077)!==0||realpathSync(paths.cliRoot)!==paths.cliRoot
    ||!lstatSync(projectFile).isFile()||lstatSync(projectFile).isSymbolicLink()||realpathSync(projectFile)!==projectFile)throw fail('CLI isolated workspace');
  if(readFileSync(projectFile,'utf8').trim()!==TARGETS[operation.target])throw fail('CLI linked target');
  const packageJson=JSON.parse(readFileSync(join(dirname(dirname(CLI)),'package.json'),'utf8'));
  if(packageJson.version!=='2.72.7'||!lstatSync(CLI).isFile()||realpathSync(CLI)!==CLI)throw fail('cached CLI version');
  const ca=readFileSync(CA_FILE);if(sha256(ca)!==CA_SHA256)throw fail('TLS CA');
  const result=spawnSync(CLI,['db','dump','--dry-run','--linked','--workdir',paths.cliRoot],
    {cwd:paths.cliRoot,env:credentialEnvironment(process.env),encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60_000,maxBuffer:1024*1024});
  if(result.status!==0||result.signal||result.error)throw fail('credential acquisition');
  return connectionFromDryRun(String(result.stdout??''),operation.target,ca);
}
async function bounded(client,stage,operation,ms=20_000) {
  let timer;
  try{return await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{timer=setTimeout(()=>{
    // Destroy only this dedicated pg connection; do not abandon an executing loser.
    client.connection?.stream?.destroy();reject(fail(`${stage} timeout`));
  },ms);})]);}finally{clearTimeout(timer);}
}
const query=(client,text,values,ms)=>bounded(client,'query',()=>values===undefined?client.query(text):client.query(text,values),ms);
async function close(client){if(!client)return;try{await bounded(client,'close',()=>client.end(),5000);}catch{client.connection?.stream?.destroy();}}
export async function openVerifiedClient(config,createClient) {
  const client=createClient(config);let asyncError=false;
  client.on('error',()=>{asyncError=true;});
  try{
    await bounded(client,'connect',()=>client.connect());
    const socket=client.connection?.stream;
    if(!socket?.encrypted||socket.authorized!==true||socket.servername!==config.host)throw fail('TLS authorization');
    await query(client,'SET ROLE postgres');
    const result=await query(client,"select current_user as actor,current_role as role,current_database() as database,current_setting('server_encoding') as encoding,current_setting('session_replication_role') as replication,current_setting('proplane.account_recovery_internal',true) as recovery,(select ssl from pg_stat_ssl where pid=pg_backend_pid()) as tls");
    const row=result.rows[0];
    if(asyncError||row?.actor!=='postgres'||row.role!=='postgres'||row.database!=='postgres'||row.encoding!=='UTF8'||row.replication!=='origin'||row.recovery==='on'||row.tls!==true)throw fail('session identity');
    return {client,assertHealthy(){if(asyncError)throw fail('asynchronous connection error');}};
  }catch(error){await close(client);throw error;}
}
async function readOnly(client,operation) {
  await query(client,'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{await query(client,"SET LOCAL statement_timeout = '15s'");await query(client,"SET LOCAL lock_timeout = '5s'");await query(client,"SET LOCAL idle_in_transaction_session_timeout = '20s'");await query(client,'SET LOCAL search_path = pg_catalog, public');return await operation();}
  finally{await query(client,'ROLLBACK');}
}
async function readSnapshot(client,target,phase) {
  const ledger=(await query(client,'select version,name,statements from supabase_migrations.schema_migrations order by version collate "C"')).rows;
  const tables=(await query(client,"select c.relname as name,c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') order by c.relname collate \"C\"")).rows;
  const snapshot={project:TARGETS[target],read_only:'on',ledger,tables};
  if(phase==='baseline'){
    snapshot.baselineCatalog=(await query(client,`select ${BASELINE_CATALOG_SQL} as catalog`)).rows[0].catalog;
    snapshot.invitationRowsSha256=(await query(client,`select ${INVITATION_DIGEST_SQL} as digest`)).rows[0].digest;
  }
  return snapshot;
}
function sameBefore(actual,expected,phase){return stable(digestRows(actual.ledger))===stable(digestRows(expected.ledger))&&stable(actual.tables)===stable(expected.tables)
  &&(phase!=='baseline'||(stable(actual.baselineCatalog)===stable(expected.baselineCatalog)&&actual.invitationRowsSha256===expected.invitationRowsSha256));}
export function readbackSql(bundle,phase,snapshot) {
  const tags=phase==='baseline'?['baseline_after']:['release_schema_postconditions','release_ledger_postconditions'];
  return tags.map((tag)=>{
    const start=`DO $${tag}$`,end=`END $${tag}$;`;const a=bundle.sql.indexOf(start),b=bundle.sql.indexOf(end,a);
    if(a<0||b<a||bundle.sql.indexOf(start,a+start.length)!==-1||bundle.sql.indexOf(end,b+end.length)!==-1)throw fail('readback framing');
    let sql=bundle.sql.slice(a,b+end.length);
    if(phase==='baseline'){
      const lookup='(SELECT digest FROM pg_temp.baseline_invitation_evidence)';
      if(!HASH.test(snapshot.invitationRowsSha256)||sql.split(lookup).length!==2)throw fail('readback invitation binding');
      sql=sql.replace(lookup,`'${snapshot.invitationRowsSha256}'`);
    }
    return sql;
  });
}
async function freshReadback(config,createClient,prepared,operation) {
  let owned;
  try{
    owned=await openVerifiedClient(config,createClient);
    return await readOnly(owned.client,async()=>{
      const current=await readSnapshot(owned.client,operation.target,operation.phase);owned.assertHealthy();
      if(sameBefore(current,prepared.snapshot,operation.phase))return 'unchanged';
      for(const sql of readbackSql(prepared.bundle,operation.phase,prepared.snapshot))await query(owned.client,sql);
      owned.assertHealthy();return 'installed';
    });
  }catch{return 'unexpected';}finally{await close(owned?.client);}
}
export async function runTransport(operation,dependencies={}) {
  if(operation.operation==='manifest')return {status:'manifest_only',targets:TARGETS,phases:['baseline','feature'],backupManifest:'final, after combined rehearsal',artifact:'separate manifest-and-bundle hash binding'};
  let owned;let writeAttempted=false;let commitAcknowledged=false;
  const load=dependencies.loadArtifacts??loadArtifacts;
  const acquire=dependencies.acquireConnectionConfig??acquireConnectionConfig;
  const createClient=dependencies.createClient??((config)=>new (createRequire(import.meta.url)('pg').Client)(config));
  try{
    const prepared=load(operation);const config=acquire(operation);
    if(operation.operation==='verify'){
      const state=await freshReadback(config,createClient,prepared,operation);
      if(state!=='installed')throw fail('verification');return {status:'verified',target:operation.target,phase:operation.phase,bundleSha256:prepared.artifact.bundleSha256};
    }
    owned=await openVerifiedClient(config,createClient);
    const current=await readOnly(owned.client,()=>readSnapshot(owned.client,operation.target,operation.phase));owned.assertHealthy();
    if(!sameBefore(current,prepared.snapshot,operation.phase))throw fail('preflight catalog drift');
    if(operation.operation==='preflight')return {status:'preflight_passed',target:operation.target,phase:operation.phase,bundleSha256:prepared.artifact.bundleSha256};
    if(operation.operation!=='apply')throw fail('operation');
    await query(owned.client,"select set_config('proplane.release_project_ref',$1,false),set_config('proplane.release_backup_sha256',$2,false)",[TARGETS[operation.target],prepared.artifact.backupManifestSha256]);
    owned.assertHealthy();writeAttempted=true;
    try{await query(owned.client,prepared.bundle.sql,undefined,210_000);owned.assertHealthy();commitAcknowledged=true;}
    catch{try{await query(owned.client,'ROLLBACK',undefined,5000);}catch{/* Fresh readback resolves commit uncertainty. */}}
    await close(owned.client);owned=undefined;
    const state=await freshReadback(config,createClient,prepared,operation);
    if(state!=='installed')throw fail(state==='unchanged'?'apply rolled back':'apply outcome unresolved');
    return {status:'applied_verified',target:operation.target,phase:operation.phase,bundleSha256:prepared.artifact.bundleSha256,commitAcknowledged};
  }catch{throw fail(writeAttempted?'apply or readback':'preflight');}finally{await close(owned?.client);}
}
async function main(){try{const result=await runTransport(parseTransportArgs(process.argv.slice(2)));console.log(JSON.stringify(result));}catch(error){console.error(error?.code??'RELEASE_FAILED');process.exitCode=1;}}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))void main();
