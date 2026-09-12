# Prospect SMS activation trial execution handoff

Date: 2026-09-12

## Goal and scope

Implemented the bounded execution in
[`docs/plans/prospect-sms-activation-trial.md`](prospect-sms-activation-trial.md)
on branch `prospect-sms-release`, starting and ending at HEAD
`b251d49f73c76f56804e14de956aea8ac66f7d5f` with uncommitted changes.

The planned scorer and shadow-expiry changes are complete. During root-owned
real QStash QA, two request-contract failures were reproduced and added to this
execution scope: QStash rejected a percent-encoded callback destination and a
deduplication id containing colons. Both are corrected and covered by focused
behavioral tests.

No migration, deployment, database write, customer/test SMS, paid model call,
commit, push, PR, or production mutation was performed by this execution
session.

## Reproduction and resulting behavior

Before the correction, a no-network `npx tsx -e` reproduction using the actual
`projectProspectShadowPrimaryEvidence` projection exited 0 and produced:

```text
Jain Home rent is 12. grounded
Jain Home address is $1,200. grounded
Jain Home is available Now. grounded
```

The same command after the correction exited 0 and produced:

```text
Jain Home rent is 12. unknown
Jain Home address is $1,200. unknown
Jain Home is available Now. grounded
```

The deterministic scorer now awards `grounded` only when the reply is fully
covered by complete supported assertions from one canonical property group.
It does not assemble an assertion from unrelated flat fact fragments. Swapped
fields, cross-property combinations, negation, added claims, and unprovable
paraphrases remain `unknown`; a property-bound unsupported numeric token remains
`ungrounded` when the mismatch is sound. Numeric matching is token-based, so an
amount cannot pass merely because it is a substring of a supported amount.

`AXIS_PROSPECT_GPT_SHADOW_UNTIL` is now part of the shared server-only enablement
decision. When set, it must be a valid absolute UTC timestamp ending in `Z`.
Invalid values and `Date.now() >= deadline` disable direct runs, fire-and-forget
scheduling, recovery claims, continuation calls, and new durable shadow
snapshots. An unset deadline preserves existing enabled-flag compatibility.

Snapshots expose only read-tool schemas and matching read-tool evidence to the
sealed GPT runner. `request_tour` and `escalate_to_manager` are excluded. No
tool handlers, SMS sender, registry execution path, database client, or incumbent
answer are available to the shadow provider.

QStash publication now validates the callback as an absolute HTTP(S) URL and
keeps the scheme/path unencoded in `/v2/publish/<destination>`. Deduplication ids
are stable SHA-256 hashes of burst id, revision, and attempt id. Duplicate
ingress retries retain the same id; recovery publications use fresh ids; the
result is a 64-character lowercase hexadecimal value with no colon.

## Changed files

- `src/lib/agent/prospect-shadow-comparison.ts`
  - Replaced property-level token-bag grounding with complete assertion coverage
    tied to one evidence group.
- `src/lib/agent/prospect-gpt-shadow.ts`
  - Added strict deadline parsing, exact-boundary expiry, and a continuation
    expiry recheck.
- `src/lib/agent/leasing-sms-agent.server.ts`
  - Gates snapshot creation on shared shadow enablement and restricts snapshot
    schemas/evidence to read tools.
- `src/lib/sms/prospect-sms-burst.server.ts`
  - Validates the QStash callback URL, preserves its raw HTTP(S) destination,
    and emits colon-free hashed deduplication ids.
- `tests/unit/agent/prospect-shadow-comparison.test.ts`
  - Adds runtime-projection regressions for swapped fields, substring amounts,
    exact supported assertions, mixed properties, negation, added assertions,
    paraphrases, and flat-fragment synthesis.
- `tests/unit/agent/openai-shadow-provider.test.ts`
  - Covers future, exact-boundary, invalid-date, non-UTC, disabled-flag, and
    unset deadline behavior plus zero provider calls after expiry.
- `tests/unit/agent/prospect-sms-runtime-boundary.test.ts`
  - Covers expired snapshot suppression and read-only shadow schemas/evidence.
- `tests/unit/prospect-sms-ingress-retry.test.ts`
  - Covers raw QStash destination construction, invalid callback rejection,
    stable duplicate ids, fresh recovery ids, and the allowed id character set.

There are no migrations. The untracked activation plan existed before execution
and was not rewritten.

## Validation evidence

Focused comparison, provider, runtime, recovery, transport, callback, and consent
suite:

```sh
npx vitest run tests/unit/agent/prospect-sms-runtime-boundary.test.ts tests/unit/agent/prospect-shadow-comparison.test.ts tests/unit/agent/openai-shadow-provider.test.ts tests/unit/prospect-sms-shadow-recovery.test.ts tests/unit/prospect-sms-outbox-dispatch.test.ts tests/unit/prospect-sms-ingress-retry.test.ts tests/unit/prospect-sms-burst-callback.test.ts tests/unit/twilio-inbound-retry.test.ts tests/unit/twilio-leasing-inbound.test.ts tests/unit/proplane-transport-consent-gate.test.ts
```

Exit 0: 10 files passed, 79 tests passed.

Scoped lint:

```sh
npx eslint src/lib/agent/leasing-sms-agent.server.ts src/lib/agent/prospect-gpt-shadow.ts src/lib/agent/prospect-shadow-comparison.ts src/lib/sms/prospect-sms-burst.server.ts tests/unit/agent/openai-shadow-provider.test.ts tests/unit/agent/prospect-shadow-comparison.test.ts tests/unit/agent/prospect-sms-runtime-boundary.test.ts tests/unit/prospect-sms-ingress-retry.test.ts
```

Exit 0 with no output.

TypeScript:

```sh
NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit
```

Exit 0 with no output. The repository has no `typecheck` npm script; the
delegate's attempted `npm run typecheck` exited 1 for that reason before using
the direct compiler command above.

Whitespace validation:

```sh
git diff --check
```

Exit 0 with no output.

Graph refresh was attempted as required:

```sh
npx graphify hook-rebuild
```

Exit 1: npm could not determine an executable to run. No `.graphify` artifact
was changed. The installed CLI mismatch is an existing environment limitation,
not a source or test failure.

This server-only change has no browser route or UI state to exercise. Root owns
real QStash/staging QA, credentials, deployment, and any actual SMS recipient.

## Independent assessment and remaining blockers

The Luna read-only delegate independently reproduced the original false
grounding, reviewed the initial implementation, and identified three issues that
were corrected before freeze: flat-fragment synthesis, permissive filler around
matched spans, and cross-property numeric pooling. Luna also identified the
write-tool schema/evidence exposure and disabled-period snapshot accumulation;
both are corrected by read-only filtering and shared enablement gating.

Root reported that a corrected raw-URL/allowed-id real QStash publish returned
HTTP 201 and duplicate publication reused the same QStash job id. Delivery to
the deployed staging callback currently returns HTTP 401 `Invalid queue
signature`; root is diagnosing signing-key or deployment-alias state and asked
this execution session not to change callback authentication yet. Root also
reported the available OpenAI Responses probe returns HTTP 429
`credit_balance_exhausted`. Those external conditions block a real silent GPT
trial but do not affect the hermetic tests above.

The fresh Astra reviewer should review the eight changed code/test files against
the activation plan and this handoff, with special attention to conservative
grounding, strict expiry at every entrypoint, read-only snapshot contents, raw
QStash destination syntax, and deduplication stability. Root should continue
the full unit/build gate and real staging QStash signature diagnosis after that
review. Do not activate the production shadow until a funded designated OpenAI
key and a future `AXIS_PROSPECT_GPT_SHADOW_UNTIL` are both present.
