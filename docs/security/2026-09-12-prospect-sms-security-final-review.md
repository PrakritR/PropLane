# Prospect SMS final security review

Date: 2026-09-12. Independent bounded review after correction cycle 2 for Akhil.

Verdict: **SEC-1, SEC-2, and SEC-3 resolved for the amended manager-owned Twilio prospect SMS scope. No open security blocker was established in the reviewed correction.** This accepts the code boundaries, not activation, deployment, provider delivery, or completion of external QA. Claw remains retired.

## Snapshot and authority

- Branch `prospect-agent-eval-loop`, HEAD `6f24d93b712f140d16af5f10e14b1fd88edd61aa`, with the plan-scoped uncommitted changes identified in `docs/plans/prospect-sms-single-reply-correction2-handoff.md`. Unrelated dirty workflow, evaluation, release, and configuration work was excluded and preserved.
- Governing scope: `docs/plans/prospect-sms-retired-transport-amendment.md`, root/Akhil instructions, and `docs/agents/sms-system.md` retirement invariant. Read the original security report, correction-cycle-1 security report, final handoff, and root's SQL evidence.
- Independently checked migration SHA-256: `f2e77728990800838696e6fff60df17c723861dd9555a217f0650dc7ee96be70`. The migration is unchanged from correction cycle 1.
- Graphify supplied initial orientation through its available legacy graph. Current source and the exact migration determined conclusions; graph results are not current validation evidence.
- This report is this reviewer's only repository write. No implementation changes, shared database writes, provider/network messages, paid model calls, staging/production actions, commits, PRs, Linear work, or no-mistakes execution occurred.

## Resolved findings

### SEC-1: atomic preparation and publication

`src/lib/sms/owner-sms-dispatcher.server.ts:215` invokes `prepare_prospect_sms_delivery` directly for prospect candidates. It does not publish a standalone claimable outbox row first.

The SQL function at `supabase/migrations/20260912143000_prospect_sms_bursts.sql:207` locks the burst, validates manager/recipient/transport against its service-owned identity, validates revision and the active generation lease, inserts one unique intent, and attaches the intent atomically. A failure rolls back both writes. Preparation and submission both lock burst before outbox. Existing correlated intent observation does not change terminal or uncertain states back into sendable ones.

Root independently applied and reapplied this exact migration using real baseline outbox/attempt DDL in isolated PostgreSQL and ran 78 SQL assertions, all exit 0. Coverage includes uncommitted intent invisibility, rollback/crash recovery, concurrent preparation, lock ordering, identity mismatches, stale revisions, client-role denial, and submitted/unknown non-revival. See `docs/plans/prospect-sms-db-probe.md`. This reviewer inspected the source, hash, and evidence; those SQL assertions were not rerun by this reviewer.

### SEC-2: no new managed linkage to the retrying retired helper

The new durable dispatcher no longer imports or invokes `sendClawMessengerText` or Claw route registration. A persisted `transport = claw` outbox is blocked before policy loading, submission fencing, or either provider (`src/lib/sms/owner-sms-dispatcher.server.ts:446`). With durable bursts globally disabled, prospect rows defer earlier, also without provider calls.

Retired ingress is rejected before the durable ingress RPC or queue publication (`src/lib/sms/prospect-sms-burst.server.ts:61`). The shared historical handler rejects unscoped durable acceptance and releases its local receipt claim (`src/lib/claw-leasing-bot.server.ts:1045`). A signed callback rejects stored Claw routing before invoking the leasing handler (`src/app/api/internal/prospect-sms-burst/route.ts:63`). Both outbox enqueue and high-level send reject durable Claw candidates (`src/lib/sms/owner-sms-dispatcher.server.ts:195`; `src/lib/proplane-sms-transport.server.ts:152`). None of these branches falls back to Twilio or borrows a manager sender.

The real `isClawMessengerConfigured()` still returns false unconditionally (`src/lib/claw-messenger.server.ts:36`), and the real gateway webhook exits with 503 before reading the body. A local probe ran both actual modules with synthetic enable/key variables and confirmed those guards. The historical provider helper's uncertain-send retry remains outside supported scope and was not reactivated or rewritten. This is resolution by removing the new linkage, as authorized by the amendment, not a claim that the historical helper itself was fixed.

### SEC-3: the fail-open legacy gate is outside the new durable boundary

The extracted correction-cycle-1 transport gate is no longer connected to a managed Claw dispatch branch. Durable Claw candidates are rejected before the legacy consent gate. Active managed Twilio still calls `readSmsSuppressionState` and converts its unreadable-store errors into a retryable deferral (`src/lib/sms/owner-sms-dispatcher.server.ts:150`, `:342`).

An isolated probe executed the actual dispatcher and actual consent module against an in-memory database double. An unavailable phone consent ledger and unavailable phone-matched profile store each produced `deferred` with the corresponding unreadable reason, zero provider calls, and no submission RPC. A persisted STOP produced `blocked` with `recipient_opted_out`. These verify the phone-keyed prospect boundary; they are not claims about live Supabase failure behavior or atomic STOP enforcement.

## Preserved security controls

- All seven new mutation RPCs still pin `search_path`, revoke PUBLIC/anon/authenticated execution, and grant service-role execution. New burst/transcript/action/shadow tables still enable RLS and revoke anon/authenticated access. Compatibility rail metadata cannot authorize runtime Claw delivery.
- Callback authentication still precedes service-role client creation. Payloads supply only burst ID/revision; stored owner, phone, source IDs, and rail remain service-derived. The SQL preparation identity checks are unchanged. Callback mapping's remaining default to Twilio is after an explicit Claw rejection and a nonnull database enum constraint, not a retired-rail fallback.
- Twilio sender identity still comes from registered manager-number state with service/campaign identity checks. Caller-supplied `transport_from_number` does not control the provider sender.
- The actual dispatcher probe confirmed an uncertain Twilio result becomes terminal `unknown`. A subsequent invocation with a database double respecting claim eligibility made no second provider call. Independently inspected real `claim_sms_outbox` SQL excludes unknown/submitting rows, and stale uncorrelated submissions are reconciled to unknown. Root's real SQL assertions additionally cover non-revival.
- `sendSms` has one `messages.create` call and returns provider errors without a retry loop. `createTwilioRestClient` does not enable SDK retries; installed Twilio `BaseTwilio`/`RequestClient` default `autoRetry` to false. No newly supported nested uncertain-send retry was found.

## Open limits and out-of-scope observations

There are **no open SEC-1/SEC-2/SEC-3 findings** under the amended scope. The following remain limits rather than silently waived acceptance claims:

- Consent checks precede later database round trips and provider submission. A STOP arriving after the check is an existing last-check-to-send race; the revision fence is not an atomic consent/provider transaction.
- No authoritative manager-takeover state is established in the prospect runtime. Escalation status is notification state. Takeover acceptance remains unverified; this review does not assert a demonstrated takeover bypass or invent a new mechanism.
- A broader synthetic scenario with a user-ID-only suppression record exposed an unchanged dispatcher omission: dispatch does not forward `row.recipient_user_id` to `loadSendPolicy`, although the reader supports that fallback. This omission is also present in HEAD. The durable prospect path supplies no recipient user ID, so it is outside this correction's phone-keyed prospect guarantee and is not a reopened SEC-3. No broader recipient-ID suppression guarantee is made here. The initial exploratory probe failed this extra assertion; the final probe explicitly targets the supported prospect stores. Root and the parallel Astra reviewer were notified.
- QStash credentials, a designated development GPT key, and a designated SMS test recipient remain absent. No real queue publish/callback/recovery cycle, paid comparison, or actual SMS acceptance/delivery was demonstrated. These are external QA prerequisites, not evidence of code defects. Inherited paid credentials were not used.
- Shared staging migration/preview QA and deployment remain unperformed. Root owns the final browser check; the implementation manager owns broad test/lint/typecheck/build reporting. Neither is relabeled as this reviewer's work. The documented Graphify executable/runtime mismatch remains a tooling limitation.

## Independent validation

- `npx vitest run tests/unit/prospect-sms-outbox-dispatch.test.ts tests/unit/prospect-sms-ingress-retry.test.ts tests/unit/prospect-sms-burst-callback.test.ts tests/unit/proplane-transport-consent-gate.test.ts tests/unit/claw-manager-phones-route.test.ts tests/unit/sms-opt-out-unified.test.ts`: **exit 0, 6 files, 34 tests passed**.
- `node /tmp/prospect-sms-security-final/probe.cjs` from the repository root: **exit 0, 20 assertions passed**, one intentional provider-stub call, zero network/shared-database calls. Actual dispatcher/consent/configuration/webhook source is transpiled into isolated VMs; policy dependencies and persistence/provider boundaries are doubles. The mocked claim replay is supplemented by inspection of the real claim SQL and root's separate database evidence.
- Migration SHA-256 independently matches the final reviewed hash above. Claw configuration/webhook and Twilio primitive/client files have no working-tree diff.
