# Prospect SMS activation trial security review

Date: 2026-09-12

## Verdict

PASS WITH ONE LOW-SEVERITY FINDING for the bounded source change. No critical,
high, or medium security regression identified. This is not production activation
approval: real signed callback delivery and a funded designated model credential
remain root-owned operational acceptance requirements.

Reviewed the eight uncommitted source/test files over
`b251d49f73c76f56804e14de956aea8ac66f7d5f`, against
`docs/plans/prospect-sms-activation-trial.md` and its execution handoff.
Unrelated upstream migrations and add-ons are outside this review.

## Finding

### TRIAL-SEC-1: recovery may claim a job after the trial expires (Low)

Location: `src/lib/sms/prospect-sms-burst.server.ts:162`.

`runPendingProspectShadows` checks shared enablement before awaiting the pending
job query. If that query spans the configured deadline, the subsequent callback
still claims up to two jobs, even though the trial has expired. The runner checks
enablement again and makes no provider request; recovery then finalizes the
disabled result as `unknown`. This is a bounded bookkeeping side effect, not an
SMS capability, unauthorized read, or post-expiry model spend. It nevertheless
falls short of the handoff's claim that expiry disables recovery claims.

Suggested follow-up: recheck shared enablement immediately before constructing
each claim, and add a fake-clock test advancing past the deadline while the
selection is pending. Describe the deadline as a gate on new model requests:
already-started provider requests can finish after it, subject to the existing
request timeout. A strict database-commit cutoff would require stronger atomic
enforcement than a JavaScript time check.

## Security boundaries checked

- QStash destination comes from server configuration, not prospect input. The
  change validates an absolute HTTP(S) URL and preserves its scheme/path in the
  publish endpoint. It does not introduce a customer-controlled destination.
  Production configuration must use HTTPS; HTTP remains accepted configuration.
- Deduplication hashes a JSON tuple of burst id, revision, and attempt id with
  SHA-256. Tuple encoding avoids delimiter ambiguity. Ingress retries reuse the
  logical identity and recovery adds a fresh UUID. The digest grants no access.
- The unchanged callback requires both a timing-safe forwarded-secret match and
  QStash signature verification against the raw body and request URL before
  constructing its service-role client. Routing identity and message bodies are
  loaded from durable rows; queue payloads contain only burst id and revision.
  No authentication relaxation is part of this diff.
- New snapshots obtain schemas with `readOnly: true` and no write allowlist.
  Matching evidence, canonical facts, and primary tool-call comparison data use
  the same read-name filter. `request_tour` and `escalate_to_manager` are absent
  from the model tool surface. Existing historical conversation/system context
  is preserved; the filter applies to this turn's replay evidence and schemas.
- The isolated runner imports the provider boundary and comparison code, not a
  runtime tool executor, sender, or database client. Calls can only replay exact
  recorded tool names and stable arguments. Missing evidence stops the run.
  The primary answer is comparison input, not provider input. OpenAI requests
  retain `store: false`.
- No new landlord selector, tenant query, registry handler, or outbound message
  write path appears in the diff. The frozen transcript continues to come from
  the authenticated work-number owner's scoped history. Existing service-only
  persisted snapshots remain a trust assumption; this was not a fresh RLS audit.
- Invalid dates and exact-boundary expiry fail closed. Direct execution,
  scheduling, initial recovery entry, snapshot creation, and continuation
  requests consult the shared enablement decision. Unset deadline compatibility
  deliberately remains; production trial configuration must set a future UTC
  deadline explicitly.
- Grounding now requires covered complete assertions from one canonical group,
  with exact numeric tokens. Regressions cover swapped fields, substring amounts,
  mixed properties, negation, added claims, and unprovable paraphrases. The
  scorer's result remains observational and cannot authorize an action.

## Validation

Independent local hermetic run, exit 0: 6 files and 48 tests passed.

```sh
npx vitest run tests/unit/agent/prospect-sms-runtime-boundary.test.ts tests/unit/agent/prospect-shadow-comparison.test.ts tests/unit/agent/openai-shadow-provider.test.ts tests/unit/prospect-sms-shadow-recovery.test.ts tests/unit/prospect-sms-ingress-retry.test.ts tests/unit/prospect-sms-burst-callback.test.ts
```

Graph query attempted, exit 1: installed CLI looked for the unavailable legacy
`graphify-out/graph.json`. Review used the actual diff and adjacent source.
No code edits, external calls, credential reads, database operations, sends,
commits, or pushes were performed by this reviewer. Only this report was added.

Root reports the corrected QStash request was accepted with HTTP 201, while the
deployed callback still returned HTTP 401 `Invalid queue signature`; root is
investigating configuration. Root also reports an OpenAI HTTP 429
`credit_balance_exhausted`. These observations were not independently reproduced
here. Preserve signature verification while resolving the delivery failure and
complete real integration QA before activating the trial.
