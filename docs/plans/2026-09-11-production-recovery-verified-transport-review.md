# Independent verified transport review

Verdict: **APPROVED** for the named exact twelve-source production schema operation only. No blocking findings in the frozen replacement reviewed here. This does not approve the five newer migrations, historical parity repair, application promotion, or production application test writes.

Reviewer: fresh GPT-6 Astra, independent review phase of Akhil feature cycle. Started 2026-09-11 06:48:44 UTC; inspection and checks completed 06:50:49 UTC, before the 06:52:30 UTC deadline. Report written immediately afterward. Branch `akhil/backlog-repeat-issues`, HEAD `10962d8f3734b8424a98d4fa910fcd561943e60a`.

Read repository instructions, Akhil instructions, feature-cycle instructions/skill, verified-transport plan, frozen handoff, root evidence, and named waiver. Used documentation fallback; no graph exists. Inspected the frozen runner, rehearsal, preparation/apply tests and pinned CA. No delegation, remote request, credential acquisition, real production preflight/apply, implementation edit, waiver edit, or Git mutation occurred.

## Reviewed boundaries and closure

- Credential acquisition is limited to pinned CLI 2.117.0 `db dump --dry-run` for the fixed project. A private minimal config/cwd and child environment allowlist are constructed and checked before spawning; stdout is captured and stderr is not exposed. No CLI push or dry-run write-verdict parser remains (`scripts/prepare-20260911-production-migrations.mjs:306`, `:315`, `:333`, `:345`). This closes the prior CLI mechanism/parser issues through the expressly approved transport replacement.
- Parsed credentials must bind the fixed direct host/user or official pooler suffix with the exact project-scoped user, port 5432 and postgres database. CA bytes are pinned by SHA-256; `rejectUnauthorized: true` and explicit servername are passed to every original/fresh client (`:363`, `:380`, `:576`, `:589`). Local TLS acceptance and rejection were independently exercised; the real provider path remains an operational gate.
- Driver error listeners are installed before connect. Callback errors are retained without throwing; operation failures are converted to internal fixed-message errors. Connection/query/end boundaries are bounded and cleanup cannot suppress fresh readback (`:300`, `:406`, `:417`, `:431`, `:576`).
- Read-only preflight uses `BEGIN READ ONLY`, role selection, catalog reads, and rollback, with sanitized activity metadata. Two pre-apply snapshots must agree. Apply uses one explicit transaction, the unchanged bundle, auxiliary `[completeBundle]`, complete historical/source/auxiliary ledger validation and catalog validation before one COMMIT, followed by a fresh verified readback (`:436`, `:495`, `:505`, `:608`).
- Catalog checks cover exact function overload identities and effective execution grants; exact trigger relations/functions/timing/events/UPDATE columns/conditions/row placement and enabled state; RLS and effective table grants; private bucket; all four nullable ownership FK edges to `auth.users(id)`; nullable audit actor (`:393`, `:436`, `:505`, `:529`, `:554`). The table reader restricts rows to the unique expected names, so its cardinality check is coupled to identity selection. Trigger chronology excludes identity/storage-key tables created after capture installation. Webhook DML revocation remains the approved immutable source behavior.
- Full source and auxiliary SQL are compared byte-for-byte, and unrelated historical duplicate names are preserved. Target identity conflicts, partial installs, changed historical ledger and already-installed state fail closed (`:99`, `:495`, `:505`).
- Lost COMMIT responses remain uncertain even when fresh readback shows installation; there is no automatic retry. Confirmed pre-COMMIT rollback requires a rollback acknowledgement and fresh proof of unchanged ledger and absent migration objects (`:589`, `:638`). A concurrently created bucket can remain after a confirmed rollback, as the rehearsal explicitly verifies; it is not misreported as successful installation.

## Independently executed evidence

Node 22.23.0 was used for all Node commands, with its bin directory first on PATH for Vitest, ESLint and rehearsal.

| Command/check | Result |
| --- | --- |
| `node_modules/.bin/vitest run tests/unit/production-migration-preparation.test.ts tests/unit/production-migration-apply.test.ts --maxWorkers=1` | exit 0; 2 files, 39 tests |
| `node scripts/testing/production-migration-local-rehearsal.mjs` | exit 0; verified TLS clean installation through new runner, read-only preflight, full ledger, three rollback positions, task-owned backend bucket race, CA rejection, hostname rejection, async error redaction, lost-COMMIT uncertainty |
| scoped ESLint on runner, rehearsal and both tests | exit 0 |
| `node --check` on runner; separately on rehearsal | both exit 0 |
| `git diff --exit-code HEAD -- src package.json package-lock.json supabase/migrations` | exit 0 |
| `git diff --check` | exit 0 |
| imported `reviewedMigrationManifest()` and `buildAtomicBundle()` and hashed generated bytes | exit 0; 12 source digests validated, 215925 bytes, approved digest below |
| `shasum -a 256` on frozen files/handoff; OpenSSL certificate inspection | exit 0; all matched |

The rehearsal evidence above is this reviewer's own rerun, not relabeled manager evidence. No broad suite, build, typecheck or application/browser validation was run in this bounded schema review.

## Frozen fingerprints

| Artifact | SHA-256 |
| --- | --- |
| runner | `178540a6f319c01e2c61696ec99d617189871f6c584c87643974d776c1c8e624` |
| rehearsal | `cc849202715f2b4e7a7c5ce538bc8c324ed775fb72c8b6f7848ba3e19b195a72` |
| preparation test | `d9000f61c3b8503dff668f10d98c6d7faceb2bc5ac8ae28b2eba7829c0095bad` |
| apply test | `078d035b52d0652cc38f0ce778f6b8bcef5406ce466c6d8ff38de568d46586aa` |
| CA PEM | `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7` |
| handoff | `995dcdb2b47afd5cff106db6aff576260b5771efe2be555771f56916cda639e3` |
| unchanged bundle, 215925 bytes | `9402a949607a7856fcc97f8462f4acb0f23b395ebe12c375b24fd9b372b794ab` |

CA subject/issuer: Supabase Root 2021 CA. Valid until April 26 2031. DER fingerprint `807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa`. Local inspection confirms the pin and certificate metadata, not the production server's current certificate chain.

## Root-only operational gates remain

Record this approval and exact final fingerprint in the named one-shot waiver before execution. Recheck frozen fingerprints and fresh read-only production target, prerequisite/catalog/ledger absence, backup and traffic state immediately before the one-shot operation. The handoff's real provider login/certificate/catalog limitations remain: this reviewer made no remote requests. Refuse any failed gate or drift; never retry an uncertain COMMIT. Record the actual outcome and consume the waiver only on verified successful installation. Staging, release, full-E2E and provider QA remain separate gates.
