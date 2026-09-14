# Inbox release Bugbot review

Date: 2026-09-13. Verdict: **CHANGES REQUIRED; VALIDATION PENDING.**

This dated artifact retains the mandatory branch-change bug review separately from security review. Per root delegation, the fresh Astra final-review subagent performed this Bugbot review; no separate hosted Bugbot service or script was claimed.

Reviewed base `75d711053085e340072c605bcb96eaa9416ef87e`, keeper `akhil/prp-472-inbox-unread`, HEAD `276e1e40a0a9f3f63bee3a87b4fabbbd9edaf54b` plus33-file frozen working source delta aggregate `8c05f33c0822e68e81b7e24e4ae8ec90aa7f43fae21855dea7fb265c6928e0aa`. Includes inbox loading/unread changes and additive recovery trigger migration/test/probe. Broader historical production prerequisites retain their separate prospective review.

## Findings

1. **P2 R1, `src/components/portal/pro-unified-inbox.tsx:939`: explicit Retry never clears an SMS401/403 polling latch.** After access recovers for the same viewer, clicking Retry performs no second SMS fetch and leaves every conversation hidden behind the initial error. Actual mounted reproduction failed as expected, exact-file Vitest exit1, expected calls2/received1. Private reproduction and result: `/private/tmp/axis-inbox-release/final-review-probe/`. Fix only the explicit action to clear ref/state and return the initial loader promise; retain automatic refusal and old-viewer guards. Add401/403, repeated-refusal/no-loop behavioral tests.
2. **P2 R2, `supabase/migrations/20260913173000_tour_followup_recovery_guards.sql:40`: existing column-limited write trigger silently accepted.** The exactness check omits tgattr, so UPDATE OF archived passes event-mask validation while leaving other updates unguarded. Independent security reviewer confirmed with actual migration/PGlite, exit0, tgtype31/tgattr3. Add empty-tgattr validation to migration and probe, plus executable transactional drift rejection and normal-idempotence assertions.

No new Critical/High issue found in this pass. Neither P2 finding is resolved on the reviewed freeze. Correction plan: `docs/plans/2026-09-13-inbox-release-final-correction-plan.md`. Full reasoning and contract coverage: `docs/plans/2026-09-13-inbox-release-final-review.md`. Independent security: `docs/security/2026-09-13-inbox-release-security-review.md`.

## Evidence and remaining gates

Reviewed real controller/reconciler regression coverage, mounted SMS receipt recovery tests, route/RPC exact compare and ownership boundaries, initial-loading and viewer-isolation behavior, source binding and timeline projection, cache/coalescing changes, and recovery lifecycle SQL/probe. Sol focused8files74tests and recovery3files40tests exited0; root's actual staging rollback-only lifecycle rehearsal exited0 with zero leakage/pre-post catalog equality. These results predate the two corrections requested here and do not validate future edits.

Root full unit is pending on the prior freeze at handoff; lint/build, required local portal E2E, corrected-source focused checks, re-review, staging QA and release verification remain pending. Re-review affected changes before landing. No source/Git/browser/server/DB mutation or production authorization claim by reviewer. No no-mistakes.
