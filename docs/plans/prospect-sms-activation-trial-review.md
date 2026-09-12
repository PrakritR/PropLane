# Prospect SMS activation trial: independent Astra review

Date: 2026-09-12

Reviewed HEAD `b251d49f73c76f56804e14de956aea8ac66f7d5f` plus the eight uncommitted code/test files listed in the execution handoff. Scope: scorer correction, shadow expiry, new snapshot read-only isolation, raw QStash destination, SHA-256 deduplication. Unrelated upstream migration drift is excluded.

## Verdict

**Changes requested.** One P1 correctness finding remains in the scorer. This is an evaluation integrity blocker for the requested trial, not evidence that GPT can send SMS or execute writes. No additional blocking finding was identified in the expiry, new snapshot filtering, or QStash publisher changes.

## AT-1: P1 - Semantic punctuation disappears before grounding

Location: `src/lib/agent/prospect-shadow-comparison.ts:162` (`assertionTokens`).

The new matcher still erases punctuation that changes factual meaning. A negative amount or inequality becomes indistinguishable from the exact positive amount. Full token coverage therefore does not prove the complete assertion.

A local, no-network `npx tsx -e` reproduction imported the real `projectProspectShadowPrimaryEvidence` and `compareProspectShadow`. Evidence was a successful `get_listing_details` for property `p1`, title `Jain Home`, rent label `$1,200`, address `12 Cedar Street`, availability `Now`.

| Shadow output | Actual result | Required result |
| --- | --- | --- |
| `Jain Home rent is $1,200.` | grounded | grounded |
| `Jain Home rent is -$1,200.` | grounded | unknown or soundly ungrounded |
| `Jain Home rent is >$1,200.` | grounded | unknown or soundly ungrounded |

Reproduction exit code: 0. These are unsupported numeric assertions being promoted to affirmative grounding by the same comparison path used by runtime snapshots.

Correction plan:

1. Preserve semantic punctuation/operators in the representation used for proof, or conservatively reject unsupported syntax before awarding `grounded`. Do not solve only the two literal examples with narrow substitutions.
2. Preserve harmless sentence-ending punctuation without discarding signs, inequalities, or other amount modifiers. Cover ASCII minus and Unicode minus, `<`, `>`, `<=`, `>=`, and equivalent Unicode operators.
3. Add actual-projection regressions for those adversarial assertions and retain the exact-positive, swapped-field, substring, negation, and cross-property tests.
4. Re-run the focused comparison/provider/runtime/recovery/publisher suites and have a fresh review of the corrected scorer before activation.

## Reviewed behavior and practical limits

- The strict UTC deadline parser rejects invalid calendar values and disables runs at the exact configured boundary. Shared gating covers direct entry, scheduling, recovery entry, and new snapshot creation; continuation calls recheck enablement. Already-started provider calls may complete after expiry within their existing request timeout. The feature is a cutoff for new calls, not cancellation of an in-flight request.
- New runtime snapshots expose only schemas selected with `readOnly: true` and tool evidence matching those schema names. The runner uses frozen conversation plus recorded evidence and does not import a registry, database, or sender. Existing persisted snapshots are not retroactively filtered by this patch; root should account for preexisting snapshot provenance when activating a previously disabled deployment.
- Raw callback interpolation retains the required destination scheme. SHA-256 over the structured burst/revision/attempt tuple gives stable duplicate-ingress identifiers and fresh recovery identifiers without colons. The code review and mocked requests do not independently establish real callback signature acceptance.
- Recovery-id coverage currently compares different burst/revision rows. An additional test that republishes the same row twice would directly guard fresh-attempt semantics, but the implementation's `randomUUID()` already provides that distinction. This is nonblocking.

## Independent validation

Command:

```sh
npx vitest run tests/unit/agent/prospect-shadow-comparison.test.ts tests/unit/agent/openai-shadow-provider.test.ts tests/unit/agent/prospect-sms-runtime-boundary.test.ts tests/unit/prospect-sms-ingress-retry.test.ts tests/unit/prospect-sms-shadow-recovery.test.ts
```

Exit 0: 5 files, 41 tests passed. Existing tests do not detect AT-1.

`git diff --check`: exit 0.

Graph-first lookup was attempted with `graphify query`; the installed CLI reported missing `graphify-out/graph.json`. Review therefore used the explicit plan/handoff and scoped source diff. No graph artifacts or implementation files were changed.

Root owns broad unit/build gates and external integration evidence. At review time root reported real QStash publication HTTP 201 with duplicate deduplication, but callback HTTP 401 `Invalid queue signature` remained under investigation; the local OpenAI key returned HTTP 429 `credit_balance_exhausted`. Those reports are operational blockers, not successful activation evidence. No live SMS, database mutation, secret read, network model request, commit, or push was performed by this review.
