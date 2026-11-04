/** Exercise actual CLI target/ownership refusal with network replaced in child processes. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const url='https://emstjswhotsnyksqhqyf.supabase.co';
const stage='https://xwszcafaontidfgznlxd.supabase.co';
const refuseNetwork='globalThis.fetch=async()=>{process.stdout.write("NETWORK_CALLED");throw Error("unexpected network")};';
function run(args, appUrl=url, loader=refuseNetwork){
 return spawnSync(process.execPath,['--import',`data:text/javascript,${encodeURIComponent(loader)}`,'scripts/testing/seed-vendor-release.mjs',...args],{
  cwd:new URL('../..',import.meta.url),encoding:'utf8',env:{PATH:process.env.PATH,NEXT_PUBLIC_SUPABASE_URL:appUrl,SUPABASE_SERVICE_ROLE_KEY:'offline-not-a-credential'},
 });
}
let assertions=0;
for(const [args,appUrl] of [
 [['--target','production'],url], [['--target','staging'],url], [['--target','dev'],'https://qahnczmilgptcedaqype.supabase.co'],
 [[],url], [['--target','dev','--target','staging'],url], [['--target','','--target','staging'],stage], [['--target','dev','--apply'],url],
 [['--target','dev','--inspect','--apply','--schema-confirmed'],url], [['--target','staging','--force'],stage],
]){const r=run(args,appUrl);assert.notEqual(r.status,0);assert.doesNotMatch(r.stdout+r.stderr,/NETWORK_CALLED/);assertions+=2;}
for(const metadata of [{vendorReleaseFixture:'foreign'}, {vendorReleaseFixture:'vendor-release-20261104-staging',role:'manager',vendorReleaseFixtureProject:'qahnczmilgptcedaqype',vendorReleaseFixtureTarget:'staging'}]){
 const users=[{id:'foreign-user',email:'vendor-release-20261104-staging-manager@example.invalid',user_metadata:metadata}];
 const loader=`globalThis.fetch=async(input,init)=>{if((init?.method??'GET')!=='GET'){process.stdout.write('MUTATION_CALLED');throw Error('write denied')}return new Response(JSON.stringify(${JSON.stringify({users})}),{status:200,headers:{'Content-Type':'application/json'}})};`;
 const r=run(['--target','staging','--apply','--schema-confirmed'],stage,loader);
 assert.notEqual(r.status,0);assert.match(r.stderr,/Fixture account ownership mismatch/);assert.doesNotMatch(r.stdout+r.stderr,/MUTATION_CALLED/);assertions+=3;
}
console.log(JSON.stringify({result:'passed',assertions,liveDatabaseRequests:0,providerRequests:0}));
