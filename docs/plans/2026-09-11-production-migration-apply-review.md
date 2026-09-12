# Production migration apply: independent Astra review

Date: September 11, 2026. Verdict: **CHANGES REQUESTED**.

Three High findings block production application. Three Medium findings also
require correction. This reviews only the current apply delta on keeper
`akhil/backlog-repeat-issues`, HEAD
`10962d8f3734b8424a98d4fa910fcd561943e60a`. Implementation was not edited.
Correction plan: `2026-09-11-production-migration-apply-correction-1.md`.

## Scope and inputs

Reviewed the changed preparation/apply entrypoint, new public CA, new apply
tests, and changed local rehearsal, including their untracked contents. Read
AGENTS.md, Akhil's developer and feature-cycle instructions, the feature-cycle
and graphify skills, apply plan/handoff/Luna input/root evidence, named waiver,
database environments, ship gate, and both production lock rules. Prerequisite
reading included the preparation rollout plan, prerequisites, risk inventory,
initial handoff/review, correction-1 plan/review, and root validation. SQL and
the unchanged local dependency fixture were inspected where needed.

No graph exists; documentation fallback was used. This documentation-only
review did not build a graph. No remote command, credential acquisition, real
preflight/apply, provider action, commit, stage, push, merge, or no-mistakes
ran. All executable probes below used local code and synthetic inputs.

## Findings

### R1 - High: management endpoint overrides survive sanitization

`scripts/prepare-20260911-production-migrations.mjs:301` copies the inherited
environment and removes a small denylist. It retains `SUPABASE_API_URL` and
`SUPABASE_PROJECT_HOST`. Every actual CLI invocation receives that environment
at line 313, including credential acquisition before binding checks at line
520. A configured alternate API endpoint can receive the CLI's authenticated
management requests before `parseExactCliLogin` can reject its answer.

Independent in-memory execution of the unchanged `safeCliEnvironment` retained
both synthetic overrides while removing PGHOST. The cached **2.117.0** binary
explicitly reads `SUPABASE_API_URL` into both the CLI `apiUrl` and the API
client `baseUrl`; it also reads `SUPABASE_PROJECT_HOST` into `projectHost`.
This is a real supported override, not an invented environment variable.

Use a narrowly controlled child environment with fixed provider endpoints and
trust settings. Audit the pinned CLI's automatic project/environment loading
as well, since the credential command runs from the repository before a
private workdir exists. Preserve only the necessary approved authentication
mechanism. Test the actual subprocess environment, not just an injected
`runCli` that bypasses this function.

### R2 - High: verified TLS applies to readback, not to the write connection

`scripts/prepare-20260911-production-migrations.mjs:337` correctly pins the CA
and enables peer verification for the Node `pg` readers. The CLI dry-run and
push at lines 531 and 541 establish their own connections. Neither receives
that CA or an enforced verify-full mode, and the environment scrub removes PG
TLS settings. The validated `connection` object is never supplied to the CLI.

Concrete pinned CLI evidence: the cached 2.117.0 binary's `Gle` direct remote
resolver constructs host/port/user/password/database without sslmode or
sslrootcert. `z9e` passes these fields to `aln`, then `pse`; the latter returns
`{rejectUnauthorized:!1}` unless an explicit verification mode is selected.
Executing that exact extracted function locally with the default remote
arguments returned `{ rejectUnauthorized: false }`. No socket was opened.
The checked-in CA therefore does not establish the claimed TLS property for
the production mutation. A valid TLS read before and after cannot authenticate
a different write socket or prevent a credential leak on it.

Prove a supported pinned-CLI path that uses the exact bound target and verified
peer/hostname/CA for both selection and push. Do not claim success from merely
setting an environment variable that this ad-hoc project-ref resolver ignores.
If this cannot be done within the approved mechanism, return an architecture
blocker to root before changing the operation contract.

### R3 - High: asynchronous driver errors bypass sanitization and readback

`scripts/prepare-20260911-production-migrations.mjs:523` and line 548 create
clients without `error` event listeners. `pg` transport/idle errors can emit
outside the awaited promise chain. The installed driver's
`node_modules/pg/lib/client.js:411` calls `this.emit('error', err)` after
failing queued queries. Without a listener, Node exits with the raw error.
This can terminate an apply session before the mandatory fresh readback.

Reproduced in an isolated Node subprocess using a real `pg.Client`, replacing
connect/query with hermetic methods and scheduling `_handleErrorEvent` with
a synthetic error. Child exit was **1**, stderr contained the synthetic secret,
and the orchestration promise catch was never reached. No database was opened.

There is a second redaction bypass at lines 559 and 573: any external error
whose message matches the broad `Production migration .+ ...` regex is trusted
and rethrown verbatim. A synthetic credential subprocess exception containing
`Production migration synthetic-private-secret failed. No credentials, SQL,
or database output is displayed.` was preserved. A text prefix is not an
internal error type.

Install lifecycle-aware event handlers before connection, retain bounded
failure state, and ensure events after push cannot skip readback. Use a private
error type or an exact code allowlist for safe messages. Cover construction,
connect, idle/error events, query, rollback, end, subprocess and filesystem
cleanup boundaries in child-process tests that inspect actual stdout/stderr.

### R4 - Medium: postflight validates boundaries and counts, not exact contents

`scripts/prepare-20260911-production-migrations.mjs:421` validates the auxiliary
row using length 121, a prefix on the first statement, and the last statement.
The middle **119 statements are unchecked**. The passing fixture at
`tests/unit/production-migration-apply.test.ts:27` explicitly fills them with
`bounded statement`. The successful 56-test run therefore demonstrates that
arbitrary auxiliary contents pass. The new local rehearsal checks the same
three boundaries at `scripts/testing/production-migration-local-rehearsal.mjs:279`.
The 121 count and stripped terminators are legitimate CLI representation
details; they are not a complete fingerprint of that representation.

Related catalog gaps: line 386 selects function names but not signatures;
line 425 checks only row counts. Lines 387-392 and 451-471 verify enabled
trigger names and placements, but omit trigger function OIDs, event/timing
bits, UPDATE column lists and WHEN conditions. Line 397 omits FK referenced
relation/columns; line 431 checks four rows rather than the four exact edges.
Same-name triggers calling a no-op, a wrong function overload, or an ownership
FK aimed at a different parent can pass the advertised postconditions.

Pin the complete ordered parsed-statement representation using actual pinned
CLI evidence and compare every element or a deterministic full digest. Verify
function identities and trigger definitions and the four exact auth.users(id)
FK edges. Keep the existing byte-exact twelve original source rows; extend
readback to reject conflicting source identities and unexpected historical
ledger mutation. Exercise the real catalog validator in the disposable
rehearsal, with explicit fixture defaults matching the intended grants.

### R5 - Medium: dry-run parser accepts a nested diagnostic as the verdict

`scripts/prepare-20260911-production-migrations.mjs:475` still extracts
brace fragments rather than parsing complete records. With a valid verdict
object V, both `JSON.stringify({error: V})` and arbitrary text wrapping V
were accepted by the unchanged function in an independent in-memory probe.
Thus stdout-only handling fixed one earlier issue, but a nested diagnostic
lookalike still passes the claimed strict actual-CLI shape check.

Parse complete structured records, require exactly one top-level success
verdict in the actual 2.117.0 format, and reject errors, conflicting records,
nested verdicts and malformed framing. Capture the real dry-run output in the
local CLI rehearsal rather than relying only on synthetic progress strings.

### R6 - Medium: a lost push response plus absence is called rolled back

`scripts/prepare-20260911-production-migrations.mjs:555` maps every nonzero
status, including null, to `rolled_back_or_refused` if readback looks clean.
`runPinnedCli` discards spawn error/signal details at line 317. A timeout or
lost npx response does not prove its descendant/database session has stopped;
a fresh reader can still observe absence before an in-flight transaction
commits. Even a later invocation can observe this same window.

An independent hermetic orchestration probe with null push status and clean
readback returned `rolled_back_or_refused`. Keep unknown transport/termination
outcomes uncertain unless actual termination and rollback are established.
Preserve bounded exit/signal/timeout metadata and never retry. Tests must cover
null/thrown/timed-out push with clean as well as installed readback.

## Verified strengths and scope distinctions

- Acknowledgement parsing rejects invalid/mixed/extra arguments before real
  operations. There is one push call, no retry loop, repeated workspace checks,
  a full pre-push ledger comparison, and a new readback client after push.
- Node reader host/user binding rejects wrong project users and non-provider
  hosts; CA bytes are pinned and peer verification is enabled for those readers.
  A strict provider pooler hostname plus exact project-scoped username is not
  itself a finding. The write transport deficiencies are R1/R2.
- The twelve source files and bundle builder are unchanged. In-bundle ledger,
  target absence, prerequisite, advisory-lock, timeout and bucket guards remain.
  Source ledger rows are individually compared to complete original SQL bytes.
- `account_deleted_identity_keys` is correctly excluded from dynamic capture
  topology: 225500 installs those triggers before 231000 creates this table.
  The local rehearsal now asserts that exclusion. Its actual success is Sol's
  prior evidence, not a reviewer rerun; my sandbox blocked the rehearsal.
- The webhook grant distinction is real. Immutable source revokes client
  INSERT/UPDATE/DELETE only, whereas recovery tables revoke ALL. The root's
  staging observation of SELECT/TRUNCATE/REFERENCES/TRIGGER on the webhook
  table matches that source under managed defaults. Zero-policy RLS denies
  row reads, not TRUNCATE. I do not classify the source-matching readback branch
  as a new privilege grant, nor approve a claim that webhook clients have no
  effective privileges. Broader webhook hardening needs separate SQL scope;
  silently editing this bundle is not an acceptable correction.

## Independent verification

All Node commands used
`PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:$PATH`.

- `node_modules/.bin/vitest run tests/unit/production-migration-preparation.test.ts tests/unit/production-migration-apply.test.ts --maxWorkers=1`: **exit 0, 2 files, 56 tests passed**, duration 845 ms.
- `node_modules/.bin/eslint scripts/prepare-20260911-production-migrations.mjs scripts/testing/production-migration-local-rehearsal.mjs tests/unit/production-migration-preparation.test.ts tests/unit/production-migration-apply.test.ts`: **exit 0**, no output.
- `node --check scripts/prepare-20260911-production-migrations.mjs`: **exit 0**.
- `node scripts/testing/production-migration-local-rehearsal.mjs`: **exit 1**, `listen EPERM: operation not permitted 127.0.0.1`, at `node:net:1919`, syscall `listen`, errno -1. It stopped at `availablePort()` before initdb/pg_ctl or any CLI/database operation. No rehearsal case passed in this reviewer run. Root can independently rerun the disposable local harness outside this socket restriction.
- `git diff --check`: **exit 0**. Separate `git diff --no-index --check /dev/null <file>` checks for the untracked CA and test each returned **1**, the expected new-file diff status, with no whitespace diagnostics.
- `git diff --exit-code HEAD -- src supabase/migrations package.json package-lock.json`: **exit 0**. Independent comparison of the entire `buildAtomicBundle` function against `git show HEAD:...`: identical.
- In-memory VM probes of unchanged functions: **exit 0**, reproduced R1, R3 message-prefix bypass and R5. Independent hermetic orchestrator/driver subprocess probes: harness **exit 0**, reproduced R6 and the R3 child crash described above. These were diagnostic probes, not additional passing Vitest cases.
- Cached pinned CLI package/source inspection and extracted TLS function probe: **exit 0**. Inspected binary `/Users/akhilvemuri/.npm/_npx/6f1b058a4d9555af/node_modules/@supabase/cli-darwin-arm64/bin/supabase`, package version 2.117.0, binary SHA-256 `c2ca0770b4634e85a01254ffdfda1999063e5d424f41dc345839e62171d8bb4b`. No CLI remote mode ran.
- `openssl x509 -in scripts/lib/supabase-root-2021.crt -noout -subject -issuer -dates -fingerprint -sha256`: **exit 0**. Self-issued Supabase Root 2021 CA, valid April 28 2021 through April 26 2031. Certificate DER fingerprint `807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa`; this differs normally from the PEM file hash below.

### Concurrent root validation, separate from reviewer execution

Before final handoff, root added
`2026-09-11-production-migration-apply-correction-1-root-addendum.md`.
It reports an external rerun of the frozen local rehearsal exiting **1** with
`concurrent bucket rehearsal did not reach the post-preflight advisory barrier`
at line 115. This supersedes any assumption that Sol's earlier passing run is
the latest rehearsal evidence. Root requires deterministic session/barrier
coordination and child cleanup; that work is part of the correction alongside
the six findings above. I read and preserved the addendum. Its execution and
log inspection remain root-owned evidence, not my sandbox test result.

## Immutable fingerprints

| Artifact | SHA-256 |
| --- | --- |
| Apply entrypoint | `c8226a43f34dc139bb2c2e410a9cc825befeee3b968011606d99cec00b2c29e3` |
| Public CA PEM | `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7` |
| Local rehearsal | `66c15b125e1dcd2e59d8f954e314160adab8e049030a10e0fd4fcf64f4f2eacc` |
| Apply test | `13858753eccf2b6f16575bb3bb4f67370bb7193e6ee51bf25fd5403b63eab79a` |
| Approved bundle, exactly 215925 bytes | `9402a949607a7856fcc97f8462f4acb0f23b395ebe12c375b24fd9b372b794ab` |

All hashes were independently computed. Manifest validation checked all twelve
source digests. These fingerprints identify the rejected apply implementation,
not permission to execute it.

## Release boundary

No apply approval is given. The named waiver remains scope-approved and
implementation-review-pending, not consumed. A corrected implementation needs
fresh review and fingerprints. Any subsequent approval covers this narrow
twelve-source path only. It does not authorize the five newer migrations,
resolve historical identity parity, claim staging/browser/provider QA, or
approve application/production branch promotion. Root alone may execute the
named waiver after approval and fresh read-only operational gates.
