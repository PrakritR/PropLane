/** Target/ref/state/backup refusal without credential or database access. */
import assert from 'node:assert/strict';
import {parseTargetOptions,assertReviewedTargetSources,bindTargetState} from '../vendor-release-target-migrations.mjs';
const candidate='a'.repeat(40), stage='xwszcafaontidfgznlxd', prod='qahnczmilgptcedaqype';
let assertions=0;
const refuses=args=>{assert.throws(()=>parseTargetOptions(args));assertions++;};
for(const args of [[],['--target','dev'],['--target','production','--confirm-ref',stage,'--expected-candidate',candidate],
 ['--target','staging','--confirm-ref',prod,'--expected-candidate',candidate],['--target','staging','--confirm-ref',stage],
 ['--target','staging','--confirm-ref',stage,'--expected-candidate',candidate,'--target','production'],
 ['--target','staging','--confirm-ref',stage,'--expected-candidate',candidate,'--phase','apply'],
 ['--target','staging','--confirm-ref',stage,'--expected-candidate',candidate,'--backup-file','/private/tmp/readonly.dump'],
 ['--target','staging','--confirm-ref',stage,'--expected-candidate',candidate,'--phase','apply','--expected-state','b'.repeat(64),'--backup-file','/tmp/wrong.dump'],
 ['--target','staging','--confirm-ref',stage,'--expected-candidate',candidate,'--force','yes'],
 ['--target','staging','--confirm-ref',stage,'--expected-candidate',candidate,'--phase','preflight','--phase','apply'],
])refuses(args);
const staging=parseTargetOptions(['--target','staging','--confirm-ref',stage,'--expected-candidate',candidate]);
const production=parseTargetOptions(['--target','production','--confirm-ref',prod,'--expected-candidate',candidate]);
assert.equal(staging.phase,'preflight');assertions++;
assert.equal(production.phase,'preflight');assertions++;
assert.equal(parseTargetOptions(['--target','production','--confirm-ref',prod,'--expected-candidate',candidate,'--phase','apply','--expected-state','b'.repeat(64),'--backup-file','/private/tmp/offline-target.dump']).phase,'apply');assertions++;
assertReviewedTargetSources();assertions++;
const state={digest:'c'.repeat(64)};
assert.notEqual(bindTargetState(staging,state),bindTargetState(production,state));assertions++;
assert.notEqual(bindTargetState(staging,state),bindTargetState({...staging,candidate:'d'.repeat(40)},state));assertions++;
assert.notEqual(bindTargetState(staging,state),bindTargetState(staging,{digest:'e'.repeat(64)}));assertions++;
console.log(JSON.stringify({result:'passed',assertions,credentialReads:0,databaseConnections:0,backupFilesCreated:0}));
