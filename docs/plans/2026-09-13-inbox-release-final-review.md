# Inbox release final Astra review

Date: 2026-09-13. Verdict: **CHANGES REQUIRED. RELEASE VALIDATION PENDING.**

## Reviewed candidate

Keeper `akhil/prp-472-inbox-unread`, HEAD `276e1e40a0a9f3f63bee3a87b4fabbbd9edaf54b` plus frozen working delta, relative to base `75d711053085e340072c605bcb96eaa9416ef87e`. Root's exact33-file source freeze aggregate: `8c05f33c0822e68e81b7e24e4ae8ec90aa7f43fae21855dea7fb265c6928e0aa`. Scope covers the30 tracked changed source/test/migration paths, additive recovery migration/test, and rollback-only probe. No source, Git, browser, server or database mutation by this reviewer. Only review/plan artifacts and private reproduction files were written.

Read repository/Akhil contracts, canonical feature cycle, Communication/Tours notes, PRP470/472 and release-followup plans, final Sol handoffs, ship gate and root validation. Graph query was attempted and exited1 because the worktree graph is absent; review used authoritative area notes and direct diff/source inspection. The older four production prerequisites are separately assessed in `docs/security/2026-09-13-prp472-production-prerequisites-review.md`; this review grants no additional production mutation authority.

## Findings

### R1 - P2: Retry cannot recover an initial same-viewer SMS authorization refusal

`src/components/portal/pro-unified-inbox.tsx:939` wires Retry directly to `loadInitialList`. A prior current-viewer401/403 sets `smsPollHaltedRef` at line356; `loadSms` then returns false at line345 before issuing another request. The Retry button redraws the same error indefinitely, even when access has recovered. Since initial readiness requires SMS success, the entire conversation list remains hidden. The prior retry action explicitly reset the latch.

Fresh reviewer reproduced with the actual mounted component and actual Retry button: initial SMS401, same viewer, next fetch prepared to return200. Private exact-file test exit1: expected2 SMS calls, received1; error remains. Artifact `/private/tmp/axis-inbox-release/final-review-probe/retry.test.tsx`, output `result.log`. Test was adapted from existing readiness coverage and used real SMS client/coalescer. A preliminary config invocation enumerated unrelated skipped tests due merged include arrays and was stopped with exit130; only the subsequent exact-file invocation is reproduction evidence.

Add an explicit retry wrapper that resets latch ref/state and returns `loadInitialList()`. Preserve automatic polling refusal, viewer generations and unforced coalescing. Retain401/403 recovery, repeated refusal/no automatic loop and stale-viewer regressions.

### R2 - P2: exact recovery trigger validation accepts column-limited updates

`supabase/migrations/20260913173000_tour_followup_recovery_guards.sql:40` validates event mask/function and other flags, but omits `pg_trigger.tgattr`. A same-name `BEFORE INSERT OR UPDATE OF archived OR DELETE` trigger passes every current check while other-column updates skip the guard. The rollback probe repeats the omission at `scripts/testing/tour-followup-recovery-guards-probe.sql:37`.

Independent security reviewer executed the actual migration in PGlite and confirmed silent acceptance with `tgtype=31`, `tgattr=3`, exit0. This is a confirmed drift-handling gap, not evidence that staging or production currently contains the narrowed trigger; root's catalog says no custom controls triggers. Reject a nonempty column vector and assert empty tgattr in probe/output and retained idempotence tests. Add transactional rejection coverage with the narrowed actual-function trigger. See `docs/security/2026-09-13-inbox-release-security-review.md`.

Both findings and bounded execution instructions are in `docs/plans/2026-09-13-inbox-release-final-correction-plan.md`.

## Other reviewed contracts

- The failed-envelope correction now classifies `failed` results as unknown, withdrawing token-owned compatible overlays without replaying stale captured unread. Valid successful siblings settle independently. Controller and reconciler are tested together, including both settlement orders and changed observations. No further concrete unread-reconciliation blocker found in this pass.
- The markRead route resolves authenticated edit ownership before all writes, rejects incomplete/foreign source batches, and calls a service-only security-invoker RPC. RPC compares exact identity, revision and JSON before changing only unread/revision. Response-only observations are stripped from generic persistence. No broadened client grant or raw model write path found.
- Explicit native bindings survive collapse and constrain selected/displayed/acknowledged SMS sources. Native receipts remain viewer keyed, bounded and independently retryable; hidden controlled opens defer. Root/Sol's real DEV evidence covers mixed content preservation, first failure/reopen, successful-read/later-failure and mounted storage recovery. No new navigation, route, upload or native shell contract was introduced; the existing deployed shared portal is used on native.
- Initial list readiness waits for current-viewer inbox, application membership and enabled SMS; disabled SMS remains independent. Accessible loading status, reduced-motion skeleton and shared promise-owned Retry Button follow existing UI patterns. Current bug R1 is the outstanding recovery edge.
- Cache changes distinguish successful server hydration from local writes and protect stale viewer completion, including A-B-A. Direct-send forced refresh uses the existing coalescer; no extra polling or broad prefetch was introduced. No additional concrete cache/performance blocker found.
- Recovery wiring is additive and transactional and uses the existing lifecycle. Existing grants/RLS/functions/manifests remain unchanged. The root's staging double-install/lifecycle rollback rehearsal passed without leakage, but must be refreshed for corrected migration/probe bytes.

## Validation and release status

Accepted as prior evidence, not commands rerun by this reviewer: Sol focused8files74tests exit0; recovery3files40tests exit0; earlier integrated browser QA on real DEV data and narrow retained actual controller/reconciler regressions after the failed-envelope correction. Root validation artifact records real staging rollback-only double install, held-update denial, delete capture, finalization and zero leakage, exit0 with pre/post catalog equality. Root also reports no existing uncaptured controls holds.

At review handoff root's full unit run is still pending on the old freeze; final lint/build, required local portal E2E, corrected-source validation, new fresh review, final staging deployment and feature QA, preflight and release verification remain pending. No green release, production approval or completed ship is claimed. Future source changes invalidate this freeze and require affected re-review. No no-mistakes was invoked.
