# Prospect SMS final bugbot review

2026-09-12. Fresh Astra review after correction cycle 2 for Akhil. Branch `prospect-agent-eval-loop`; HEAD `6f24d93b712f140d16af5f10e14b1fd88edd61aa`. Review covers the plan-scoped uncommitted implementation, excluding the pre-existing workflow/Linear/evaluation changes documented in the original handoff. The governing transport scope is `docs/plans/prospect-sms-retired-transport-amendment.md`: active manager-owned Twilio only; Claw remains retired.

**Verdict: one remaining P2 comparison correctness finding.** No new P1 transport defect was established. This is the final permitted automated correction review; no correction cycle 3 is initiated. Broad validation and final browser evidence must be reported separately and cannot close the reproduced scoring defect.

## FINAL-1 / P2: property-bound evidence still falsely grounds swapped field values

Location: `src/lib/agent/prospect-shadow-comparison.ts:175`, especially the word-membership success at line 187. Runtime producer: `src/lib/agent/leasing-sms-agent.server.ts:529`.

The new projection correctly groups facts by canonical property, but `grounding()` flattens each group into words and numbers. Mentioning the title satisfies its supported-fact check; a claimed value need only occur somewhere in that property's evidence, without preserving the field to which the value belongs. Thus address numbers can substantiate a rent claim, and rent can substantiate an address claim. This is a false positive, not merely a conservative unknown or a missing-evidence limitation.

Independent no-network reproduction used the actual exported runtime projection and scorer via `npx tsx -e`, exit 0. Input was one successful typed `get_listing_details` result:

```json
{
  "name": "get_listing_details",
  "arguments": { "propertyId": "jain" },
  "output": {
    "found": true,
    "listing": {
      "propertyId": "jain",
      "title": "Jain Home",
      "rentLabel": "$1,200",
      "address": "12 Cedar Street",
      "available": "Now"
    }
  }
}
```

Pass this through `projectProspectShadowPrimaryEvidence`, then supply that result as `primary.evidence` to `compareProspectShadow`, with identity `{ shadowProvider: "openai", shadowModel: "fixture" }`. Observed results:

| Shadow output | Actual grounding | Required conservative result |
| --- | --- | --- |
| `Jain Home rent is 12.` | `grounded` | `ungrounded` or `unknown` |
| `Jain Home address is $1,200.` | `grounded` | `ungrounded` or `unknown` |
| `Jain Home is available Now.` | `grounded` | `grounded` |

The false successes can be persisted and traced as positive GPT grounding evidence. The runtime now produces these real fact groups, so the problem is reachable through the real snapshot/recovery path, not only through a richer handcrafted scorer shape. Preserve predicate/value relationships when awarding a positive result, or return unknown for claims the deterministic checker cannot prove. Add swapped-field regressions using the actual projection. Do not use incumbent prose as evidence or weaken the sealed runner.

## Corrections verified

- **D1:** Unsupported Claw ingress is rejected before enqueue health/database/publication work; callback rejects persisted retired-rail bursts before the leasing handler; transport/outbox boundaries reject or block retired rows. The new dispatcher no longer imports or calls the historical Claw retry helper. The actual Claw configuration function remains hard false. No Twilio fallback for rejected persisted Claw rows was found.
- **Active Twilio receipt recovery:** `src/app/api/twilio/inbound/route.ts:652` turns the handler's durable health/database/publication errors into `retryable` receipts and HTTP 503 before the final completed acknowledgement. Throws also return retryable/503. The handler's `durablyClaimed: true` bypasses its local receipt shortcut; duplicate durable ingress republishes without increasing the revision. No permanent acknowledgement-before-ingress defect was established.
- **Active dispatch:** Unreadable suppression state defers without a provider call. Uncertain provider submission becomes terminal `unknown`, with no blind retry. Existing last-consent-check to external-send timing is not made atomic by the burst fence; it remains a documented live QA caveat.
- **C1:** The dispatcher still uses atomic `prepare_prospect_sms_delivery`. Preparation and submission lock burst then outbox; generation revision/lease and current prepared intent are checked; stale candidates cannot insert a sendable intent and terminal submissions cannot be revived. Independently verified unchanged migration SHA-256 `f2e77728990800838696e6fff60df17c723861dd9555a217f0650dc7ee96be70`. Root's clean/repeat apply and 78 real PostgreSQL assertions use actual baseline outbox/attempt DDL; those are root's commands, not rerun by this reviewer.
- **D2 isolation/identity:** Real primary metadata now carries burst ID/revision alongside prompt metadata. The actual runtime snapshot survives JSON serialization and passes pre-turn conversation, system prompt and schemas to GPT without current incumbent answer/tool outputs. Only exact recorded tool-name/argument matches receive sealed results. Recovery retains identity and explicit unknown outcomes. FINAL-1 concerns the positive grounding verdict, not provider isolation.
- **D3 runtime coverage:** New tests retain the real leasing runtime, loop, registry and typed tools. They exercise serialized shadow input, a provider response held pending across a revision change, stale inline-action rejection, typed suppression, explicit resend/correction outputs, and canonical tour tool dispatch. The new fixture uses `crossCatalog: true` and preselected canonical tool arguments; it is not proof of live manager-owned Twilio delivery or real-model name selection. Root separately exercised actual owner-scoped joined/spaced lookup on seeded dev/test data.

## Verification and remaining conditions

Independent nine-file command:

```sh
npx vitest run tests/unit/agent/prospect-sms-runtime-boundary.test.ts tests/unit/agent/prospect-shadow-comparison.test.ts tests/unit/agent/openai-shadow-provider.test.ts tests/unit/prospect-sms-outbox-dispatch.test.ts tests/unit/prospect-sms-ingress-retry.test.ts tests/unit/prospect-sms-burst-callback.test.ts tests/unit/twilio-inbound-retry.test.ts tests/unit/twilio-leasing-inbound.test.ts tests/unit/proplane-transport-consent-gate.test.ts
```

Initial result: exit 1, 57 passed and one 20-second timeout during the cold import in `twilio-leasing-inbound.test.ts`. The other eight files passed. The first isolated normal-timeout rerun also exited 1 with one timeout and one pass. A bounded diagnostic run of that file with `--testTimeout=60000` then passed both tests, exit 0, in 2.97 seconds. The final unchanged default-timeout rerun, `npx vitest run tests/unit/twilio-leasing-inbound.test.ts`, passed both tests, exit 0, in 3.98 seconds. This is consistent with transient cold-transform/concurrent-load contention; it does not relabel either earlier failure or assert a proven root cause. No test timeout or implementation was changed.

The execution handoff reports 13 files/88 focused tests, targeted ESLint, `git diff --check`, and 4 GB typecheck passing with exit 0. Its final repository lint passed with zero errors/1,001 existing warnings; full unit passed with 1,333 files/9,157 tests, both exit 0. Final 4 GB build and `npm run lockfile:verify` both passed, exit 0. Post-build browser evidence was not yet finalized to this reviewer. Consult `docs/plans/prospect-sms-single-reply-correction2-handoff.md` and `docs/plans/prospect-sms-browser-qa.md` for their exact final state. Reviewer `git diff --check` also exited 0.

Root's real read-only dev/test checks resolved both `FirLofts` and `Fir Lofts` to `mgr-test-fir`, and real tour service calls returned 106 open keys for that property versus unavailable/zero for a missing ID. They do not establish live Jain Home data or model quality. The reviewer ran the mandated graph query, which exited 0 using the legacy graph; current source determined findings. Required TypeScript graph refresh/portability remains blocked by the documented CLI mismatch.

No authoritative manager takeover state exists in the inspected prospect runtime; notification escalation is not takeover. Takeover acceptance remains unsupported rather than invented. No real QStash execution, designated-recipient SMS, designated-key GPT call, deployed migration or staging QA was performed. No source implementation edit, shared database write, message send, paid model call, commit/push/PR/release, Linear action, or no-mistakes execution was made by this reviewer.
