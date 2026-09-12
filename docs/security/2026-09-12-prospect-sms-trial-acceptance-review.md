# Prospect SMS trial final acceptance review

Date: 2026-09-12

## Verdict and exact scope

**Code accepted with the existing Low finding TRIAL-SEC-1.** TRIAL-FINAL-1 is
resolved. No remaining blocking code finding was identified in this bounded
review. This is not operational readiness or production activation approval.

Reviewed branch `prospect-sms-release`, unchanged HEAD
`b251d49f73c76f56804e14de956aea8ac66f7d5f`, plus these nine dirty source/test files:

- `src/lib/agent/leasing-sms-agent.server.ts`
- `src/lib/agent/prospect-gpt-shadow.ts`
- `src/lib/agent/prospect-shadow-comparison.ts`
- `src/lib/sms/prospect-sms-burst.server.ts`
- `tests/unit/agent/openai-shadow-provider.test.ts`
- `tests/unit/agent/prospect-shadow-comparison.test.ts`
- `tests/unit/agent/prospect-sms-runtime-boundary.test.ts`
- `tests/unit/leasing-sms-quiet-runtime.test.ts`
- `tests/unit/prospect-sms-ingress-retry.test.ts`

SHA-256 of `git diff -- src/lib tests/unit`:
`be1747830cc3cf02aa560f0d92e874d23072b3e31e3dfbcd264e0c83631bf10f`.
The diff has 399 insertions and 38 deletions. Existing untracked documents were
the activation plan, handoff, correction1 handoff, correction2 handoff, QA,
review, upstream-migrations review, and the trial bugbot/security reviews. This
report is the only file added by this reviewer. No schema, migration, UI, or
native changes are in the reviewed source scope.

## Finding resolution

TRIAL-FINAL-1 (P2) is closed. Both negative-evidence paths now use string-only
canonical decimal equivalence for valid thousands grouping and trailing
fractional zeroes. With actual projected Jain Home rent evidence `$1,200`,
`$1200` and `$1,200.00` produce `unknown`; appending an equivalent amount to a
supported sentence also produces `unknown`. Exact `$1,200` remains `grounded`,
and genuinely different `$1,300` remains `ungrounded`.

The equivalence helper is not used for affirmative assertion proof. Currency
and percent markers remain distinct, no floating-point coercion is introduced,
and signs, operators, literal punctuation, URL path/query case, field swaps,
cross-property claims, negation, substrings, and unsupported additions retain
the reviewed conservative boundary. The prior AT-1 punctuation finding remains
closed.

The remaining source changes match the previously reviewed design: new shadow
snapshots carry read-only schemas and matching evidence; missing legacy fixture
evidence does not throw; shared deadline checks gate new provider requests;
QStash preserves the configured destination and hashes a JSON identity tuple.
The callback authentication boundary is unchanged. Earlier dedicated security
review remains the authority for its broader authentication assessment.

TRIAL-SEC-1 remains **Low, nonblocking**: a pending recovery selection crossing
expiry can claim up to two jobs and finalize disabled results as unknown.
The runner still prevents a new model request. Already-started requests may
finish within their timeout. This is not an atomic cutoff for database claims.
HTTP callback configuration and unset-deadline compatibility remain existing
operational constraints; the trial requires HTTPS and an explicit UTC deadline.

## Independent validation

Hermetic focused run exited 0: **6 files, 49 tests passed**.

```sh
./node_modules/.bin/vitest run tests/unit/agent/prospect-shadow-comparison.test.ts tests/unit/agent/openai-shadow-provider.test.ts tests/unit/agent/prospect-sms-runtime-boundary.test.ts tests/unit/prospect-sms-ingress-retry.test.ts tests/unit/prospect-sms-shadow-recovery.test.ts tests/unit/leasing-sms-quiet-runtime.test.ts
```

`git diff --check` independently exited 0. The local `.graphify/graph.json` is
absent; this review used the actual diff, scorer, tests, architecture notes,
activation plan, correction2 handoff, and prior reviews. Root owns the stable
full-unit rerun and broad release checks; their results are not inferred here.

## Operational readiness

**Production activation remains blocked.** Root reports real QStash duplicate
publication, a 20-second delay, and signed callback HTTP 200. This was not
repeated by this reviewer and does not prove generated customer replies,
Twilio delivery, or a completed real GPT comparison.

Unrelated upstream billing migrations remain absent from the staging/production
ledgers with unresolved High findings in those billing paths. They are outside
this correction and must not be applied or bypassed as part of acceptance.
The tested local OpenAI credential returned 429 `credit_balance_exhausted`;
the designated deployment credential still needs readiness evidence. Root owns
these blockers, final release gates, bounded trial configuration, and activation
verification. Code acceptance does not waive any of them.

No implementation edit, credential access, external API call, database
operation, SMS send, commit, push, or deployment was performed in this review.
