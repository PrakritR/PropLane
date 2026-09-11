# Verified transport: root operational evidence

Turn began September 11 2026 at 06:14:49 UTC. Akhil approved the transport
amendment to named waiver 2026-09-11-production-recovery-schema and requested
one more review under five minutes before migration and promotion work.

Initial bounded Astra re-review completed by 06:17:19 UTC. Existing candidate
remains rejected; the six recorded findings were not fixed between turns.
Root recorded the approved verified-pg transport replacement plan and launched
fresh Sol-medium execution with Terra/Luna delegates. Final independent review
will have a 240-second limit, with unresolved findings failing closed.

## Fresh read-only release checks

- Git remote refs, exit 0: keeper 10962d8f3734b8424a98d4fa910fcd561943e60a;
  main/staging 8ce3868b4e5775661956c6c3f36fcb146bfa931a; production
  2d1353af42c3a652be6cf8a69640468b453f4cea.
- Supabase 2.117.0 backup listing, exit 0: latest physical backup 1635565372,
  COMPLETED, 2026-09-10T13:20:44.705Z; PITR disabled, WAL-G enabled. This is
  provider-reported completion, not a performed restore test. No backup data
  was copied or restored.
- Existing Vercel proplane deployment list, exit 0: latest production READY
  dpl_FqzK3oKWGp5cX78haCY1BAh1Zr7T at 2d1353af. Latest listed staging READY
  dpl_DHFznkJpSYESz7pKeXzVrvtoDgUs at 0b6d56794407277761ad5f6c680a522e97db2e6d.
  The latest staging Git ref is not the currently listed staging deployment.
  No deployment, alias, project setting, Git ref or environment was changed.

Earlier twelve-source production absence, five newer missing migrations,
historical identity conflicts and traffic snapshots are PRIOR evidence in
production-migration-apply-root-evidence.md, not freshly revalidated here yet.
The new secure preflight and operational readback must refresh relevant live
state immediately before apply. The twelve-source waiver does not include
the five newer migrations or authorize production application test writes.

Prior full unit 1378 files / 9681 tests and typecheck passed. Those are not new
replacement-runner results. The old concurrent-bucket rehearsal failed and
must be corrected/replaced by a meaningful passing new-runner rehearsal.

## Non-mutating integration preview

`git merge-tree --write-tree --name-only HEAD origin/main` exited 1 with one
content conflict: `src/lib/sms/owner-sms-dispatcher.server.ts`. It created only
the synthetic Git result object, not an index/worktree/branch merge. The newer
main billing changes and keeper SMS provenance fixes must both survive eventual
integration. No app source or branch was changed during this preview.

## Independent source checks during implementation

- Root imported `buildAtomicBundle()` from the replacement runner and computed
  its digest: exit 0, 215925 bytes,
  `9402a949607a7856fcc97f8462f4acb0f23b395ebe12c375b24fd9b372b794ab`.
- Root compared every `reviewedMigrationManifest()` source digest with
  `git show origin/staging:supabase/migrations/<file>`: exit 0, all twelve
  byte-identical. This checks the fetched staging ref, not its live database.
- Sol has split Terra's real PostgreSQL/TLS rehearsal from Luna's unit tests.
  Runner implementation is still mutable until the final handoff. These source
  checks are not final independent approval or proof of runner execution.

## Final approval and production execution

Fresh Astra review approved the frozen replacement before the 06:52:30 UTC
deadline. It independently reran the 39 focused tests and actual new-runner
PostgreSQL/TLS rehearsal, lint, syntax, source and fingerprint checks, all exit
0. Root reread the complete review and recorded its approval and the final
runner SHA-256 in the named waiver before any operation.

Root's fresh read-only backup listing again exited 0, with completed backup
1635565372 unchanged. Remote references were unchanged. Root independently
rechecked all five frozen implementation/test/certificate hashes, all matching.

The acknowledged production `--preflight` exited 0: migrationCount 12,
ledgerRows 163, prerequisitesMissing 0, targetObjectsAbsent true, five other
client sessions, zero active sessions, zero long transactions and zero lock
waiters. The real provider credential acquisition and verified TLS path worked.

Root then invoked the acknowledged `--apply` exactly once. It exited 0 by
2026-09-11 06:53:10 UTC, returning `success`, migrationCount 12. Success includes
the runner's confirmed COMMIT and exact ledger/catalog verification on a fresh
verified connection. The named one-shot waiver is **consumed**. No retry,
application/provider action, protected listing write, other migration or
application promotion occurred.

## Remaining release gates

`npm run ship:preflight` exited 0 (11 structural checks, four warnings), with
database URL and Langfuse regression credentials deliberately unavailable to
this command. It did NOT verify migration parity or invoke provider regression.
Its missing-variable messages describe the local shell, not a diagnosed Vercel
production outage. No production environment file was created or loaded.

The following remain outside the consumed waiver:

- Five newer communication-billing migrations on main/staging, last observed
  absent from both databases: 20260910140000, 20260910160000, 20260910170000,
  20260910180000 and 20260910190000. They require separate bounded production
  approval, including the existing-manager preference backfill in the first.
- Historical migration-parity reconciliation, without guessed equivalence or
  ledger repair.
- Integrating newer main on the keeper while preserving both PRP-473 SMS
  provenance guards and the new wallet/campaign-budget behavior in the single
  dispatcher conflict.
- An actual staging deployment of the integrated candidate, full E2E and
  real seeded-data browser QA, then designated-phone Twilio/Langfuse evidence.
- Only after those gates, the authorized fast-forward production promotion and
  verification of Vercel plus iOS/TestFlight distribution.

Production schema recovery is complete. The PRP-473 application fix is not yet
on production, and PRP-475/476 execution has not started. All pre-existing local
backlog/investigation notes and copied workflow files remain preserved.
