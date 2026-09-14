# PRP-472 correction cycle 2 handoff - September 13, 2026

## Scope and authority

- Keeper: `akhil/prp-472-inbox-unread`; integration HEAD: `3c997bc4f09ef3b97c80cb559e8909830e164868`.
- This final automated correction implements C1-C4 from `2026-09-13-prp-472-correction-1-review.md` without changing the RPC migration, its hash contract, grants, or DEV apply history.
- No commit, push, Linear write, PR, protected-branch action, provider send, schema apply, staging action, or production action was performed.
- Terra implemented the bounded client/source changes and Luna implemented the retained tests. Sol independently inspected and repaired the real wiring suite, integrated the route writer boundary, ran focused validation, and drove the browser matrix.

## C1-C4 resolution map

### C1: confirmed source truth and operation-owned optimistic state

`readSources` now carries confirmed unread truth separately from an optional client-only optimistic token. Reconciliation updates exact source truth even when the aggregate boolean does not change, recomputes aggregate unread from compatible current observations, and lets only the owning operation settle its overlay. Missing, malformed, duplicate, extra, revised, incomplete, or conflicting observations remain fail closed. Partial success survives later success/failure sequences, and old A operations cannot act in B or a later A epoch.

The controller uses confirmed source truth for rollback and preserves known results per source. Network-unknown results retain prior truth and produce one recoverable notification for the visible attempt. It continues native handling while an email operation is pending and releases only its own pending token.

### C2: bounded visible attempt and native storage recovery

The shared attempt outcome is now `deferred` only for hidden/stale authority and `attempted` for a visible completed attempt, including native storage failure. The pane consumes a visible failure until explicit close/reopen. Manager SMS opened state uses a viewer-scoped v2 key, preserves in-memory receipts when `getItem` fails, publishes Set state only when membership changes, and retries a durable write after storage recovers. Hidden documents and closed mobile panes perform no receipt or POST.

### C3: explicit native provenance through all collapse passes

Authorized GET rows contribute response-only `smsBindingKeys`. Person, assistant, and unified collapse preserve explicit binding presence and conflict, including successive/legacy passes. A selected row with any explicit binding resolves only exact native aliases; an unrelated same-email native K3 cannot enter the pane or local acknowledgement set. Unbound fallback remains limited to one unambiguous exact-email native conversation.

The client whole-row writers and the server `normalizeInboxRow` writer boundary strip `readSources`, `readSourcesComplete`, and `smsBindingKeys`. These fields never enter durable payloads. The SQL observation hash remains unchanged.

### C4: actual permission composition

Route tests now use the real scope filter composition with a fake that applies `.in`, `.eq`, `.or`, and reread filters. Effective admin-to-manager context is tested through the real `resolveInboxScopeUser` with only auth/effective-context boundaries mocked. Co-manager tests use the real grant normalization/module helper. Authorized effective-manager targets work; bare admin, unrelated owners, empty grants, read-only grants, and mixed batches fail before writes. False CAS reread, same-timestamp changes, retry bounds, reread errors, RPC errors, and partial commits are retained.

## Final state and metadata contract

- Durable source identity is the row id plus its unchanged server observation. GET adds complete, authorized response metadata after reading durable rows.
- `readSources[].unread` is confirmed truth. `readSources[].optimistic` is client-only, token-owned state. It cannot become another operation's rollback baseline.
- `readSourcesComplete: true` means every folded email member supplied one compatible observation. Any loss or conflict clears completeness and disables acknowledgement.
- `smsBindingKeys` is the union of explicit native bindings declared by the selected authorized email sources. Presence disables same-email fallback; conflicts remain conservative rather than inventing identity.
- A visible attempt is latched even if storage or transport fails. Close/reopen is the retry boundary. Hidden/stale work remains deferred and eligible when authority becomes current and visible.

## Source and retained tests

Correction source is in:

- `src/app/api/portal-inbox-threads/route.ts`
- `src/components/portal/pro-resident-detail-inbox.tsx`
- `src/components/portal/pro-sms-panel.tsx`
- `src/components/portal/pro-unified-inbox.tsx`
- `src/lib/manager-sms-opened.client.ts`
- `src/lib/portal-inbox-read-operation.client.ts`
- `src/lib/portal-inbox-storage.ts`
- `src/lib/unified-inbox-merge.ts`

The retained full wiring file is `tests/unit/manager-unified-inbox-read-integration.test.tsx`. It mounts the actual `ManagerUnifiedInbox`, actual `ResidentDirectChatPane`, real operation controller, real reconciliation/collapse, and actual selected-source resolver. Unrelated composer/schedule/network/session boundaries are stubbed. Its nine passing cases are:

1. `collapses raw A/K1+B/K2 and renders only the explicitly bound native members`
2. `bounds persistent native storage failure, releases the held email attempt, and recovers on explicit reopen`
3. `keeps confirmed reads after a successful open when a close/reopen POST returns null`
4. `preserves initialized native receipts through a visible getItem exception without retry looping`
5. `opens a native arrival while the email request is pending and keeps one request on success settlement`
6. `opens a native arrival while the email request is pending and keeps one request on failure settlement`
7. `defers a hidden manager pane until visible and acknowledges exactly once`
8. `keeps the hidden mobile thread pane from acknowledging until the user opens it`
9. `ignores a stale A settlement after A-B-A viewer authority changes`

Sol rejected the first draft as insufficiently wired. The initial combined focused execution then exposed two real test-isolation failures: the manager list assertion accepted its loading skeleton, and the hidden test hid the document before initial source readiness. After waiting for the actual email body and moving the visibility transition after source load, the retained suite passed 9/9. No pre-fix claim is made for this suite; the prior concrete defects are established by the root review probes and the suite now guards the final wiring.

Additional retained files are:

- `tests/unit/portal-inbox-read-observation.test.ts`
- `tests/unit/portal-inbox-read-operation.test.ts`, including confirmed-success rollback, partial-success preservation, overlapping/out-of-order ownership, A-B-A, and storage failure.
- `tests/unit/portal-inbox-read-storage-contract.test.ts`, including same-aggregate source updates, malformed/unknown results, old/new observations, successive collapse, and native binding conflicts.
- `tests/unit/pro-resident-detail-read-behavior.test.tsx`
- `tests/unit/portal-inbox-read-route-contract.test.ts`
- `tests/unit/portal-inbox-scope-effective-viewer.test.ts`
- `tests/unit/portal-inbox-co-manager-grants.test.ts`

## Focused validation

All Node commands used `/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node` or the repository runner under Node 22.

- Actual manager + pane wiring: exit 0, 1 file, 9 tests, 2.34s.
- Full correction focus: exit 0, 8 files, 62 tests, 2.45s.
- Compatibility focus: exit 0, 18 files, 130 tests, 7.73s. This retained PRP-470 initial readiness, viewer generation, SMS polling/coalescing, source readiness, manager application readiness/merge, resident stages, archive/status, row actions, notice concurrency, and resident/unified conversation coverage.
- Affected ESLint over 17 source/test files: exit 0, 0 errors, 37 warnings from existing hook/unused-parameter patterns.
- TypeScript with `NODE_OPTIONS=--max-old-space-size=6144`: final exit 0. Two preceding focused typecheck runs exposed and then fixed an `optimistic` narrowing error in `portal-inbox-storage.ts`.
- `git diff --check`: exit 0.
- Root independently ran `npm run ship:preflight`: exit 0, PASS 11 with 4 expected warnings; log `/private/tmp/axis-inbox-cycle/prp472-c2-preflight.log`. The shell lacked a production env check, migration parity was not checked, Langfuse was skipped, and the keeper was dirty. Root independently reasserted that the production-build env host resolves to exact DEV/test.
- `npx graphify hook-rebuild`: exit 1 with `npm error could not determine executable to run`. No global graph tooling repair or migration was attempted.

Root owns the one serial post-freeze full unit, lint, and build run. This correction did not duplicate those broad gates.

## Final-source browser and DEV evidence

The server was pinned to port 3009 and launched against verified DEV project `emstjswhotsnyksqhqyf` with exactly:

```text
SMS_COMM_UI_ENABLED=true
SMS_RUNTIME_ENABLED=0
SMS_OUTBOX_SCHEDULER_READY=0
SMS_PROVISIONING_ENABLED=0
```

No provider call or send occurred. Review URL:

`http://localhost:3009/portal/communication/active/c02c7ffd-50ec-47d0-acf2-82928be6db27%3Aresident%3Af4290f7c-31c7-469e-b0bb-859f5ce37f46`

Real Chromium evidence:

- Desktop 1440 and mobile 390x844 exact-route loads rendered both canonical email bodies and the exact native SMS. Final-source screenshots were visually inspected: `output/playwright/prp472-correction2-desktop.png` and `output/playwright/prp472-correction2-mobile-390.png`. The screenshots show `PRP-472 email probe1` twice because the reconstructed synthetic durable fixture deliberately has root `body: "PRP-472 email probe1"` and its first `messages[]` entry repeats that same body before `PRP-472 email probe2`; a final read-only DEV query confirmed this exact stored shape. This duplication is fixture-data attribution, not a rendering regression introduced by C1-C4.
- Successful real read, close, and reopen before any GET: the first POST read exact source `prp472-dev-merged-read` and removed its unread indicator. After the pane-close effect completed, the next exact-source POST was forced to HTTP 500. Captured GET count between close/reopen was zero, the pane still rendered `PRP-472 email probe2`, and unread indicators remained zero.
- Forced first-read HTTP 500 then explicit reopen: initial GET carried unread true and observation `4811dab0289e824e6448f7c1242633fec6065fadb499f0cf1dcc76580e3224b0`; failure restored one unread indicator. Reopen sent the same observed source, received `{status: read, unread: false}`, and cleared it with zero intervening GETs.
- Persistent native storage denial targeted only `axis_manager_sms_opened_v2:c02c7ffd-50ec-47d0-acf2-82928be6db27`. First visible open made one failed write and one toast, with no render loop. One explicit reopen made one further attempt while the same toast remained bounded. After restoring storage, the next explicit reopen persisted native id `23cd9472-4720-4472-8472-000000000001`. The preexisting opened payload was restored after the probe.
- With a 390px closed thread and `document.visibilityState` held hidden, the list issued zero POSTs before selection and zero after hidden selection. One visible transition issued exactly one mark-read POST and cleared the indicator.
- Bounded alias `prp472-c2-binding-alias` shared the canonical exact native binding. Authenticated GET collapsed it with the canonical row into exact source ids `[prp472-c2-binding-alias, prp472-dev-merged-read]` and one `smsBindingKeys` value. The actual pane rendered canonical email, alias email, and the bound native SMS, and the actual POST contained exactly both email source ids. Exact cleanup deleted one alias row and verified remaining count zero.

The canonical row was unexpectedly absent from shared DEV before QA and was insert-only reconstructed under the user-authorized fixture exception after verifying manager auth id/email. It was observed absent again before the final matrix and reconstructed insert-only again; neither reconstruction overwrote a concurrent row. The exact durable payload contains `PRP-472 email probe1/2`, resident email, inbox/unread state, and the owner-resident native binding, with all response-only metadata stripped. Instrumentation after the final reconstruction captured only `markRead` POSTs; page load/open/close did not reproduce a delete. The external/shared-DEV cause of the earlier disappearance remains unknown.

Final DEV read: canonical row count 1, owner `c02c7ffd-50ec-47d0-acf2-82928be6db27`, unread false after QA, bodies/binding preserved, response metadata absent; temporary alias count 0; native fixture count 1. No unrelated rows, accounts, roles, drafts, attachments, or native messages were changed.

## Limits

- Novel no-binding, one-binding, both-binding, conflict, legacy, K1/K2/K3, overlapping result, and old-viewer permutations are retained as actual React integration/helper tests rather than synthetic shared-DEV rows.
- The unexplained earlier deletion of the synthetic canonical fixture was not reproducible after request instrumentation and is not attributed to the corrected read path.
- No release/full E2E promotion was authorized.

## SOURCE FREEZE

**SOURCE FREEZE: correction cycle 2 source, tests, documentation, and browser evidence are frozen at this handoff. Port 3009 is stopped. Root may begin the one serial full unit, lint, and build gates, then the final fresh Astra/security/Bugbot review.**
