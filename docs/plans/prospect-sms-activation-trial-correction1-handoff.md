# Prospect SMS activation trial correction 1 handoff

Date: 2026-09-12

## Goal and scope

Corrected AT-1 from
[`prospect-sms-activation-trial-review.md`](prospect-sms-activation-trial-review.md)
on branch `prospect-sms-release` at unchanged HEAD
`b251d49f73c76f56804e14de956aea8ac66f7d5f`. The worktree remains
uncommitted and preserves the prior activation-trial changes.

This correction changed only the deterministic comparison scorer, its focused
tests, and a defensive leasing-runtime fallback plus its fixture. No external
call, database access, credential read, SMS send, deployment, commit, or push
was performed.

## Resulting behavior

Affirmative grounding now requires the complete shadow reply to consist of one
or more literal supported assertions from one canonical property group. The
matcher normalizes only case and whitespace, accepts an optional terminal
period, and permits `.`, `!`, or `?` plus whitespace only as separators between
whole supported assertions. It preserves signs, inequalities, currency
punctuation, URL paths and query strings, and every other non-whitespace
character. Prose matching is case-insensitive, while complete URLs retain exact
case because their path and query components may be case-sensitive.

The actual typed `projectProspectShadowPrimaryEvidence` projection now proves:

- `Jain Home rent is $1,200.` is `grounded`.
- ASCII and Unicode negative amounts are `unknown`.
- `<`, `>`, `<=`, `>=`, `≤`, and `≥` amount assertions are `unknown`.
- Negated, alternate-currency, punctuation-modified, swapped-field,
  substring-amount, cross-property, added-claim, and altered-link assertions do
  not become `grounded`.
- A plain positive numeric mismatch remains `ungrounded` only when the existing
  evidence makes that mismatch sound. Signed, operator-modified, negated, and
  unsupported-currency numeric syntax remains `unknown`, including when it is
  appended after a supported assertion.

The root full-unit run exposed four failures in
`tests/unit/leasing-sms-quiet-runtime.test.ts`: successful mocked agent results
omitted `toolEvidence`, and the new read-only snapshot filter called `.filter`
on that absent field. Production now treats absent evidence as an empty array,
and the fixture includes the real empty-array result contract. All four failing
cases pass.

## Correction files

- `src/lib/agent/prospect-shadow-comparison.ts`
  - Replaced punctuation-discarding token coverage with anchored literal
    complete-assertion matching.
  - Kept numeric mismatch classification conservative when unsupported syntax
    is present.
- `tests/unit/agent/prospect-shadow-comparison.test.ts`
  - Added actual-projection regressions for signs, operators, currencies,
    punctuation, negation, links, safe separators, and appended unsupported
    numeric syntax.
- `src/lib/agent/leasing-sms-agent.server.ts`
  - Defaults absent `result.toolEvidence` to an empty array before read-only
    snapshot filtering.
- `tests/unit/leasing-sms-quiet-runtime.test.ts`
  - Adds `toolEvidence: []` to successful `runAgentTurn` fixtures.

There are no migrations.

## Delegation and independent review

GPT-5.6 Terra implemented the initial AT-1 correction and focused tests. A
fresh GPT-5.6 Luna read-only review found one remaining P1 edge: an appended
signed or inequality claim could still be labeled `ungrounded` by the added
number path. The integration pass corrected that edge and added regressions.
Luna found no other grounding false positives in the reviewed exact,
swapped-field, substring, cross-property, negation, paraphrase, URL, or
sentence-boundary cases.

## Validation

Focused comparison, provider, runtime, recovery, publisher, callback, inbound,
transport, consent, and quiet-runtime suite:

```sh
npx vitest run tests/unit/agent/prospect-sms-runtime-boundary.test.ts tests/unit/agent/prospect-shadow-comparison.test.ts tests/unit/agent/openai-shadow-provider.test.ts tests/unit/prospect-sms-shadow-recovery.test.ts tests/unit/prospect-sms-outbox-dispatch.test.ts tests/unit/prospect-sms-ingress-retry.test.ts tests/unit/prospect-sms-burst-callback.test.ts tests/unit/twilio-inbound-retry.test.ts tests/unit/twilio-leasing-inbound.test.ts tests/unit/proplane-transport-consent-gate.test.ts tests/unit/leasing-sms-quiet-runtime.test.ts
```

Exit 0: 11 files passed, 87 tests passed.

After the final URL case-preservation correction:

```sh
npx vitest run tests/unit/agent/prospect-shadow-comparison.test.ts tests/unit/leasing-sms-quiet-runtime.test.ts
```

Exit 0: 2 files passed, 15 tests passed.

Scoped lint:

```sh
npx eslint src/lib/agent/leasing-sms-agent.server.ts src/lib/agent/prospect-gpt-shadow.ts src/lib/agent/prospect-shadow-comparison.ts src/lib/sms/prospect-sms-burst.server.ts tests/unit/agent/openai-shadow-provider.test.ts tests/unit/agent/prospect-shadow-comparison.test.ts tests/unit/agent/prospect-sms-runtime-boundary.test.ts tests/unit/prospect-sms-ingress-retry.test.ts tests/unit/leasing-sms-quiet-runtime.test.ts
```

Exit 0 with no output.

The final correction files were also linted directly:

```sh
npx eslint src/lib/agent/leasing-sms-agent.server.ts src/lib/agent/prospect-shadow-comparison.ts tests/unit/agent/prospect-shadow-comparison.test.ts tests/unit/leasing-sms-quiet-runtime.test.ts
```

Exit 0 with no output.

TypeScript:

```sh
NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit
```

Exit 0 with no output.

`git diff --check` exited 0 with no output.

Graph refresh was attempted with `npx graphify hook-rebuild` and exited 1
because npm could not determine an executable. No graph artifact changed.

## Root-owned operational evidence and blockers

Root reported that staging QStash signature validation is resolved after
making the four local QStash credentials coherent and redeploying. A correctly
signed custom URL returned 200, while a wrong URL returned 401. Two real calls
through the updated `enqueueProspectSmsBurst` helper for the same existing
staging fixture and source SID returned the same burst, revision, and QStash job
id; prior delayed jobs show delivered 200 in QStash logs. This is root-reported
external evidence and was not repeated by this correction session.

The OpenAI trial remains blocked by HTTP 429 `credit_balance_exhausted` until a
funded designated key is available. Unrelated upstream migration and billing
risks remain outside this correction and must not be silently applied here.

## Next review

Run a fresh Astra review against the activation plan, original execution
handoff, original review, and this correction handoff. Review the nine current
code/test files, with special attention to whole-assertion grounding and the
conservative boundary between `unknown` and sound `ungrounded`. Root owns the
broad gate, release ladder, credentials, and trial activation.
