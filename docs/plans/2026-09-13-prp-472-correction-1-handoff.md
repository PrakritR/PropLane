# PRP-472 correction cycle 1 handoff - 2026-09-13

## Scope and state

- Keeper: `akhil/prp-472-inbox-unread`
- Integration HEAD: `3c997bc4f09ef3b97c80cb559e8909830e164868`
- This cycle implements all five findings in `2026-09-13-prp-472-review.md`.
- No commit, push, Linear write, protected-branch action, provider send, schema apply, staging action, or production action was performed.
- The existing migration was not edited. SHA-256 remains `8a6007c229d637f3eb4d6091650ddb8c546a7f5dee353abcb157e4bd99f5bad6`.
- The exact DEV RPC apply and independent database validation remain recorded in `2026-09-13-prp-472-rpc-validation.md` and `2026-09-13-prp-472-root-validation.md`.

## Correction map

### R1: stale or incomplete acknowledgement

- GET snapshots now expose source-level `unread` observations and an explicit `readSourcesComplete: true` marker.
- Collapse code unions observations only when coverage remains complete and conflict-free. Missing, legacy, revised, or conflicting members fail closed.
- Read reconciliation requires exact current observation coverage and a valid result for every represented source. An old A response cannot clear a newer or revised B source.

### R2: exact alias-source rendering and acknowledgement

- The combined pane receives one selected, authorized, non-trash email snapshot. The same snapshot supplies rendered bodies, root/appended attachments, and acknowledgement candidates.
- All email aliases explicitly bound to the selected native SMS key render, while the winning row still supplies reply/contact context.
- Exact selected native keys take precedence. An unresolved explicit key never falls back to email or phone, and fallback requires one unambiguous email match.

### R3: pending ownership and native receipts

- `startObservedInboxReadOperation` separates synchronous local native receipts from email network deduplication.
- Pending email operations are owned by viewer, epoch, signature, and token. Cleanup can remove only its own token, and every callback/toast checks current ownership.
- A new SMS can be opened locally while email acknowledgement is pending. A later A view can retry after A to B to A without an earlier A callback affecting it.
- Hidden panes and hidden documents do not acknowledge. One visibility/open transition produces one bounded attempt.

### R4: failure and partial-batch recovery

- Optimistic reconciliation retains each source's prior unread truth and restores only metadata owned by the failed operation.
- The route continues after a per-source RPC failure and returns explicit per-source results, preserving earlier commits in a partial batch.
- Response validation requires the exact requested ids, exact result count, valid status values, and booleans. Missing, duplicated, extra, or malformed results are failures rather than implicit read results.
- localStorage failures do not block the email POST, release pending ownership, and leave reopen/retry available. Only the current viewer sees the recoverable error.

### R5: true multirow collapse

- Person, assistant, and unified collapse paths union observations and propagate incomplete/conflicting coverage through successive passes.
- Assistant root body and attachment selection now remain aligned with the actual root row, including a root with no attachments.

## Source and tests

Correction source files:

- `src/app/api/portal-inbox-threads/route.ts`
- `src/components/portal/pro-resident-detail-inbox.tsx`
- `src/components/portal/pro-sms-panel.tsx`
- `src/components/portal/pro-unified-inbox.tsx`
- `src/lib/manager-sms-opened.client.ts`
- `src/lib/portal-inbox-read-operation.client.ts`
- `src/lib/portal-inbox-read-state.server.ts`
- `src/lib/portal-inbox-storage.ts`
- `src/lib/unified-inbox-merge.ts`

Behavioral regression files:

- `tests/unit/portal-inbox-read-observation.test.ts`
- `tests/unit/portal-inbox-read-operation.test.ts`
- `tests/unit/portal-inbox-read-route-contract.test.ts`
- `tests/unit/portal-inbox-read-storage-contract.test.ts`
- `tests/unit/pro-resident-detail-read-behavior.test.tsx`

The tests exercise the actual wired combined pane and callback with deferred requests. They cover stale A versus new/revised B, legacy and conflicting coverage, two aliases plus exact native sources, multiple native arrivals during pending email success/failure, A to B to A, hidden document/mobile states, reopen, localStorage exceptions, malformed responses, partial route batches, meaningful co-manager/admin scope, and successive multirow assistant collapses.

## Validation

All commands used Node `v22.23.0`.

- Final correction regression suite: exit 0, 5 files, 37 tests.
- Affected compatibility suite: exit 0, 18 files, 119 tests. This included PRP-470 initial-readiness, viewer/SMS polling and coalescing, Status/archive, inbox scope, row actions, notices, and resident conversation coverage.
- Additional integration suite: exit 0, 8 files, 60 tests. This included source readiness, manager applications cold-cache/merge, resident stages, composer/reply parity, and coalesced refresh coverage.
- TypeScript: `NODE_OPTIONS=--max-old-space-size=6144 ... tsc --noEmit --pretty false`, exit 0.
- Affected ESLint: exit 0 with 0 errors and 34 existing-pattern warnings.
- `git diff --check`: exit 0.
- `npx graphify hook-rebuild`: exit 1 with `npm error could not determine executable to run`. No graph artifacts were produced, and global tooling was not changed.

The pre-correction full unit run is retained at `/private/tmp/axis-inbox-cycle/prp472-full-unit.log`: exit 0, 1,456 files, 10,273 tests. Root owns the single serial post-freeze full unit, lint, and build run.

## Final-source browser and DEV evidence

Server launch, after `npm run sandbox:pin -- 3009`, used exactly:

```text
SMS_COMM_UI_ENABLED=true
SMS_RUNTIME_ENABLED=0
SMS_OUTBOX_SCHEDULER_READY=0
SMS_PROVISIONING_ENABLED=0
```

The server ran on port 3009 against the verified DEV project `emstjswhotsnyksqhqyf`. The old `PROPLANE_MANAGED_SMS_*` names were not used. No provider call or send occurred.

Review URL:

`http://localhost:3009/portal/communication/active/c02c7ffd-50ec-47d0-acf2-82928be6db27%3Aresident%3Af4290f7c-31c7-469e-b0bb-859f5ce37f46`

Evidence from the final source:

- Desktop and 390 by 844 mobile panes rendered the two canonical email messages and exact native SMS. Screenshots: `output/playwright/prp472-correction1-desktop.png` and `output/playwright/prp472-correction1-mobile.png`.
- A bounded DEV alias row, `prp472-correction1-browser-alias`, used a distinct email address and the canonical fixture's exact native key. With the read request held, the pane visibly rendered `PRP-472 EMAIL ALIAS BODY`, both canonical email bodies, and the native SMS. The held payload contained exactly the canonical and alias email source observations. Screenshot: `output/playwright/prp472-correction1-alias-held.png`.
- Releasing that one held request returned POST 200. The alias probe row was then deleted exactly, its absence verified, and the canonical fixture was verified at `unread=false`.
- A forced exact read POST 500 kept the canonical row's `2 unread` badge and displayed the recoverable error. Removing the mock and reopening issued a fresh POST 200 and cleared the badge.
- Status Read included the acknowledged row. Status Unread excluded it without selecting another row or looping.
- With the canonical fixture reset unread and `document.visibilityState` held at `hidden`, the deep-link load issued no read POST through request 296. One visibility transition to `visible` issued exactly one read POST, request 298, which returned 200.

The visible native-arrival-during-held-email case is verified by the actual wired controller/pane behavioral tests with deferred network requests. It was not separately driven by inserting another native DEV row in the browser. The real browser did verify the existing exact native member alongside two distinct email alias sources while their email request remained held.

## SOURCE FREEZE

**SOURCE FREEZE: correction cycle 1 source and focused-test changes are frozen at this handoff. Root may begin the single serial full unit, lint, and build gates and fresh Astra/security/Bugbot review.**
