# PRP-472 correction 1 fresh Astra review - September 13, 2026

**Result: CORRECTION REQUIRED.** The two initial High findings are corrected in their original forms, and server CAS/security controls remain sound. Three remaining Medium source-contract defects and one Medium permission-test defect block acceptance. [Correction 2](2026-09-13-prp-472-correction-2-plan.md) is the final allowed automated correction cycle.

## Review boundary

Keeper `akhil/prp-472-inbox-unread`, HEAD `3c997bc4f09ef3b97c80cb559e8909830e164868`, plus the frozen uncommitted feature and correction source/tests/SQL. Root's 15-file aggregate freeze digest is `74359f8b6b0f799f1976b018fb8b8ed976cad1c6b9dfcd1c4852edad642c6a6b`; manifest `/private/tmp/axis-inbox-cycle/prp472-c1-source-freeze.json`. The integration checkpoint has reviewed PRP-470 parent `8cfe3491372515bb2acd96a346ce688047a83ca6` and pinned-main parent `203d5e58f3ad99e6a977d65b1bbdb69115c52711`. The initial review already inspected the merge resolutions; this review assessed their preservation where touched by correction, without re-auditing 259 unrelated upstream files.

Read repository/Akhil instructions, canonical feature-cycle process, initial plans/addenda/handoffs/review, correction plan/handoff, Communication/UI instructions, ship gate, local Next Route Handlers guide, initial security reports and RPC/root validation. User root instructions prevail over stale resident-scheduling and dated production-exception prose. No source edit, test edit, git mutation, Linear write, provider send, database mutation, browser session action or server action was performed. Reports and private diagnostic harnesses are the only writes.

Required fresh disjoint delegate reports: [security review](../security/2026-09-13-prp-472-correction-1-security-review.md), [Bugbot](../security/2026-09-13-prp-472-correction-1-bugbot.md). Security owned server authorization, CAS, partial results and metadata serialization. Bugbot owned storage/collapse/member reconciliation. This reviewer owned pane/controller wiring, rendering/performance/native assessment, evidence and synthesis.

Neither graph directory exists in this pool. Filesystem discovery exited 2 for `.graphify` and `graphify-out`; no semantic result is claimed. Sol's graph hook failure remains explicitly recorded, with no global tooling repair.

## Initial R1-R5 resolution map

| Initial finding | Review resolution |
| --- | --- |
| R1 High: subset or stale response clears newer merged unread | Original defect fixed. Complete markers, all-source coverage and exact observations prevent old A from clearing new/revised/missing B, legacy rows and conflicts. Bugbot's actual-function probes preserved whole row references, including archive/body/attachments/drafts. New C1 concerns confirmed state across later operations. |
| R2 High: losing email alias acknowledged without being rendered | Original alias defect fixed. Selected authorized email snapshot feeds the actual pane, including every bound alias and attachments; selected observations correspond to that content. Independently inspected real alias-held screenshot shows alias body, both canonical email bodies and native SMS. New C3 concerns explicit-binding information lost by a preceding collapse. |
| R3 Medium: pending email suppresses new SMS and later A epoch | Original pending defects fixed in source: native work precedes email deduplication; signatures contain epoch and viewer; cleanup owns its token; callback/result/toast authority guards reject stale A. C2 is a distinct failed-storage retry loop. Retained tests do not yet prove all actual combined wiring cases. |
| R4 Medium: errors manufacture unread, lose partial commits, leak pending | Server partial outcomes and normal native-storage exception continuation are fixed; response shape validation rejects missing/duplicate/extra/malformed results. Original GET-prior false is preserved on a first failure. C1 still manufactures unread after a successful prior open, and C2 makes persistent storage failure unbounded. |
| R5 Medium: true assistant collapse loses observations | Fixed. Both actual merge branches union observations, propagate incomplete/conflicting metadata through successive passes, and keep oldest body/root attachments aligned, including absent root attachments. Both response-only fields are stripped at all changed durable boundaries. |

## C1 - Medium / P2: confirmed read state is not recorded in source metadata

Locations: `src/lib/portal-inbox-storage.ts:1017-1018`, `src/lib/portal-inbox-read-operation.client.ts:60,66,78`, and `src/components/portal/pro-unified-inbox.tsx:967`.

Reconciliation changes aggregate `thread.unread` but leaves `thread.readSources[].unread` at its old GET value. The next operation captures its rollback baseline from that stale source value. A successful open followed by a failed reopen before a fresh GET therefore changes an already-read conversation back to unread.

Actual-function probe output:

```text
Initial: aggregate unread=true, source unread=true
First read success: aggregate unread=false, source unread=true
Reopen, request fails: aggregate unread=true, source unread=true
```

The partial A-success/B-failure variant also retains A's obsolete source truth. After later all-success, another failed attempt restores aggregate true. Pending ownership is cleaned, so this is a state consistency defect rather than a leaked lock. Bodies, attachments and folders survive, but badges and Read/Unread filtering become wrong.

Fix confirmed per-source state and optimistic ownership coherently. Do not simply overwrite every source on optimistic staging: overlapping operations must not capture another operation's speculative false as their confirmed baseline. Retain exact observation revision guards, preserve confirmed partial commits, and test multiple opens and overlapping source sets. A fresh GET remains authoritative and must not have its new revision overwritten.

## C2 - Medium / P2: persistent native receipt-storage failure causes a render/toast loop

Locations: `src/components/portal/pro-unified-inbox.tsx:1034-1036`, `src/components/portal/pro-resident-detail-inbox.tsx:303-304`, `src/lib/portal-inbox-read-operation.client.ts:49-57,84`.

When localStorage throws, the manager callback publishes a new Set even if every ID is already in the in-memory set, then rethrows. The controller returns false. The pane therefore does not latch its visible signature. That Set changes `allSmsItems`, merged rows, selected row, selected native array and callback identity; the pane effect runs again. The same failed write creates another Set and toast. This continues while the email POST is held; after settlement it can also start further POST attempts.

Primary reviewer invoked the actual AST-extracted manager callback and pane effect with the actual operation controller in a bounded six-pass render-cycle simulation:

```text
passes=6, stateUpdates=6, storageWrites=6, notices=6,
heldEmailPosts=1, lastViewedSignature="", pending=1
```

Command: Node 22 `/private/tmp/axis-inbox-cycle/prp472-c1-loop-probe.cjs`, exit 0. This is deterministic callback/effect evidence, not a full React or browser run. The dependency chain above is present in the actual component. Helper-only storage tests have no React state feedback, so they miss it.

Distinguish hidden/deferred observations from a visible attempt that failed and requires explicit retry. Avoid redundant Set publication and bound retry/toast behavior per visible attempt. Keep local native handling independent of pending email, preserve current-viewer ownership, and allow an explicit reopen after storage recovers. Add a retained actual manager + pane + controller test with persistent storage failure before claiming the loop fixed.

## C3 - Medium / P2: conflicting explicit bindings are erased before read selection

Locations: `src/lib/portal-inbox-storage.ts:929,946`, `src/components/portal/pro-unified-inbox.tsx:582-584,980-1004`.

Two same-email raw sources explicitly bound to K1 and K2 collapse into one row with `smsConversationKey=undefined`. That erases the fact that explicit bindings existed. If K1 and K2 are unavailable while native K3 has the same email, the row becomes an ordinary email match: K3 merges and is selected/opened. An unresolved explicit relationship has thereby become fallback eligibility.

Bugbot probed actual person collapse, unified merge, and selected-native callback: raw keys K1/K2 -> collapsed key null -> selected K3; list members become `sms:K3,email:A,email:B`. This is an existing collapse-information loss extended into the new read side effect, not a claim that correction 1 introduced the collapse behavior. It violates the feature's explicit unresolved-binding and owner/role-selection contract.

Preserve exact binding membership or an explicit conflict/presence state through the selected projection. When any selected source declares an explicit binding, do not infer another binding from email or phone. Render/open only authorized exact native members actually selected; preserve ordinary unbound unique-email behavior and existing unrelated list behavior. This can be corrected locally without redesigning global person identity.

## C4 - Medium / P2: effective-admin test models unrestricted manager mailbox access

Locations: `tests/unit/portal-inbox-read-route-contract.test.ts:21,24,170-176`; actual helper `src/lib/portal-inbox-thread-scope.ts:18-25,63-70`.

The new test makes `role=admin` bypass all owner filtering and expects an unrelated manager-scope owner's row to succeed. The real scope helper does not grant that access. It permits the effective viewer's owner/participant/linked rows, plus admin-scope rows. The mocked `resolveInboxScopeUser` never models effective-target substitution, so this test cannot prove the required admin boundary and encodes the wrong contract.

No production authorization bypass was found. This is a security-test correctness and acceptance defect. Replace the permissive model with real scope helpers and a filter-aware fake database; exercise authenticated admin -> authorized effective target, target-owned success, unrelated manager-owner denial and mixed batch zero writes. Include real empty/read/edit co-manager permission normalization rather than assuming grants in a stub. The delegate report details the minimal correction and remaining retry-read coverage limits.

## Evidence and preservation

Source review confirms PRP-470 initial readiness still requires successful email, applications and enabled SMS; viewer generation, success-only GET TTL, failed-refresh invalidation and SMS coalescing remain unchanged. Correction changes neither Next route topology nor nav, push, uploads, native shell code or agent tools. Shared web/Capacitor UI is preserved, existing analytics attributes remain, and no PII event or new cache/network refresh loop is intentionally added. C2 is a concrete accidental rendering/performance regression.

Service-only invoker SQL hash remains `8a6007c229d637f3eb4d6091650ddb8c546a7f5dee353abcb157e4bd99f5bad6`. Root's DEV catalog/real anon+authenticated 42501/CAS/50+150-history/same-timestamp/both-order-race/15-record cleanup evidence remains applicable. No SQL reapply or repeat probe is needed. Exact metadata CAS, complete preauthorization, scope on reread and preserved partial results are sound in inspected source. Simultaneous cross-table grant revocation remains the documented limitation.

Independently inspected `output/playwright/prp472-correction1-alias-held.png` and `prp472-correction1-mobile.png`. Alias-held visibly includes four intended bodies; the 390px screenshot includes two email bodies and native SMS with header/composer/navigation fitting. Payload, POST release and temporary alias cleanup are Sol's recorded browser evidence, not independently replayed by this reviewer. Forced500/reopen, Read/Unread no-jump and hidden-document0POST -> visible1POST200 are also attributed to Sol's final-source handoff. Native arrival during a held request was not separately driven with a new DEV native row.

The retained five regression files contain 37 reported passing tests. Pane tests pass a mock `onViewed`; controller tests invoke the controller separately. They do not mount `ManagerUnifiedInbox` with its actual pane and controller, and do not substantiate the handoff's claimed actual-wiring epoch/hidden-mobile/explicit-resolution coverage. Root has no independent private harness provenance for that claim. Correction 2 must retain those integration regressions in the repo and correct the evidence wording.

Root's post-freeze full unit completed with exit **0**, **1,458 files / 10,295 tests**, 192.33 seconds; log `/private/tmp/axis-inbox-cycle/prp472-c1-full-unit.log`. Root used Node 22 to run `node_modules/vitest/vitest.mjs run tests/unit` with output redirected to that log and captured the real exit status. This is the correction-1 baseline only, not proof that the missing cases pass. Final broad lint is not supplied at this checkpoint; build is deferred because the confirmed blockers require correction 2. Earlier full unit 1,456 files/10,273 tests and correction focused/compatibility/typecheck/lint passes do not waive these findings. No commit, push, acceptance, Linear completion, staging or release is approved by this review.
