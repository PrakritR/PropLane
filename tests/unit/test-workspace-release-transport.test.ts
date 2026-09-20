import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { connect, createServer } from 'node:tls';
import { parseTransportArgs, credentialEnvironment, connectionFromDryRun, openVerifiedClient, runTransport,
  validateArtifact, readbackSql, CA_SHA256 } from '../../scripts/apply-test-workspace-release-migrations.mjs';
import { sha256, buildAtomicBundle, policyInventory } from '../../scripts/prepare-test-workspace-release-migrations.mjs';
import { baselineMigrations } from '../../scripts/prepare-test-workspace-baseline-prerequisites.mjs';

// Public checked-in CA fixture, never credentials or a cloud connection.
const ca=readFileSync(new URL('../../scripts/lib/supabase-root-2021.crt',import.meta.url));
const project='xwszcafaontidfgznlxd';
const exportsFor=(overrides:Record<string,string>={})=>Object.entries({PGHOST:`db.${project}.supabase.co`,PGPORT:'5432',PGDATABASE:'postgres',PGUSER:'cli_login_postgres',PGPASSWORD:'synthetic secret',...overrides}).map(([k,v])=>`export ${k}='${v}'`).join('\n');
const operation={operation:'apply',phase:'baseline',target:'staging',artifactSha256:'a'.repeat(64),bundleSha256:'b'.repeat(64),backupSha256:'c'.repeat(64)};
const identity={actor:'postgres',role:'postgres',database:'postgres',encoding:'UTF8',replication:'origin',recovery:null,tls:true};
function certificateFixture(directory:string,name:string) {
  const ca=join(directory,`${name}-ca.crt`),caKey=join(directory,`${name}-ca.key`),key=join(directory,`${name}-server.key`),csr=join(directory,`${name}-server.csr`),cert=join(directory,`${name}-server.crt`),extensions=join(directory,`${name}-server.ext`);
  const openssl=(args:string[])=>execFileSync('openssl',args,{stdio:'ignore'});
  openssl(['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1','-keyout',caKey,'-out',ca,'-subj',`/CN=${name} test CA`]);
  openssl(['req','-newkey','rsa:2048','-nodes','-keyout',key,'-out',csr,'-subj','/CN=localhost']);
  writeFileSync(extensions,'subjectAltName=DNS:localhost\n',{mode:0o600});
  openssl(['x509','-req','-in',csr,'-CA',ca,'-CAkey',caKey,'-CAcreateserial','-out',cert,'-days','1','-sha256','-extfile',extensions]);
  return {ca:readFileSync(ca,'utf8'),key:readFileSync(key,'utf8'),cert:readFileSync(cert,'utf8')};
}
async function tlsServer(key:string,cert:string) {
  const server=createServer({key,cert},socket=>socket.end());
  server.on('tlsClientError',()=>{});
  try{
    await new Promise<void>((resolve,reject)=>{
      const fail=(error:Error)=>{server.off('error',fail);reject(error);};
      server.once('error',fail).listen(0,'127.0.0.1',()=>{server.off('error',fail);resolve();});
    });
    const address=server.address();if(!address||typeof address==='string')throw new Error('TLS fixture address');
    return {server,port:address.port};
  }catch(error){await closeTlsServer(server).catch(()=>{});throw error;}
}
async function closeTlsServer(server:ReturnType<typeof createServer>) {
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
function connectWithTransportTls(port:number,caCertificate:string,servername='localhost') {
  // These are the explicit verify-full fields returned by connectionFromDryRun.
  const ssl={ca:caCertificate,servername,rejectUnauthorized:true};
  return new Promise<boolean>((resolve,reject)=>{
    const socket=connect({host:'127.0.0.1',port,...ssl});
    socket.on('error',()=>{});
    socket.once('error',error=>{socket.destroy();reject(error);});
    socket.once('secureConnect',()=>{socket.end();resolve(socket.authorized);});
  });
}
function clientFixture(options:{identity?:Record<string,unknown>;tls?:Record<string,unknown>;failBundle?:boolean;installed?:boolean}={}) {
  const handlers:Record<string,()=>void>={};
  const stream={encrypted:true,authorized:true,servername:`db.${project}.supabase.co`,destroy:vi.fn(),...options.tls};
  const client={connection:{stream},on:vi.fn((event:string,callback:()=>void)=>{handlers[event]=callback;}),connect:vi.fn(async()=>{}),end:vi.fn(async()=>{}),
    query:vi.fn(async(sql:string)=>{
      if(sql.startsWith('select current_user'))return {rows:[{...identity,...options.identity}]};
      if(sql.startsWith('select version,name,statements'))return {rows:options.installed?[{version:'2',name:'installed',statements:[]}]:[]};
      if(sql.startsWith('select c.relname'))return {rows:[]};
      if(sql.includes(' as catalog'))return {rows:[{catalog:{}}]};
      if(sql.includes(' as digest'))return {rows:[{digest:'d'.repeat(64)}]};
      if(sql==='BEGIN;\nSELECT 1;\nCOMMIT;'&&options.failBundle)throw new Error('private SQL and password');
      return {rows:[]};
    }),handlers};
  return client;
}
const config=()=>connectionFromDryRun(exportsFor(),'staging',ca);
function preparedFixture() {
  const sql='-- artifact\nBEGIN;\nSELECT 1;\nDO $baseline_after$ BEGIN\nIF false THEN RAISE EXCEPTION \'x\'; END IF;\nPERFORM (SELECT digest FROM pg_temp.baseline_invitation_evidence);\nEND $baseline_after$;\nCOMMIT;';
  return {artifact:{bundleSha256:sha256(sql),backupManifestSha256:'c'.repeat(64)},snapshot:{ledger:[],tables:[],baselineCatalog:{},invitationRowsSha256:'d'.repeat(64)},bundle:{sql}};
}

function artifactFixture() {
  const inventory=policyInventory();
  const snapshot={project,read_only:'on',ledger:baselineMigrations('staging').map(({version,name,statements})=>({version,name,statements})),tables:inventory.finalTables.filter((name:string)=>!inventory.created.includes(name)).map((name:string)=>({name,rls:true}))};
  const snapshotBytes=Buffer.from(JSON.stringify(snapshot));
  const sourceHashes={
    'scripts/apply-test-workspace-release-migrations.mjs':'1'.repeat(64),
    'scripts/prepare-test-workspace-baseline-prerequisites.mjs':'2'.repeat(64),
    'scripts/prepare-test-workspace-release-migrations.mjs':'3'.repeat(64),
    'scripts/testing/test-workspace-release-local-rehearsal.mjs':'4'.repeat(64),
    'docs/plans/production-test-accounts/logs/release-combined-staging-rehearsal-rerun1.log':'5'.repeat(64),
    'docs/plans/production-test-accounts/logs/release-combined-production-rehearsal.log':'6'.repeat(64),
  };
  const files={'schema-before-feature-with-acl.sql':Buffer.from('synthetic schema backup'),'migration-ledger-before-feature.sql':Buffer.from('synthetic ledger backup'),'full-catalog-feature-beforeimage.json':snapshotBytes};
  const manifest={target:'staging',project,status:'verified',sourceLedgerAndTablesMatchOriginalBackup:true,combinedPrerequisiteAndFeatureRestoreRehearsal:'passed',
    files:Object.entries(files).map(([name,bytes])=>({name,size:bytes.length,sha256:sha256(bytes)})),
    generators:{baselineSha256:'2'.repeat(64),featureSha256:'3'.repeat(64)},rehearsal:{scriptSha256:'4'.repeat(64),stagingLogSha256:'5'.repeat(64),productionLogSha256:'6'.repeat(64),exitCodes:[0,0],cleanupVerified:true}};
  const manifestBytes=Buffer.from(JSON.stringify(manifest));
  const bundle=buildAtomicBundle({target:'staging',snapshot,backupSha256:sha256(manifestBytes)});
  const artifact={schemaVersion:1,target:'staging',project,phase:'feature',backupManifestSha256:sha256(manifestBytes),snapshotFile:'full-catalog-feature-beforeimage.json',snapshotSha256:sha256(snapshotBytes),bundleSha256:sha256(bundle.sql),transportSha256:'1'.repeat(64)};
  const artifactBytes=Buffer.from(JSON.stringify(artifact));
  return {operation:{operation:'apply',phase:'feature',target:'staging',artifactSha256:sha256(artifactBytes),bundleSha256:artifact.bundleSha256,backupSha256:artifact.backupManifestSha256},artifactBytes,manifestBytes,snapshotBytes,files,sourceHashes};
}

describe('closed offline transport interface',()=>{
  it('defaults to a manifest without loading artifacts or acquiring credentials',async()=>{
    const loadArtifacts=vi.fn(),acquireConnectionConfig=vi.fn(),createClient=vi.fn();
    expect(await runTransport(parseTransportArgs([]),{loadArtifacts,acquireConnectionConfig,createClient})).toMatchObject({status:'manifest_only'});
    expect(loadArtifacts).not.toHaveBeenCalled();expect(acquireConnectionConfig).not.toHaveBeenCalled();expect(createClient).not.toHaveBeenCalled();
  });
  it('requires closed target/phase and all exact apply acknowledgements',()=>{
    expect(parseTransportArgs(['--apply-baseline-staging','--artifact-sha256','a'.repeat(64),'--bundle-sha256','b'.repeat(64),'--backup-sha256','c'.repeat(64)])).toEqual(operation);
    for(const args of [['--apply-staging'],['--apply-baseline-staging'],['--preflight-baseline-dev'],['--verify-feature-production','--db-url','secret'],['--preflight-baseline-staging','--sql','file']])expect(()=>parseTransportArgs(args)).toThrow();
  });
  it('reproduces the reviewed artifact without a backup/bundle hash cycle',()=>{
    const input=artifactFixture();
    const validated=validateArtifact(input);
    expect(validated.bundle.plan.bundleSha256).toBe(input.operation.bundleSha256);
    expect(validated.manifest).not.toHaveProperty('bundleSha256');
  });
  it.each(['backup bytes','backup size','transport source','snapshot bytes','target','phase'])('rejects changed %s',kind=>{
    const input=artifactFixture();
    if(kind==='backup bytes')input.files['schema-before-feature-with-acl.sql']=Buffer.from('changed');
    if(kind==='backup size')input.files['migration-ledger-before-feature.sql']=Buffer.from('changed length');
    if(kind==='transport source')input.sourceHashes['scripts/apply-test-workspace-release-migrations.mjs']='9'.repeat(64);
    if(kind==='snapshot bytes')input.snapshotBytes=Buffer.from('{}');
    if(kind==='target')input.operation.target='production';
    if(kind==='phase')input.operation.phase='baseline';
    expect(()=>validateArtifact(input)).toThrow();
  });
  it('rejects pending or wrong-target manifests before opening a connection',()=>{
    for(const manifest of [{target:'staging',project,status:'pending'},{target:'production',project:'qahnczmilgptcedaqype',status:'verified'}]) {
      expect(()=>validateArtifact({operation,artifactBytes:Buffer.from('{}'),manifestBytes:Buffer.from(JSON.stringify(manifest)),snapshotBytes:Buffer.from('{}'),files:{},sourceHashes:{}})).toThrow(/final backup manifest/);
    }
  });
  it('rejects changed bundle/backup acknowledgements before source generation',()=>{
    const manifest={target:'staging',project,status:'verified',combinedPrerequisiteAndFeatureRestoreRehearsal:'passed',rehearsal:{exitCodes:[0,0],cleanupVerified:true},sourceLedgerAndTablesMatchOriginalBackup:true};
    const manifestBytes=Buffer.from(JSON.stringify(manifest)),snapshotBytes=Buffer.from('{}');
    const artifact={schemaVersion:1,target:'staging',project,phase:'baseline',bundleSha256:'b'.repeat(64),backupManifestSha256:sha256(manifestBytes),snapshotSha256:sha256(snapshotBytes)};
    expect(()=>validateArtifact({operation,artifactBytes:Buffer.from(JSON.stringify(artifact)),manifestBytes,snapshotBytes,files:{},sourceHashes:{}})).toThrow(/acknowledgements/);
  });
});

describe('private credential parsing and TLS',()=>{
  it('uses the pinned public CA and exact direct or official session-pooler binding',()=>{
    expect(sha256(ca)).toBe(CA_SHA256);
    expect(config()).toMatchObject({host:`db.${project}.supabase.co`,port:5432,password:'synthetic secret',ssl:{rejectUnauthorized:true,servername:`db.${project}.supabase.co`}});
    expect(connectionFromDryRun(exportsFor({PGHOST:'aws-0-us-east-1.pooler.supabase.com',PGUSER:`cli_login_postgres.${project}`}), 'staging',ca).user).toBe(`cli_login_postgres.${project}`);
  });
  it('drops every inherited database override',()=>{
    expect(credentialEnvironment({PATH:'/p',HOME:'/h',PGPASSWORD:'bad',PGHOST:'bad',PGSSLMODE:'disable',SUPABASE_DB_PASSWORD:'bad',NODE_OPTIONS:'bad'})).toEqual({PATH:'/p',HOME:'/h'});
  });
  it('handles literal quoted shell characters without evaluating them',()=>{
    const output=exportsFor().replace("'synthetic secret'",'"quoted \\$value \\`literal\\`"');
    expect(connectionFromDryRun(output,'staging',ca).password).toBe('quoted $value `literal`');
    expect(()=>connectionFromDryRun(exportsFor().replace("'synthetic secret'",'"$(malicious)"'),'staging',ca)).toThrow(/interpolation/);
    expect(()=>connectionFromDryRun(exportsFor()+"\nexport PGPASSWORD='duplicate'",'staging',ca)).toThrow();
    expect(()=>connectionFromDryRun(exportsFor().replace(/export PGPORT=.*\n/,''),'staging',ca)).toThrow();
  });
  it.each([{PGHOST:'attacker.example'},{PGHOST:'db.xwszcafaontidfgznlxd.supabase.co.evil'},{PGPORT:'6543'},{PGDATABASE:'other'},{PGUSER:'postgres'},{PGHOST:'aws-0-us-east-1.pooler.supabase.com',PGUSER:'cli_login_postgres.qahnczmilgptcedaqype'}])('rejects connection drift %j',overrides=>{
    expect(()=>connectionFromDryRun(exportsFor(overrides),'staging',ca)).toThrow(/binding/);
  });
  it('rejects changed CA and unauthorized or wrong-host TLS',async()=>{
    expect(()=>connectionFromDryRun(exportsFor(),'staging',Buffer.from('changed'))).toThrow(/TLS CA/);
    for(const tls of [{authorized:false},{servername:'wrong.example'},{encrypted:false}]){
      const client=clientFixture({tls});await expect(openVerifiedClient(config(),()=>client)).rejects.toThrow(/TLS authorization/);expect(client.end).toHaveBeenCalled();
    }
  });
  it('accepts only a trusted localhost CA and certificate with Node verify-full TLS',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'proplane-release-tls-'));
    const servers:ReturnType<typeof createServer>[]=[];
    try{
      const trusted=certificateFixture(directory,'trusted'),untrusted=certificateFixture(directory,'untrusted');
      const trustedServer=await tlsServer(trusted.key,trusted.cert);servers.push(trustedServer.server);
      const untrustedServer=await tlsServer(untrusted.key,untrusted.cert);servers.push(untrustedServer.server);
      await expect(connectWithTransportTls(trustedServer.port,trusted.ca)).resolves.toBe(true);
      await expect(connectWithTransportTls(trustedServer.port,trusted.ca,'wrong.localhost')).rejects.toMatchObject({code:'ERR_TLS_CERT_ALTNAME_INVALID'});
      await expect(connectWithTransportTls(trustedServer.port,untrusted.ca)).rejects.toBeDefined();
      await expect(connectWithTransportTls(untrustedServer.port,trusted.ca)).rejects.toBeDefined();
    }finally{
      try{await Promise.all(servers.map(closeTlsServer));}
      finally{rmSync(directory,{recursive:true,force:true});}
    }
  });
  it.each([{actor:'other'},{role:'other'},{replication:'replica'},{recovery:'on'},{database:'other'},{tls:false}])('rejects session identity drift %j',drift=>{
    const client=clientFixture({identity:drift});return expect(openVerifiedClient(config(),()=>client)).rejects.toThrow(/session identity/);
  });
});

describe('immutable execution and owned cleanup',()=>{
  it('derives a read-only verifier without changing the bundle or its transaction framing',()=>{
    const prepared=preparedFixture(),before=prepared.bundle.sql;
    const verifier=readbackSql(prepared.bundle,'baseline',prepared.snapshot);
    expect(prepared.bundle.sql).toBe(before);expect(verifier[0]).not.toContain('pg_temp.baseline_invitation_evidence');
    expect(verifier[0]).toContain(`'${'d'.repeat(64)}'`);
    expect(()=>readbackSql({sql:'broken'},'baseline',prepared.snapshot)).toThrow(/framing/);
  });
  it('preflights in read-only mode and closes its dedicated connection',async()=>{
    const client=clientFixture(),prepared=preparedFixture();
    const result=await runTransport({...operation,operation:'preflight'},{loadArtifacts:()=>prepared,acquireConnectionConfig:config,createClient:()=>client});
    expect(result.status).toBe('preflight_passed');
    expect(client.query.mock.calls.map(([sql])=>sql)).toContain('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(client.query.mock.calls.map(([sql])=>sql)).not.toContain(prepared.bundle.sql);expect(client.end).toHaveBeenCalled();
  });
  it('sends the exact bundle after attestations and verifies through a fresh connection',async()=>{
    const prepared=preparedFixture(),initial=clientFixture(),fresh=clientFixture({installed:true});
    const createClient=vi.fn().mockReturnValueOnce(initial).mockReturnValueOnce(fresh);
    const result=await runTransport(operation,{loadArtifacts:()=>prepared,acquireConnectionConfig:config,createClient});
    expect(result).toMatchObject({status:'applied_verified',commitAcknowledged:true});
    const calls=initial.query.mock.calls.map(([sql])=>sql);
    expect(calls.indexOf(prepared.bundle.sql)).toBeGreaterThan(calls.findIndex((sql)=>sql.includes("set_config('proplane.release_project_ref'")));
    expect(createClient).toHaveBeenCalledTimes(2);expect(initial.end).toHaveBeenCalled();expect(fresh.end).toHaveBeenCalled();
  });
  it('sanitizes bundle errors and refuses success when fresh readback is unchanged',async()=>{
    const prepared=preparedFixture(),initial=clientFixture(),fresh=clientFixture();
    const original=initial.query.getMockImplementation()!;
    initial.query.mockImplementation(async(sql:string)=>{if(sql===prepared.bundle.sql)throw new Error('password and SQL');return original(sql);});
    await expect(runTransport(operation,{loadArtifacts:()=>prepared,acquireConnectionConfig:config,createClient:vi.fn().mockReturnValueOnce(initial).mockReturnValueOnce(fresh)})).rejects.toThrow('Details suppressed');
    expect(initial.query.mock.calls.map(([sql])=>sql)).toContain('ROLLBACK');expect(fresh.end).toHaveBeenCalled();
  });
  it('refuses a changed before-ledger without sending the write bundle',async()=>{
    const prepared=preparedFixture(),initial=clientFixture({installed:true});
    await expect(runTransport(operation,{loadArtifacts:()=>prepared,acquireConnectionConfig:config,createClient:()=>initial})).rejects.toThrow(/preflight/);
    expect(initial.query.mock.calls.map(([sql])=>sql)).not.toContain(prepared.bundle.sql);
    expect(initial.end).toHaveBeenCalled();
  });
  it('refuses acknowledged commit when fresh readback finds changed invitation state',async()=>{
    const prepared=preparedFixture(),initial=clientFixture(),fresh=clientFixture({installed:true});
    const actualInvitationDigest='e'.repeat(64);
    const original=fresh.query.getMockImplementation()!;
    fresh.query.mockImplementation(async(sql:string)=>{
      if(sql.includes(' as digest'))return {rows:[{digest:actualInvitationDigest}]} as never;
      // Hermetic backend models the pinned full-row digest postcondition. A
      // successful write acknowledgement cannot authorize a different row state.
      if(sql.startsWith('DO $baseline_after$') && actualInvitationDigest!==prepared.snapshot.invitationRowsSha256)throw new Error('Invitation row change prohibited');
      return original(sql);
    });
    await expect(runTransport(operation,{loadArtifacts:()=>prepared,acquireConnectionConfig:config,createClient:vi.fn().mockReturnValueOnce(initial).mockReturnValueOnce(fresh)})).rejects.toThrow(/apply or readback/);
    expect(fresh.query.mock.calls.some(([sql])=>sql.startsWith('DO $baseline_after$'))).toBe(true);
    expect(fresh.end).toHaveBeenCalled();
  });
  it('resolves a lost commit acknowledgement only through fresh installed-state verification',async()=>{
    const prepared=preparedFixture(),initial=clientFixture(),fresh=clientFixture({installed:true});
    const original=initial.query.getMockImplementation()!;
    initial.query.mockImplementation(async(sql:string)=>{if(sql===prepared.bundle.sql)throw new Error('lost acknowledgement');return original(sql);});
    expect(await runTransport(operation,{loadArtifacts:()=>prepared,acquireConnectionConfig:config,createClient:vi.fn().mockReturnValueOnce(initial).mockReturnValueOnce(fresh)})).toMatchObject({status:'applied_verified',commitAcknowledged:false});
  });
  it('destroys only the owned socket on a bounded connect timeout',async()=>{
    vi.useFakeTimers();
    try{
      const client=clientFixture();client.connect.mockImplementation(()=>new Promise(()=>{}));
      const pending=openVerifiedClient(config(),()=>client);const assertion=expect(pending).rejects.toThrow(/timeout/);
      await vi.advanceTimersByTimeAsync(20_001);await assertion;expect(client.connection.stream.destroy).toHaveBeenCalled();expect(client.end).toHaveBeenCalled();
    }finally{vi.useRealTimers();}
  });
});
