# Production migration preparation: correction cycle 1

Owner: fresh Sol-medium implementation manager, with the Akhil feature-cycle
delegation and a subsequent fresh Astra review. Starting keeper and HEAD remain
`akhil/backlog-repeat-issues` at
`daddb7b5de9910ed3f140ff7d9a63beef48b0547` plus the reviewed uncommitted diff.

Read the original rollout plan, handoff, prerequisites, draft waiver, and
`2026-09-10-production-migration-rollout-review.md`. Address only its two
findings. This is the first of at most two correction cycles.

## Required changes

1. Add a transaction-time first-install guard to the generated bundle that
   refuses any existing `storage.buckets` row with id `account-recovery` before
   the 12 sources run. Do not overwrite a bucket or alter historical migration
   files. Keep the observed prerequisite relation check ahead of this query.
   Root clarification during execution: also verify the post-source bucket
   exists and is private with a FOR UPDATE row lock before ledger recording.
   An absence read alone cannot prevent another writer from creating a public
   bucket before the original ON CONFLICT DO NOTHING statement. The postcondition
   must reject that state and hold the row stable through commit. Add a local
   injected-public-bucket case after preflight to cover this same P1 boundary.
2. Extend the disposable local PostgreSQL rehearsal with preexisting public and
   private recovery-bucket cases. Each must fail for the new guard's specific
   error, preserve that fixture row exactly, and leave no installed source
   objects or original/bundle ledger rows. Remove only the local fixture row
   between cases. Successful clean installation must assert `public=false`.
3. Make every existing deliberate CLI failure verify its intended SQLSTATE or
   diagnostic: historical sentinel, advisory contention, and each of the three
   division-by-zero injection positions. Reject unrelated subprocess failures.
   Preserve real CLI execution and the rollback assertions. Keep assertions
   narrow enough that they cannot match source text alone in unrelated errors.
4. Update the handoff with changed bundle bytes/SHA-256, exact commands/results,
   corrected safety behavior, and remaining release gates. Keep the waiver
   DRAFT. Update any existing digest evidence affected by the guard.

## Scope and validation

Expected files: preparation script, its focused unit test, local rehearsal,
and phase docs. The dependency fixture may change only if necessary. No app
runtime, `supabase/migrations`, dependencies, checker identity policy,
production/staging access or writes, protected pushes, waiver approval,
provider calls, or no-mistakes.

Run the focused parity/preparation/recovery tests, the actual Node 22 local
rehearsal with pinned `npx -y supabase@2.117.0`, scoped lint, and
`git diff --check`. Use existing full-suite evidence unless a new change or
failure justifies repeating it. Preserve/identify only task-owned local
clusters; stop them cleanly and record evidence. Follow the repository graph
refresh requirement and report the already-known tooling limitation honestly.

Return a durable correction handoff and request fresh Astra review. Do not
declare production apply or release readiness as part of this correction.
