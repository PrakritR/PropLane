# PRP-472 final fresh Astra review - September 13, 2026

**Result: CHANGES REQUIRED. Two Medium / P2 findings remain.** The original success-then-failed-reopen case is fixed, but overlapping acknowledgements can still restore obsolete unread state. The changed standalone SMS panel also cannot persist a failed receipt on a later open while its instance remains mounted. Security review passes its assigned boundary. PRP-472 is not accepted as complete; retain the uncommitted keeper and report these findings to Akhil. This is the second and final allowed automatic correction review. Do not start a third cycle automatically.

## Independent review boundary

Reviewed `akhil/prp-472-inbox-unread` in `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2`, integration base/HEAD `3c997bc4f09ef3b97c80cb559e8909830e164868`, plus its uncommitted PRP-472 feature/correction source, tests and additive SQL. The checkpoint has reviewed PRP-470 parent `8cfe3491372515bb2acd96a346ce688047a83ca6` and pinned-main parent `203d5e58f3ad99e6a977d65b1bbdb69115c52711`. Inspected the relevant merge resolutions again with `--remerge-diff`; the initial review remains the wider integration record. No later main tip was incorporated or re-audited.

Root's freeze manifest `/private/tmp/axis-inbox-cycle/prp472-c2-source-freeze.json` contains 18 source/test/SQL files, aggregate `45f0449be351e47abb675cb3e9b38283a015c4f94259290ad0cb00758ba8347c`. Independently recomputed all 18 hashes with zero mismatches. Documentation reports are outside this source freeze.

Read repository/Akhil instructions, the canonical checkout's feature-cycle document, original plan/safety/upstream addenda, integration/initial/correction handoffs, both earlier Astra reviews, correction-2 plan, root/RPC validation, Communication/UI/parity instructions and local Next Route Handlers guide. Current user invariants override dated repository exceptions: no resident scheduled compose, no empty-permission grants and no skipping staging. No release is authorized.

Required independent reports: [security review](../security/2026-09-13-prp-472-final-security-review.md) and [Bugbot](../security/2026-09-13-prp-472-final-bugbot.md). Security owned authorization, RPC/CAS and durable metadata; Bugbot independently checked client failure/race contracts. This reviewer owned integration, actual manager/pane wiring, evidence, rendering/performance/native and final synthesis. No source/test edits, Git mutations, database operations, provider sends, server/browser actions, Linear changes or no-mistakes were performed by the review team. Private deterministic probes and review reports are the only writes.

## F1 - Medium / P2: an older unknown outcome overwrites a newer confirmed read

Locations: `src/lib/portal-inbox-storage.ts:1056-1059`, `src/lib/portal-inbox-read-operation.client.ts:86,91-104`; actual manager reconciliation caller at `src/components/portal/pro-unified-inbox.tsx:1044-1047`.

The settled reconciliation branch always assigns the operation's `unread` value to confirmed source truth. Token ownership only controls removal of the optimistic overlay. On a network rejection or malformed/unknown result, the controller supplies its captured prior truth through that same settled branch. A later operation may already have confirmed the source read, so this fallback is obsolete.

Concrete reachable sequence uses two different authorized email aliases with the same explicit native binding. They remain separate rows in person collapse, then form one unified conversation:

1. Current sources are A/A1 and B/B1, both unread. Start an acknowledgement for both and hold its network outcome.
2. A normal source refresh returns unchanged A/A1 and revised B/B2 before the older request has committed A. Both remain unread. The changed viewed signature starts a second request for A/A1+B/B2.
3. The newer request succeeds. Actual reconciliation records both aggregate and source unread as false.
4. The older request's network outcome fails. A's unchanged observation and its separate alias group still pass completeness. The older `priorUnread=true` overwrites A's confirmed false; B/B2 correctly rejects the old B/B1 result.

Observed with the actual controller and actual reconciliation function, independently reproduced by this reviewer:

```text
after newer success: A aggregate=false/source=false; B aggregate=false/source=false
after older failure: A aggregate=true/source=true; B aggregate=false/source=false
pending operations=0
```

The badge returns and Read/Unread filtering becomes wrong even though A was confirmed read. This is not an RPC concurrency defect or a stale-viewer effect. Both requests belong to the same valid viewer epoch, and database content/attachments/folders remain preserved.

Correction guidance for Akhil: distinguish a confirmed server result from an unknown operation outcome. Unknown rollback should withdraw only the compatible overlay owned by that operation and retain current confirmed source truth. Do not overwrite current truth with a captured fallback after another operation advanced it. Preserve real partial server outcomes and exact observation checks. Add a retained test using the real controller and reconciliation together for the alias sequence above and both settlement orders, asserting source truth as well as the badge. The current test named for out-of-order operations mocks `applyUnread` and runs the second identical request after the first settles, so it cannot detect this overlap.

## F2 - Medium / P2: a mounted SMS panel suppresses the promised storage retry

Locations: `src/components/portal/pro-sms-panel.tsx:425-440`, `src/lib/manager-sms-opened.client.ts:53-69`. Reachable callbacks are the panel's row open at lines 442-449/909 and controlled selection synchronization at lines 453-474.

On a failed storage read/write, `markOpened` now adds the inbound IDs to `openedSmsIdsRef` as volatile receipts and tells the user to reopen to retry. On the next explicit open while the panel stays mounted, line 428 sees all IDs in that same ref and returns before calling the shared helper. The helper's careful distinction between in-memory and durable membership is never reached.

Actual callback/helper probe:

```text
first setItem fails; storage recovers; same mounted panel opens that thread again
total writes=1; toasts=1; stored=[]; in-memory=[sms1]
```

This occurs in the retained standalone panel, such as the SMS-enabled admin Communication section (`admin-communication.tsx:125`) with its own list/back actions, and when switching pure-SMS selections A -> B -> A in the unified pane while the same `ManagerSmsPanel` instance remains mounted. The failed ID stays absent from durable storage and becomes unread again after a later reload. Full unified Back/unmount/reopen can reset panel state and recover; the finding does not claim that remount path fails. The new combined `ResidentDirectChatPane` retry path is also fixed and is not the affected branch.

Correction guidance for Akhil: make the caller distinguish volatile membership from successful persistence, or let the shared helper perform durable membership deduplication on each bounded explicit open. Avoid reintroducing render-driven retries. Retain an actual panel test for setItem failure -> storage recovery -> mounted A/B/A or list/back/reopen, proving the expected write and reload-stable receipt.

## C1-C4 and original R1-R5 acceptance

| Contract | Final assessment |
| --- | --- |
| C1 confirmed truth, repeat/partial/overlapping operations | Sequential success -> failed reopen is fixed and browser-tested; per-source updates now occur even when aggregate state is unchanged. The overlap requirement remains open as F1. |
| C2 bounded native failures and viewer/visibility authority | Combined pane now latches attempted failures, skips equal Set publication, preserves memory on storage reads, continues email and handles native work before email deduplication. Actual combined-pane/browser storage recovery is supported. F2 remains in the changed standalone panel integration. |
| C3 explicit native provenance and selected rendered sources | `smsBindingKeys` survives person/assistant/unified passes; declared bindings disable email fallback. The selected snapshot renders the email sources that contribute observations. Actual manager/pane test includes K1/K2 and excludes K3; real alias browser evidence posts exactly both rendered email IDs. No additional concrete binding defect found. |
| C4 effective-admin/co-manager and CAS tests | Corrected. Real scope predicates and filter-aware fake enforce target ownership and complete-batch preflight. Separate real resolver and grant-normalization tests cover effective admin and empty/read/edit semantics. Security review passes with documented boundaries. |
| R1 newer/unobserved/revised source protection | Exact observations and completeness retain the original protection. F1 concerns unchanged A across overlapping sets, not old B clearing revised B. |
| R2 rendered aliases equal acknowledged sources | Original losing-alias defect fixed through `emailThreadSnapshot`; root/appended attachment projection remains intact. |
| R3 native arrivals during pending email / A-B-A | Native handling precedes email pending checks; pending keys include epoch and viewer and cleanup owns its token. Current authority guards reject stale callbacks/results/toasts. |
| R4 failure semantics / partial commits | Server partial outcomes survive later RPC or reread failure; malformed transport outcomes fail closed. Original first-open prior-false and combined storage exception handling are fixed; F1 remains the overlapping unknown-outcome extension. |
| R5 true assistant collapse | Observations/completeness and explicit binding sets propagate through actual multirow assistant and successive collapse. Oldest body/root attachments remain associated. |

## Validation and evidence limits

Root's [final-source validation](2026-09-13-prp-472-root-validation.md) records full unit exit **0**, **1,461 files / 10,320 tests**, **269.94s**; full lint exit **0**, **0 errors / 746 warnings**; and build exit **0**, including compilation, TypeScript and 394 generated static pages. Independently inspected the corresponding log summaries in `/private/tmp/axis-inbox-cycle/prp472-c2-{full-unit,full-lint,build}.log`. The process exit codes are root's retained results, not inferred from log text. No broad suite was duplicated. Sol's focused 62 tests, compatibility 130 tests, 9-case manager integration, affected lint and 6GB typecheck are attributed to its handoff.

The retained manager integration suite really mounts `ManagerUnifiedInbox` with the real `ResidentDirectChatPane`, resolver, controller and reconciliation. Session, network/cache publication, list/timeline primitives and unrelated composer/schedule controls are stubbed. It is meaningful React wiring coverage, not a browser or full storage-lifecycle test. The native-arrival cases assert rendered body and bounded POSTs, but do not themselves assert the new arrival's durable opened ID. The A-B-A case asserts body fields and toast stability, not a complete stale unread/receipt/selection matrix. The first binding case covers both K1/K2 resolved; the stated both-unresolved/one-resolved/mixed-legacy matrix is not a full retained actual-manager parameterized matrix. Separate helper/pane tests cover parts of that space. These limitations are not additional speculative source findings and do not substitute for F1/F2 regressions.

Bugbot's retained private harness, independently rerun here with exit **0**, executes AST-extracted actual frozen controller/reconciliation and panel callback/shared helper with deterministic dependencies:

```text
/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node /private/tmp/axis-inbox-cycle/prp472-c2-final-review-probes.cjs
```

It asserts the two observed defects; exit 0 means successful reproduction, not product acceptance. It makes no network/DB calls and is not React/browser evidence. Root independently replayed the same harness with exit 0 and identical outcomes, retained in root validation. The input/output sequences above keep the findings reviewable without the private file.

Independently viewed final desktop and 390px screenshots: `output/playwright/prp472-correction2-desktop.png` and `prp472-correction2-mobile-390.png`. Canonical email and exact native SMS are visible, selected desktop badge is cleared, and phone header/timeline/composer/navigation fit. The repeated probe1 body is the independently documented synthetic fixture shape, not a newly inferred UI duplication. The handoff's real successful-read -> failed-reopen/zero-GET, first500 -> explicit200, bounded exact storage-key failure/recovery, hidden/mobile zeroPOST -> visible onePOST and exact two-alias POST/cleanup evidence is attributed to Sol/root; this reviewer did not replay their browser session. Earlier missing synthetic fixture cause remains unknown and was not reproduced during instrumented open/close QA.

## Integration, security, performance and native

No additional integration defect found in the preserved PRP-470 readiness/application gate, viewer generation, success-only inbox/application TTL, failed-refresh invalidation, shared SMS in-flight coalescing or upstream Status/actions/composer behavior. Local read-state updates still stage cache without forcing GETs; SMS opened notifications remain local. The combined-pane storage render/toast loop is corrected. F1 is state reconciliation and F2 is durable receipt recovery, not increased egress or an unbounded fetch loop.

The unchanged service-only invoker RPC SHA-256 remains `8a6007c229d637f3eb4d6091650ddb8c546a7f5dee353abcb157e4bd99f5bad6`. Root's [DEV RPC evidence](2026-09-13-prp-472-rpc-validation.md) verifies real anon/authenticated denial, 65KB history transport, same-timestamp CAS/content preservation, both concurrency orderings and exact cleanup. No SQL reapply is required for either finding. Batch-time cross-table grant revocation remains the documented limitation; security PASS does not waive client acceptance.

No route topology, nav registry, native plugin, push or upload flow was added. Shared web/Capacitor UI and existing analytics attributes remain intact. Phone Chromium screenshots do not establish physical iOS device behavior. No staging/production mutation or release occurred; full E2E and staging QA remain requirements before any future authorized promotion.

The pool has no usable graph artifact. The recorded `npx graphify hook-rebuild` exit 1 (`could not determine executable to run`) is a tooling limitation, not a successful refresh; no global repair was attempted. Root owns final Git/Linear state and the port-3009 Review URL. Retain these two actionable findings for Akhil without another automatic correction cycle.
