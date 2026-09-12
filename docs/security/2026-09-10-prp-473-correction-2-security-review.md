# PRP-473 correction 2 security review

Date: 2026-09-10. Independent mandatory security-review delegate under `docs/ship-gate.md`.

Base and HEAD: `0b6d56794407277761ad5f6c680a522e97db2e6d`. Keeper: `akhil/backlog-repeat-issues`. Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`. Reviewed the uncommitted PRP-473 source changes, including untracked `src/lib/sms/tour-sms-eligibility.server.ts`, plus relevant reply regression tests and dependencies. This report applies to this dirty snapshot, not a later commit. Unrelated workflow/backlog/sibling artifacts are excluded.

Read original root AGENTS and Akhil instructions, ship gate, original plan, correction-2 plan/handoff, review-2 and correction-1 security report. Used graphify skill instructions for orientation; no current graph file was present at the checked worktree paths, and the handoff records the incompatible installed CLI. No graph artifact was generated. No source edits, database access, external sends, test-suite/compiler duplication, commit, push, promotion, or no-mistakes invocation. The only written file is this report.

Disposition: two unresolved P2 (Medium) findings. No Critical or High issue established. The final automatic correction does not satisfy the complete reply-snapshot and ambiguity requirements; return findings to Akhil, without starting another correction cycle.

## P2 / Medium - The final consume CAS drops the repaired legacy snapshot guard

Locations: `src/lib/tour-reschedule-sms-reply.server.ts:413` checks the original snapshot once after repair; the final planned CAS at `:573` / `:578` never applies it again. The pending-inquiry final CAS at `:357` / `:361` likewise has no repair snapshot argument.

After legacy A is upgraded, the guarded reread rejects a changed A at that moment. A subsequent change before the final CAS can still alter source inquiry, origin/consent evidence, conversation identity or requested timestamp while keeping generation, version, phone pair and window. The final CAS reads the new record and accepts it because those original snapshot fields are omitted from its predicate. It consumes the inbound SID and confirms the changed row.

Independently reproduced against the actual current module, with storage and imports mocked in memory. Read 6, the final CAS read after the upgrade and guarded reread, separately changed each of `smsOrigin` (leasing_sms to non_sms), `sourceInquiryId`, `conversationKey`, `requestedAt`, and `smsConsent`. The competing write also advanced the row CAS timestamp. Every case returned `confirmed`, with six reads and two successful writes, preserving the changed field while consuming the reply. This is not a cross-owner bypass: current owner and phone checks still hold. It is the explicit correction-2 original-snapshot-through-consumption requirement remaining incomplete.

Required resolution: preserve the repair guard through both planned and pending final mutations and apply the same upgraded snapshot predicate on every CAS retry. Cover the gap after the guarded reread, not only replacement before it. The planned path is dynamically demonstrated; the equivalent pending gap is source-reviewed.

## P2 / Medium - Eligible legacy proposals disappear from mixed-proposal ambiguity detection

Locations: `src/lib/tour-reschedule-sms-reply.server.ts:397` excludes every legacy proposal from modern matches; `:440` attempts repair only when exactly one legacy candidate exists; `:522` counts only modern planned/pending matches.

With one modern eligible proposal and two actionable legacy proposals for the same authorized owner and exact phone pair, repair is skipped because there are two legacy candidates. The modern match count remains one and the generic YES confirms that modern proposal, even though the guest could be answering either legacy update. This violates the retained ambiguity requirement.

Independently reproduced with three active rows whose proposal versions/windows/generations and sender pairs are internally consistent. Legacy rows have SMS origin and shared valid conversation authority; the harness supplies a positive eligibility resolver. Actual result: `kind: confirmed`, one write, statuses `[confirmed, awaiting_reply, awaiting_reply]`. The eligible resolver is not even consulted for those two legacy candidates. No foreign-owner access or external send is demonstrated.

Required resolution: establish ambiguity across all currently actionable, authorized legacy and modern candidates before consuming a reply; fail closed or route manager follow-up when a unique target cannot be established. Add mixed-generation cases, including two legacy plus one modern and cross planned/pending inventories.

## Other boundaries reviewed

- Prior terminal-B overwrite and immediate post-upgrade replacement defects are addressed by the upgrade-only expected snapshot, row-generation checks and one bounded guarded reread. The final-CAS gap above remains.
- Planned cancel/reschedule now project the stored owner from the event authorized by `loadOwnedPlannedTour`, including through the notification window. The notifier uses that owner for consent, signed Reply-To, inbox identity and proposal recording.
- Public create strips incoming `smsOrigin`; the SMS tool checks the supplied phone against sender context and channel is explicit. Confirmation and acceptance preserve provenance. No new model-authored consent or owner parameter is trusted as authentication.
- The eligibility helper reads owner/phone/service/transactional-purpose/conversation scope and global suppression. Derived grants retain source-conversation evidence and timestamp; retries and the exact five-purpose dispatcher allowlist recheck current derived authority. No new migration, RLS privilege or raw SQL surface is introduced.
- Signed Reply-To uses the existing owner/recipient HMAC helper and is attached to the same payload whose generated copy claims email replies. No private manager email is introduced as a fallback. Existing documented forwarded-address/From-spoofing residual is unchanged.
- Lifecycle result summaries omit recipient phone/email/body and free-form provider errors. The existing generic trace wrapper's exception behavior was not changed or separately hardened in this diff.
- This review does not establish actual provider delivery, STOP/START handset behavior, inbox browser acceptance or staging QA. Parent owns focused-suite execution; implementation handoff results were inspected, not independently rerun here.

## Commands and independent evidence

Read-only inspection commands included `git status --short`, `git rev-parse HEAD`, `git diff -- <scoped source paths>`, `sed -n` / `nl -ba` for the referenced functions/dependencies and `git diff --check`. The latter exited 0. Source inspection used current files rather than old graph line locations.

The exact no-file executable probe below ran from the worktree, exited 0, and reported Node v22.23.0. It transpiles only the actual reply module in memory; every dependency and storage boundary is mocked. It asserts the reproduced failures, so its exit 0 means successful reproduction, not a passing product behavior gate.

```bash
PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:$PATH NODE_OPTIONS=--max-old-space-size=4096 SMS_RUNTIME_ENABLED=0 SMS_OUTBOX_SCHEDULER_READY=0 node <<'NODE'
const fs = require('node:fs');
const ts = require('typescript');
const assert = require('node:assert/strict');
const file = 'src/lib/tour-reschedule-sms-reply.server.ts';
const modules = {
  'server-only': {},
  '@/lib/pacific-time': { formatPacificDateTime: d => d.toISOString() },
  '@/lib/agent-notify.server': { notifyManagerFromAgent: async () => ({ delivered: true }) },
  '@/lib/twilio': { normalizeE164: p => /^\+\d{11}$/.test(p) ? p : null },
  '@/lib/claw-messenger.server': { normalizeE164Us: p => /^\+\d{11}$/.test(p) ? p : null },
  '@/lib/sms/manager-number-provisioning.server': { resolveActiveManagerSendNumber: async () => '+12065550999' },
  '@/lib/tour-slot-math': { isActivePlannedTourEvent: e => !e.canceledAt },
  '@/lib/sms/tour-sms-eligibility.server': { resolveTourSmsEligibility: async () => ({
    eligible: true, phoneE164: '+12065550100', conversationKey: 'owner:prospect:phone', provenance: 'recipient_initiated_inbound'
  }) },
};
const moduleObject = { exports: {} };
new Function('require', 'module', 'exports', ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText)(id => { if (!(id in modules)) throw new Error(id); return modules[id]; }, moduleObject, moduleObject.exports);
const handle = moduleObject.exports.handleTourRescheduleSmsReply;
const plannedId = 'axis_admin_planned_events_v1';
const inquiryId = 'axis_admin_partner_inquiries_v1';
const start = '2026-09-12T18:00:00.000Z', end = '2026-09-12T18:30:00.000Z';
function event(id, eligible) {
  const generation = 'gen-' + id;
  return { id, sourceInquiryId: 'inquiry-' + id, managerUserId: 'manager-1',
    attendeePhone: '+12065550100', smsOrigin: 'leasing_sms', smsConsent: false, start, end,
    rescheduleNotificationGeneration: generation, guestRescheduleReply: {
      version: [id,start,end,'+12065550100',generation].join(':'), generation,
      proposedStart:start, proposedEnd:end, requestedAt:start, status:'awaiting_reply',
      phoneE164:'+12065550100', workNumber:'+12065550999', conversationKey:'original-key',
      ...(eligible ? {smsEligibility:'eligible'} : {})
    } };
}
function store(initial, mutateRead) {
  const records = new Map([[plannedId, {rows:structuredClone(initial), at:'2026-09-08T12:00:00.000Z'}],
    [inquiryId, {rows:[], at:'2026-09-08T12:00:00.000Z'}]]);
  let reads=0, writes=0, contested=false;
  const db = {from(table) {
    assert.equal(table,'portal_schedule_records');
    const state={};
    const chain={select:()=>chain, eq:(k,v)=>{state[k]=v;return chain;},
      update:v=>{state.update=v;return chain;},
      maybeSingle:async()=>{
        const rec=records.get(state.id);
        if(!state.update) {
          reads++;
          if(mutateRead && mutateRead(reads,rec.rows)) {
            contested=true;
            rec.at=new Date(Date.parse(rec.at)+1).toISOString();
          }
          return {data:{row_data:{payload:structuredClone(rec.rows)},updated_at:rec.at},error:null};
        }
        if(state.updated_at!==rec.at) return {data:null,error:null};
        rec.rows=structuredClone(state.update.row_data.payload);rec.at=state.update.updated_at;writes++;
        return {data:{id:state.id},error:null};
      }};
    return chain;
  }};
  return {db, result:()=>({reads,writes,contested,rows:records.get(plannedId).rows})};
}
const input={managerUserId:'manager-1',fromPhone:'+12065550100',toPhone:'+12065550999',body:'YES',messageSid:'SM-security-probe'};
(async()=>{
  console.log('node',process.version);
  for(const mutation of ['smsOrigin','sourceInquiryId','conversationKey','requestedAt','smsConsent']) {
    const s=store([event('tour-1',false)],(read,rows)=>{
      if(read!==6) return false;
      if(mutation==='smsOrigin') rows[0].smsOrigin='non_sms';
      else if(mutation==='sourceInquiryId') rows[0].sourceInquiryId='different-inquiry';
      else if(mutation==='smsConsent') rows[0].smsConsent=true;
      else rows[0].guestRescheduleReply[mutation]='changed';
      return true;
    });
    const reply=await handle(s.db,input), result=s.result();
    assert.equal(result.contested,true); assert.equal(result.writes,2);
    assert.equal(reply.kind,'confirmed'); assert.equal(result.rows[0].guestRescheduleReply.status,'confirmed');
    console.log(JSON.stringify({probe:'post-guard-final-CAS',mutation,kind:reply.kind,reads:result.reads,writes:result.writes,contested:result.contested}));
  }
  const s=store([event('modern',true),event('legacy-1',false),event('legacy-2',false)]);
  const reply=await handle(s.db,input),result=s.result();
  assert.equal(reply.kind,'confirmed'); assert.equal(result.writes,1);
  assert.deepEqual(result.rows.map(r=>r.guestRescheduleReply.status),['confirmed','awaiting_reply','awaiting_reply']);
  console.log(JSON.stringify({probe:'mixed-modern-legacy-ambiguity',kind:reply.kind,writes:result.writes,statuses:result.rows.map(r=>r.guestRescheduleReply.status)}));
})().catch(e=>{console.error(e);process.exitCode=1;});
NODE
```

Observed output:

```json
{"probe":"post-guard-final-CAS","mutation":"smsOrigin","kind":"confirmed","reads":6,"writes":2,"contested":true}
{"probe":"post-guard-final-CAS","mutation":"sourceInquiryId","kind":"confirmed","reads":6,"writes":2,"contested":true}
{"probe":"post-guard-final-CAS","mutation":"conversationKey","kind":"confirmed","reads":6,"writes":2,"contested":true}
{"probe":"post-guard-final-CAS","mutation":"requestedAt","kind":"confirmed","reads":6,"writes":2,"contested":true}
{"probe":"post-guard-final-CAS","mutation":"smsConsent","kind":"confirmed","reads":6,"writes":2,"contested":true}
{"probe":"mixed-modern-legacy-ambiguity","kind":"confirmed","writes":1,"statuses":["confirmed","awaiting_reply","awaiting_reply"]}
```
