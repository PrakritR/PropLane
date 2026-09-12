# Prospect SMS activation trial: fresh Astra review

Date: 2026-09-12

## Scope and verdict

**Changes requested for comparison accuracy: one P2 finding.** The prior P1
punctuation defect AT-1 is corrected. No new blocking defect was identified in
the QStash publisher, shadow expiry gate, or read-only snapshot boundary.
Resolve TRIAL-FINAL-1 before interpreting or activating the requested comparison
trial. This finding does not establish a customer SMS or write capability.

Review base and unchanged committed HEAD are both
`b251d49f73c76f56804e14de956aea8ac66f7d5f` on `prospect-sms-release`.
Its parents are keeper `b427e92f721cd48f5b45ca9be11b672353237ab8` and upstream
`01c6af066f4200a8f5ecdfe900fd1239a6ffc3fb`. Review target is HEAD plus these nine
uncommitted source/test files, not a new commit:

- `src/lib/agent/leasing-sms-agent.server.ts`
- `src/lib/agent/prospect-gpt-shadow.ts`
- `src/lib/agent/prospect-shadow-comparison.ts`
- `src/lib/sms/prospect-sms-burst.server.ts`
- `tests/unit/agent/openai-shadow-provider.test.ts`
- `tests/unit/agent/prospect-shadow-comparison.test.ts`
- `tests/unit/agent/prospect-sms-runtime-boundary.test.ts`
- `tests/unit/leasing-sms-quiet-runtime.test.ts`
- `tests/unit/prospect-sms-ingress-retry.test.ts`

SHA-256 of `git diff -- src/lib tests/unit` at review:
`a876e6c1392b76f7440a9c1c64a4c372ff35e592ae2dd70c7b628f963082c8f0`.
Activation plans, handoffs, the first Astra review, operational QA, and the
security review informed this review. No UI, cache, native, schema, or migration
change belongs to this dirty scope.

## TRIAL-FINAL-1: P2 - Equivalent numeric formatting is scored as unsupported

Location: `src/lib/agent/prospect-shadow-comparison.ts:214`, with the related
raw-token membership check at line 228.

`hasExactNumericMismatch` compares the original numeric strings after matching
the surrounding assertion. Consequently ordinary formatting changes produce a
negative factual score even when the amount is identical. The activation plan
requires negative numeric evidence only when sound; this can bias the silent
comparison against a correct response.

Independent no-network reproduction used the actual
`projectProspectShadowPrimaryEvidence` projection for successful
`get_listing_details`, property `jain`, title `Jain Home`, rent label `$1,200`,
address `12 Cedar Street`, availability `Now`:

| Shadow reply | Observed grounding | Required conservative behavior |
| --- | --- | --- |
| `Jain Home rent is $1200.` | ungrounded | unknown, or grounded only with additional proof |
| `Jain Home rent is $1,200.00.` | ungrounded | unknown, or grounded only with additional proof |
| `Jain Home rent is $1,200.` | grounded | grounded |
| `Jain Home rent is -$1,200.` | unknown | unknown |
| `Jain Home rent is >$1,200.` | unknown | unknown |

Reproduction command imported the two pure functions through `npx tsx -e` and
printed the five classifications above; exit 0. No provider, database, or
credential was involved.

Bounded correction plan:

1. Separate lexical mismatch from proven numeric inequality. Equivalent
   thousands separators and trailing decimal zeros must not produce
   `ungrounded`. Keeping them `unknown` is sufficient; affirmative proof can
   remain literal.
2. Apply the same conservative equivalence treatment to the added-number path,
   so appending an equivalent rendering cannot reintroduce the negative score.
   Preserve currency/unit distinctions and fail to `unknown` for ambiguous
   syntax; avoid broad numeric coercion that erases those distinctions.
3. Add actual-projection regressions for `$1200`, `$1,200.00`, a second supported
   sentence using an equivalent amount, and a genuinely differing amount.
   Retain the punctuation, sign, inequality, field-swap, substring, URL-case,
   cross-property, negation, and additional-claim cases.
4. Run the focused suites and the remaining fresh review within the permitted
   correction cycle. Root owns broad validation and deployment evidence.

## Other reviewed behavior

- AT-1 is closed: complete assertion matching preserves signs, operators,
  currencies, and URL path/query case. Numeric or semantic punctuation no
  longer disappears before affirmative grounding.
- New shadow snapshots use only the registry's read schemas and matching read
  evidence. The missing `toolEvidence` fallback does not alter primary answers;
  it prevents absent fixture/legacy evidence from throwing during return-value
  construction. No live tool executor or sender is introduced in the runner.
- Invalid UTC deadlines and the exact expiry boundary disable new model runs.
  Continuations recheck the shared gate. An already-started provider request
  can finish within its timeout after the deadline.
- Existing Low finding TRIAL-SEC-1 remains nonblocking: a selection that crosses
  expiry can still claim up to two recovery jobs and finalize disabled results
  as unknown. The runner prevents a new model request. The handoff should not
  describe this as an atomic cutoff for all database claims.
- Raw server-configured QStash destination interpolation retains the scheme;
  the SHA-256 JSON tuple gives stable ingress identities and fresh recovery
  identities. Callback authentication is unchanged. HTTP remains accepted by
  code, so the rollout configuration must retain the reviewed HTTPS endpoint.
- Existing persisted snapshots are not retroactively filtered. Their provenance
  remains part of activation review. No new UI/browser, cache/egress, navigation,
  or native parity test is required by this server-only diff.

## Independent validation and release gate

The following hermetic command exited 0: six files, 49 tests passed.

```sh
npx vitest run tests/unit/agent/prospect-shadow-comparison.test.ts tests/unit/agent/openai-shadow-provider.test.ts tests/unit/agent/prospect-sms-runtime-boundary.test.ts tests/unit/prospect-sms-ingress-retry.test.ts tests/unit/prospect-sms-shadow-recovery.test.ts tests/unit/leasing-sms-quiet-runtime.test.ts
```

`git diff --check` passed. The local `.graphify/graph.json` is absent, so review
used the explicit architecture notes, actual diff, and adjacent source. No
graph artifact or implementation file was changed by this reviewer.

Operational QA now records real QStash duplicate publication and signed callback
delivery with HTTP 200; missing or wrong-subject signatures were rejected. That
evidence used a suppressed staging fixture and proves neither a complete
generated customer reply nor Twilio delivery. It was not repeated here.

Keep external release blockers separate from TRIAL-FINAL-1: root reports two
unrelated upstream migrations absent from staging/production ledgers, with
unresolved High findings in the billing add-on paths. Do not apply those
migrations or bypass parity as part of this SMS correction. The local OpenAI
key returned 429 `credit_balance_exhausted`; that says nothing about any
different Vercel key, and no real GPT comparison has completed. Root still owns
full unit/lint/build/preflight results, reviewed deployment, designated model
credential readiness, explicit bounded deadline, and activation verification.

Only this report was written. No external API call, credential access, database
operation, send, commit, push, or deployment was performed by this review.
