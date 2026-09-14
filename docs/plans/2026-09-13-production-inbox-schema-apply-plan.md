# Bounded production inbox schema apply proposal

Date: 2026-09-13. Candidate: `akhil/prp-472-inbox-unread`, SQL frozen at `542d11ca0`. Status: **root-reviewed proposal awaiting completed staging evidence and Akhil's additional production-scope authorization**. This planning subtask performed no remote database or Git mutation. The source migration files remain unchanged.

## Approval scope

Target only `qahnczmilgptcedaqype`. The six exact source migrations are:

| Version | Effect |
| --- | --- |
| `20260912210000` | Service-only atomic conversation house assignment and access revision. No listing/tag row changes during installation. |
| `20260912220000` | Shared reminder queue constraints, nullable phone/email changes, tour thread index, automation cutoff trigger, controls table, service functions and resolver replacement. Backfill must affect **zero rows**. |
| `20260912230000` | Remove the vendor directory's existing direct SELECT policy, preserving scoped server access. |
| `20260912233000` | Service-only atomic inbox folder functions. No existing messages changed during installation. |
| `20260913170000` | Conditional inbox source-read RPC. |
| `20260913173000` | Existing account-recovery guard/capture triggers on tour controls, including exact empty `tgattr` checks. |

The first four are older production gaps requiring the additional authorization described in the [prerequisite review](../security/2026-09-13-prp472-production-prerequisites-review.md). Authorization includes the private transaction/guard wrappers described below, particularly installing the exact recovery trigger block before the tour migration commits. It does not enable automations or authorize provider sends, real-message QA, locked-listing mutations, historical ledger repair, or account-recovery policy changes.

Suggested final scope question, after staging completion: “May I apply these six reviewed inbox schema migrations to production, including the four older house-assignment, tour-reminder, vendor-privacy and folder prerequisites, with a zero-row automation backfill and the recovery triggers installed atomically with tour controls, then finish the staged release?” Root should accompany this with the completed staging result and this reviewable plan, not ask prematurely.

## Concrete private artifacts

Directory `/private/tmp/axis-inbox-release/proposed-apply/` is mode 0700; SQL and manifests are mode 0600. `manifest.json` records each filename, source SHA-256, wrapper SHA-256, source preservation, baseline snapshot hash, and copied recovery-block hash. Source hashes match the prerequisite review and final correction handoff; final recovery source is `0848ed305b3fa742f1b16e75133931718c7c05b10f7b4df760d7ded2467d53a4`.

- Six timestamped SQL files are the proposed execution artifacts. Root copied them into the bounded `production-apply` scratch for the successful read-only dry run documented below. They have not been applied.
- `build-proposal.py` reconstructs wrappers locally from frozen source and actual production evidence. Do not regenerate against changed inputs without another review/hash comparison.
- `backup.sql` is the read-only, repeatable-read scoped backup query. It exports full real ledger, affected function definitions/ACLs, affected relation columns/constraints/indexes/triggers/policies, exact enabled automation rows, current reminders, and uncaptured controls holds. Capture directly to a private 0600 file with explicit target/time and SHA-256; do not print private row contents.
- `verify-local.mjs`, `local-verification.json`, and `local-run.log` preserve the isolated PGlite rehearsal.

The scoped backup makes affected existing schema and potentially affected rows recoverable. It is not a whole-project backup or a consistent snapshot of future concurrent application activity. No full-project restore or platform setting change is proposed. An empty enabled-row export is sufficient for this specific zero-row backfill only because the execution wrapper rechecks that bound under the held table lock.

## Wrapper behavior and review points

Every wrapper has one explicit transaction, `lock_timeout='5s'`, `statement_timeout='60s'`, and `idle_in_transaction_session_timeout='90s'`. No dependence on `PGOPTIONS` or Go driver environment behavior. For the two sources already containing BEGIN/COMMIT, the guard is inserted immediately after their existing BEGIN; no nested transaction is introduced. All original SQL bodies remain unchanged. The first four complete original file byte sequences are embedded unchanged.

Every wrapper locks the migration ledger, checks its original 212 rows against a deterministic digest over **version, name and recorded statements**, and checks exact count plus the expected already-applied release prefix. The MD5 guard is a drift comparator, not an authenticity claim; the retained artifacts use SHA-256. The expected prefix prevents arbitrary partial replay. New functions must be absent at their installation step. A changed baseline, extra migration, missing prerequisite, or unexpected catalog state aborts the current transaction.

Tour additionally holds ACCESS EXCLUSIVE locks on reminder and automation tables before checking the original constraints/indexes, resolver body/owner/ACL/config, original automation recovery triggers, column/table absence, reminder compatibility, zero enabled automation rows, and no uncaptured control delete holds. These locks remain through the unchanged source UPDATE and COMMIT. The wrapper therefore cannot pass a stale zero-row count while a concurrent writer enables an automation before the UPDATE. Existing recovery triggers are never disabled. A lock timeout stops the release; do not remove the bound or automatically retry.

Tour's wrapper also appends the **exact DO block** from the reviewed `173000` migration before COMMIT. This installs both recovery triggers with the new table/functions in the same transaction, avoiding an interval where the existing deployed app could create a control row without recovery capture. The later `173000` migration validates those exact triggers idempotently and receives its own normal ledger entry. This is the only additional substantive DDL in a wrapper; it changes installation timing, not trigger definition or recovery policy. Root must explicitly review this copied block and its manifest hash.

Vendor's wrapper locks the directory table, checks RLS is enabled and the exact prior policy set, then executes the unchanged policy drop. Source-read checks effective service UPDATE. Final recovery rechecks uncaptured holds, locks controls, and uses the source's exact trigger checks.

These six files are **not** one all-or-nothing batch. The CLI may commit earlier migrations before a later failure, and explicit source COMMIT may precede its ledger recording. A connection error after commit can therefore leave schema changed even if the ledger is missing that version. Stop and inspect actual ledger and catalog; do not replay, repair history, or run a generic pending push automatically.

## Rehearsal and final preflight

Local Node 22.23.0/PGlite verification exited 0. It copied the actual 212 ledger rows into an isolated in-memory database and exercised all six wrapper SQL files in order. It proved baseline digest agreement, zero-bound rejection with one enabled synthetic automation row, rollback before added columns/table, immediate installation of both recovery trigger shapes in the tour transaction, idempotent final trigger migration, final 218-row local ledger, vendor policy removal, service-only read RPC grants, and rejection of replay against an advanced release prefix.

The only local adapter excludes PGlite/PostgreSQL 18 `contype='n'` NOT NULL catalog rows from the constraint comparison. Production wrappers retain the complete original comparison. Recovery function stubs in this minimal parser/guard fixture do not certify lifecycle behavior; root's reviewed real-function rollback-only staging probe supplies that evidence. PGlite does not certify the Supabase Go CLI parser/managed-login transport. The transaction form follows existing source BEGIN/COMMIT and must remain unchanged through the CLI dry-run/apply.

Do not try to execute these production-absence guards on shared staging by suppressing checks or dropping existing schema. Staging already contains the four older migrations. Use the existing corrected rollback-only staging recovery probe and synthetic staged route/privacy/folder/read acceptance, plus the isolated baseline replay above. No production mailbox mutations as QA.

Before requesting final scope, root must finish candidate staging QA, capture and hash `backup.sql` output, confirm enabled automation export and uncaptured holds are empty, compare the fresh catalog/ledger with the reviewed evidence, and review these exact wrapper bytes. Fresh backup drift requires assessment before approval, not automatic regeneration. Confirm no concurrent deployment/schema work. The keeper remains linked to DEV; only the private actual-history scratch is linked to production.

## Authorized CLI apply and verification

Use the existing actual-history directory `/private/tmp/axis-inbox-release/production-apply`, containing only the 212 real remote ledger files. Assert its `supabase/.temp/project-ref` equals `qahnczmilgptcedaqype`. Copy only the six reviewed timestamped wrapper files into that scratch for the read-only dry run. The actual push without `--dry-run` requires the additional authorization. Preserve manifest and original source files separately; do not overwrite repository migrations or relink the keeper.

Use explicit cached Supabase 2.117.0, not PATH's 2.12.1:

```bash
/Users/akhilvemuri/.npm/_npx/6f1b058a4d9555af/node_modules/@supabase/cli-darwin-arm64/bin/supabase db push --workdir /private/tmp/axis-inbox-release/production-apply --linked --include-all --dry-run
```

The isolated directory is the exact allowlist. `--include-all` is necessary to include the four older missing timestamps behind real later production history; it must never be used against the unfiltered keeper migration directory. Dry-run must list exactly the six filenames in the manifest, in order. Do not use `--include-seed`, `--include-roles`, a manual SQL apply, or ledger repair. This is the repository's `db:push` CLI operation with an explicit bounded workdir. If the pinned CLI rejects the path or history, stop and investigate.

After successful dry-run and recorded approval, run the same command without `--dry-run`, retain its actual exit code and private log, and reread actual ledger/catalog immediately. Do not automatically retry a nonzero exit. Require original 212 rows unchanged plus exactly six new named rows; recorded statements should contain the reviewed wrapper commands/source bodies (CLI statement splitting may normalize separators). Verify function bodies and effective PUBLIC/anon/authenticated/service grants, valid constraints/index, nullable columns, zero backfill effect, unchanged unrelated policy/constraint/trigger state, vendor policy absence, RLS, and exact recovery trigger fields including `tgattr=''`. Compare reminder rows with the private backup, accounting only for separately evidenced ordinary concurrent writes.

Only after database and staged acceptance succeed should root finish the authorized `main -> staging -> production` release ladder and verify Vercel plus TestFlight. On a defect, preserve evidence and propose a bounded corrective migration. Do not automatically restore the vendor privacy leak, drop newly used schema, restore a broad database snapshot, or mutate customer records.

## Root review and preparation evidence

Root independently inspected all six wrapper guard sections and the tour wrapper's copied exact recovery block, and verified each source/wrapper SHA against the manifest. The first four whole source byte sequences are embedded unchanged; the new two retain their existing transaction boundaries with guards added after BEGIN. The copied recovery block makes the controls table guarded before the tour transaction commits. Timeouts, exact ledger prefix, zero enabled-row bound under table lock, catalog drift checks and stop-on-partial-failure handling are retained.

Actual production read-only scoped backup capture exited0. File `/private/tmp/axis-inbox-release/production-scoped-backup.json` mode0600, SHA `e3cbcc88988d6a287177c42994e18e20007b381f570c497b3584272c277d313c`. It contains212 ledger rows,21 reminder rows, zero enabled automation rows and zero uncaptured control holds. Root compared version/name/statements for every original ledger row with the prior inventory: exact equality.

Root copied the six hash-verified private wrappers into the isolated actual-history scratch and ran the exact pinned2.117.0 CLI command with `--dry-run`, exit0. It listed exactly the six manifest filenames in timestamp order, with no seeds or roles. Log `/private/tmp/axis-inbox-release/production-dry-run.log`. This operation did not apply migrations. The keeper remains linked to DEV. Completed staging QA and Akhil's additional production scope remain prerequisites for actual apply; repeat read-only preflight if time or other changes make this backup stale.
