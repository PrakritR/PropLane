# Production migration apply correction 1 handoff

Date: September 11, 2026. Outcome: **MATERIAL PLANNING BLOCKER**.

Plan: `docs/plans/2026-09-11-production-migration-apply-correction-1.md`.
Root addendum:
`docs/plans/2026-09-11-production-migration-apply-correction-1-root-addendum.md`.
Original review:
`docs/plans/2026-09-11-production-migration-apply-review.md` remains unchanged
and authoritative. The initial apply candidate remains frozen and rejected.

Repository:
`/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`.
Keeper: `akhil/backlog-repeat-issues`.
Starting and current HEAD:
`10962d8f3734b8424a98d4fa910fcd561943e60a`.

The named waiver `2026-09-11-production-recovery-schema` remains **SCOPE
APPROVED BY AKHIL - APPLY IMPLEMENTATION REVIEW PENDING**. It was not approved
for execution, consumed, or amended by this correction session.

## Blocking decision

Correction implementation stopped before source changes because the exact
pinned write mechanism cannot meet the approved TLS contract.

The approved operation requires all of the following at once:

- pinned `supabase@2.117.0`;
- exact `--project-ref qahnczmilgptcedaqype` linked targeting;
- the unchanged one-migration atomic bundle;
- `--skip-vault`, no roles, and no seed;
- certificate-chain and hostname verification using the pinned Supabase Root
  2021 CA on the database socket that performs selection and mutation.

Pinned CLI tag `v2.117.0` resolves to upstream commit
`21db855916f2c2b12f61cde923a27094b8528b23`. Its linked-project resolver builds
the reachable direct connection with only `host`, `port`, `user`, `password`,
and `database` in
`apps/cli/src/command-internal/legacy-db-config.layer.ts:356-371`. It supplies
neither `sslmode` nor `sslrootcert`. The driver maps unset remote SSL mode to
`rejectUnauthorized: false` in
`apps/cli/src/command-internal/legacy-db-connection.sql-pg.layer.ts:503-508`.

The same CLI implements correct chain and hostname verification when
`sslmode=verify-full` and `sslrootcert` reach its connection-string parser.
That parser is used by `--db-url` and by a possible pooler URL, but the normal
reachable direct linked branch bypasses it. A pooler fallback therefore cannot
guarantee the property for the exact project-ref operation.

`--db-url` is not a compatible escape hatch. The pinned handler requires it to
be a non-linked target and rejects its combination with `--project-ref` at
`apps/cli/src/commands/db/push/push.handler.ts:50-75`. The installed binary
reproduced the rejection before network activity:

```text
--project-ref only applies when targeting the linked project; use it with
--linked (not --local or --db-url)
```

Using `--db-url`, direct SQL, a proxy, a patched CLI, another CLI version, a
different apply mechanism, a forced alternate host, or a changed waiver was
explicitly outside this correction authority. A verified Node read before or
after the push cannot authenticate the separate CLI write socket. Management
API trust and endpoint binding also do not configure PostgreSQL socket trust.

## Delegate evidence

The collaboration service thread limit was handled through the required fresh
isolated Codex CLI transport. Exact models and medium reasoning were retained.

- Fresh GPT-5.6 Terra, session
  `01a08eaa-205f-77d3-b71a-7367d881415d`, exit 0, read-only assignment. Terra
  independently concluded **MATERIAL PLANNING BLOCKER** after tracing the exact
  tag and installed binary. Its disposable actual-CLI `--db-url` control probe
  returned exit 0 with the trusted CA and matching `localhost`, exit 1 with an
  untrusted CA, and exit 1 for the `127.0.0.1` hostname mismatch. PostgreSQL
  shutdown exited 0 and temporary probe artifacts were moved to Trash. This
  proves the CLI's verification code works when a connection string reaches it,
  not that the forbidden alternate target is acceptable.
- Fresh GPT-5.6 Luna, session
  `01a08eaa-1f5a-7f71-b721-68b0e134bbf7`, exit 0, read-only assignment. Luna
  independently designed boundary coverage for every remaining review finding.
  It confirmed that the concurrent-bucket harness must identify the exact
  task-owned backend using a unique `application_name` and dedicated advisory
  key, monitor child exit while awaiting the barrier, release and await the same
  child, and terminate only that child before cluster shutdown. Luna also
  identified fail-closed duplicate historical-name coverage as an additional
  ledger case for the eventual revised plan.

The durable delegate prompts are:

- `docs/plans/2026-09-11-production-migration-apply-correction-1-terra-prompt.md`
  - SHA-256
    `53dac28f787dceb8a3505a0501a16c126626ec8f8d4664c982179ded6a310455`
- `docs/plans/2026-09-11-production-migration-apply-correction-1-luna-prompt.md`
  - SHA-256
    `8a7194832eda6a79a838abdf631121cbd480466b5a97dcaff52487ec26a63f52`

Neither delegate edited repository implementation files or contacted a remote
database/provider.

## Frozen candidate and immutable fingerprints

No reviewed candidate implementation file was changed in this correction.

- Approved bundle: 215925 bytes, SHA-256
  `9402a949607a7856fcc97f8462f4acb0f23b395ebe12c375b24fd9b372b794ab`.
- Rejected apply entrypoint:
  `c8226a43f34dc139bb2c2e410a9cc825befeee3b968011606d99cec00b2c29e3`.
- Rejected local rehearsal:
  `66c15b125e1dcd2e59d8f954e314160adab8e049030a10e0fd4fcf64f4f2eacc`.
- Public CA PEM:
  `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7`.
- Rejected apply test:
  `13858753eccf2b6f16575bb3bb4f67370bb7193e6ee51bf25fd5403b63eab79a`.
- Installed Supabase 2.117.0 binary:
  `c2ca0770b4634e85a01254ffdfda1999063e5d424f41dc345839e62171d8bb4b`.

The twelve source hashes were freshly revalidated by
`reviewedMigrationManifest()`:

| Source | SHA-256 |
| --- | --- |
| `20260907130000_webhook_subscriptions.sql` | `61d2d745e479d2d54eac4222be9ff14f4e633c35114da7fcda46af201e90ddec` |
| `20260907214100_preserve_resident_financial_history.sql` | `af7ae6034951d0d11f3de5012f5c30d6d6ecc8b2009ddf8979a66717d6602833` |
| `20260907221500_preserve_shared_vendor_financial_history.sql` | `02db0308873dd50bd166316cfdea7b8d6c6493e9589e403d0247acc89d54dd10` |
| `20260907223000_account_attachment_references.sql` | `57df02789b83ac2331bf8d86f00f1994b41910169dd22b15e8626317a8b90b14` |
| `20260907224000_account_recovery_shared_retention.sql` | `8f5dec609a2a010cca30b468aa58b29d14442649b129f3a9c99bbb2467cb8440` |
| `20260907224500_account_recovery_snapshot.sql` | `4038e16e71e33294bb74a178c2385ee46bbf04ff375e4a1c084a305d9ee8c11b` |
| `20260907225000_account_recovery_identity_patches.sql` | `75a62df92340df4985f8f8b762e05db4ea68c4c3b51ff400464afa7ee81aaf68` |
| `20260907225500_account_recovery_capture.sql` | `671db1ea2ae46a7ad0b45c85185e30e80998ed2c0a611910d848a3af668a3e58` |
| `20260907230000_account_recovery_object_generations.sql` | `2d81ec38298e26f54f61736646ea58e803246c7cd38599bcbc91611de4f0ddcd` |
| `20260907231000_account_recovery_financial_access_keys.sql` | `d34d9450af3861be3a3216da423c38d62cd39ab1a83b03ba713832bca37af2fa` |
| `20260907232000_account_recovery_restore.sql` | `4964674ee7c106a092f3015507617f9a6dc21406d79c033d9db0de6dfc304826` |
| `20260907233000_account_recovery_finish_archival.sql` | `3431e5f0fe8051af1889e5bf4ed493fcd7334374f09372f6c15091066927efd3` |

## Commands and outcomes

All local Node commands used
`/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin` first on PATH.

- Keeper and HEAD verification: exit 0, exact branch and HEAD above.
- Required instruction, plan, evidence, waiver, Graphify skill, prerequisite,
  database-environment, ship-gate, and production-lock reads: exit 0. Both
  `.graphify/graph.json` and `graphify-out/graph.json` were absent.
- `supabase --version`: exit 0, `2.117.0`.
- `supabase db push --help`: exit 0, no linked-target TLS or CA flag.
- Read-only shallow clone of tag `v2.117.0` and source trace: exit 0, commit
  `21db855916f2c2b12f61cde923a27094b8528b23`.
- Local actual-binary target conflict probe combining exact `--project-ref`
  with a synthetic loopback `--db-url?...sslmode=verify-full`: exit 1 with
  `LegacyDbPushTargetFlagsError`; no connection was attempted.
- Terra actual pinned CLI TLS controls: trusted/matching exit 0; wrong CA exit
  1; hostname mismatch exit 1; local PostgreSQL shutdown exit 0.
- Bundle/source fingerprint command: exit 0, exact bytes and hashes above.
- `node --check scripts/prepare-20260911-production-migrations.mjs`: exit 0.
- `git diff --check`: exit 0. Each of this session's three new documentation
  files was also checked with `git diff --no-index --check /dev/null <file>`;
  each returned the expected new-file diff status 1 with no whitespace-error
  output.
- `npx graphify hook-rebuild`: exit 1, `npm error could not determine
  executable to run`. No graph exists and no graph freshness is claimed.
- No focused unit, lint, broad suite, or local bundle rehearsal was run after
  the blocker. There was no correction implementation to validate. Root's
  earlier 1378-file / 9681-test result remains prior rejected-candidate
  evidence, not evidence for a corrected candidate. Root's typecheck result
  remains outside this handoff.

## Files changed by this correction session

- `docs/plans/2026-09-11-production-migration-apply-correction-1-terra-prompt.md`
- `docs/plans/2026-09-11-production-migration-apply-correction-1-luna-prompt.md`
- this blocker handoff

Main application source, dependencies, historical migrations, approved bundle
builder, rejected apply implementation, rejected apply tests, rejected local
rehearsal, original review, root evidence, and named waiver were not changed.
Unrelated dirty and untracked files remain user-owned and untouched.

## Unresolved findings and risks

All six original review findings remain unresolved because R2 is an
architecture-level prerequisite to a shippable correction. In particular:

- inherited management endpoint/project configuration still requires strict
  isolation before authentication;
- the CLI write socket remains unverified;
- asynchronous pg and spoofed-message redaction boundaries remain open;
- auxiliary ledger, function, trigger, FK, and historical-ledger postconditions
  remain incomplete;
- dry-run parsing still accepts nested diagnostic lookalikes;
- unknown push completion can still be misclassified as rolled back;
- root's latest concurrent-bucket rehearsal still exits 1 before reaching its
  intended barrier and lacks exact child/backend lifecycle coordination.

No production or staging database connection, real `--preflight`, real
`--apply`, credential acquisition, provider/account operation, Vercel/GitHub
operation, dependency change, source migration change, commit, push, stage,
merge, seed, role apply, or no-mistakes command occurred.

## Fresh Astra rereview prompt

Fresh GPT-6 Astra reviewer: read `AGENTS.md`, Akhil's developer and
feature-cycle instructions, the feature-cycle and Graphify skills, the original
apply plan/handoff/review, correction-1 plan, root addendum/evidence, named
waiver, both delegate prompts, and this handoff. Independently inspect pinned
Supabase CLI 2.117.0 tag commit
`21db855916f2c2b12f61cde923a27094b8528b23` and installed binary SHA-256
`c2ca0770b4634e85a01254ffdfda1999063e5d424f41dc345839e62171d8bb4b`.
Confirm or refute the blocker: exact `--project-ref` linked targeting can select
a reachable direct connection without `sslmode`/`sslrootcert`, which maps to
`rejectUnauthorized:false`; the supported verified `--db-url` path is mutually
exclusive with `--project-ref` and outside the approved mechanism. Use only
local disposable TLS/PostgreSQL and read-only source/binary inspection. Do not
contact any remote database/provider, acquire credentials, run preflight/apply,
edit the waiver or migrations, substitute another mechanism/version, approve
or consume the waiver, commit/push/promote, or run no-mistakes. Review only the
three documentation files created in this correction session plus immutable
fingerprints. Record an independent verdict with severity and exact evidence.
If the blocker stands, return it to root for a new planning decision rather
than requesting correction implementation under the current contract.
