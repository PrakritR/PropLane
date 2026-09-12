# PRP-473 resumed cycle: final reply guard and mixed ambiguity

Akhil explicitly authorized fixing the two remaining findings after the prior cycle stopped, then requested production shipping and the next backlog issues. This is a newly authorized feature cycle, not an unrequested third automatic correction. Use fresh Sol-medium with Terra/Luna, then fresh Astra review. Normal correction limits apply to this resumed cycle. No no-mistakes.

Worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`. Keeper: `akhil/backlog-repeat-issues`. Base/current HEAD: `0b6d56794407277761ad5f6c680a522e97db2e6d`. All prior PRP-473 changes are uncommitted and must be preserved. Root checkout has unrelated user edits. Copied `docs/agents/akhil-feature-cycle.md` is user-owned instruction context, not a new deliverable to commit.

## Evidence and scope

Read `2026-09-10-prp-473-review-3.md`, both correction-2 mandatory reports, correction-2 handoff, original plan and prior correction plans. Root re-ran the bugbot report's exact no-file Node22 reproduction at this resumed checkpoint, exit0: five separate changes after the guarded reread still return confirmed; two legacy plus one modern proposal still confirms modern. Exit0 here establishes reproduction of bad behavior. Tracked source/test fingerprint remains `d546f6d31d86d5c460f08eaece02bca2d5420e47bd0e7c4df450a72d14b1d079`, matching final review.

Root also re-opened the existing manager browser snapshot at the real dev tour detail, with the canonical resident fixture and persisted Sep17 window. The deterministic races cannot be induced reliably through ordinary UI clicking without synthetic provider input, so use the actual module with hermetic storage races for those regressions and real browser QA for connected tour/inbox behavior. Do not substitute `/demo`.

The previous Langfuse/Twilio correlation for the original messaging incident remains in the original plan/handoff: successful SMS-origin request trace `de38a267-97b4-4c4d-b5b1-4636e807e6d2`, observation `ed3c02e5-ee4e-4a42-ad91-9ebac64b4171`, no matching lifecycle outbox entries, and ordinary reply SID `SM65b91838c959f7af61bdd584262cbd70` delivered. The two new findings are code-level reply-state defects reproduced independently, not new carrier diagnoses. Never attribute them to a provider outage or claim a handset pass from mocks.

## Implementation decisions

### 1. Preserve repaired identity through final consumption

Keep the existing upgrade-only snapshot and bounded reread. Carry `LegacyRepairGuard` into the pending path and into both final planned/pending CAS mutation callbacks. Reuse `upgradedLegacySnapshotMatches`, not a second shortened field list. On every retry, compare the original record/event identity and complete snapshot before spending a SID or changing terminal status. Reject changed source inquiry, SMS origin, consent, conversation key, requested timestamp, owner, phone pair, window, row/proposal generation, version and status. Retain all existing active-tour/pending-kind checks. Do not mutate a different target simply because it now occupies the same singleton slot.

Both affirmative and planned alternate-time terminal updates must enforce the guard. Pending alternate-time behavior currently only delivers a manager follow-up and does not terminally update the inquiry; preserve that contract rather than inventing a new booking path. A rejected final CAS must never return confirmed or silently use the replacement row. Existing manager-notice failure and duplicate-SID behavior must remain truthful.

### 2. Resolve uniqueness across one complete candidate inventory

The existing modern-only count silently drops multiple legacy proposals. Build a shared scoped candidate inventory spanning planned and pending records, modern and legacy. Apply the existing owner, exact phone pair, active/pending state, window, version, generation and current eligibility requirements consistently before selecting a target. Resolve current legacy authority with the existing resolver, never by trusting a checkbox, label, `smsEligibility` supplied by the client, or inferred phone ownership. Unreadable authority must fail closed rather than remove a possible target and confirm another.

When multiple actionable candidates remain, use the existing ambiguity/follow-up result without confirming any row or repairing the whole inventory. When no unique target can be established safely, a conservative no-confirm result is acceptable; do not auto-pick modern, newest, first, or most recently repaired. A single authorized legacy candidate must retain its working upgrade-and-confirm path. Terminal, canceled, mismatched-owner/phone/work-number/window/generation candidates must not block an otherwise unique valid proposal.

Prefer a small internal shared candidate predicate/representation in the existing module over duplicating four divergent filters. Keep reads bounded to the already-loaded inventories and exact owner/phone scope. Eligibility resolver can materialize a scoped grant; do not create a separate policy or bulk backfill just to count candidates. If a read-only resolver option is genuinely needed, propose it to root before expanding source scope. No schema change, migration, new route, UI redesign, bulk repair or provider API is expected.

Integration clarification from root: if resolved authority returns a conversation key different from the stored legacy proposal, treat that as unresolved/no-confirm, not a definitive denial that removes the legacy candidate and permits a modern singleton. Canonical positive fixtures should match the actual legacy recorder's key derivation. Preserve the stored key through repair and consumption. The repaired target must also retain its original record id as well as event id; a same-id candidate in the other inventory is not interchangeable. Retry regressions must change only an omitted snapshot field while retaining id/version/generation/awaiting status, and must assert that the intended contested read actually occurred. A changed id or already-terminal replacement only exercises the older guard.

## File ownership

- Terra: `src/lib/tour-reschedule-sms-reply.server.ts` only for implementation; optional narrowly relevant invariant in `docs/agents/tours-scheduling.md` coordinated with Sol.
- Luna: regression tests in `tests/unit/tour-reschedule-sms-reply.test.ts`; may use a focused new test file if it makes the planned/pending matrix more reliable. Two swapped confirm/accept test descriptions in the lifecycle file may be corrected mechanically.
- Sol: integrate both results, inspect all actual diffs, run validation and browser QA, write handoff. No overlap with root's queue/readiness/private-account notes.

Capture the failing tests first. If concurrency slots force sequential delegation, run Luna's test design/red tests before Terra implementation. Do not reverse the dirty implementation back to HEAD to manufacture a red run.

## Regression matrix

1. Planned and pending legacy happy paths, including generationless historical pairs, still work.
2. For each inventory, change one omitted snapshot field at a time after successful upgrade and guarded reread but before final CAS. Advance the fake database token. Assert the exact adversarial read occurred, no final confirmation write/SID, and competitor state retained. Cover all five demonstrated fields, plus existing owner/phone/window/generation guards.
3. Repeat those races after a failed final CAS retry. Original snapshot must remain fixed. Add planned alternate-time final mutation coverage; manager-notice success cannot authorize a changed target.
4. Two legacy + one modern, one legacy + one modern, legacy-only ambiguity, and mixed planned/pending inventories, using distinct properties/future windows. Assert no proposal is confirmed; one existing ambiguity path or honest unavailable outcome, with failure preserving actionability.
5. Explicitly deny/exclude foreign owner, wrong phone/work number, canceled/terminal, obsolete-generation and invalid-window candidates. Include unreadable legacy eligibility alongside one modern match: no unsafe confirmation by dropping unknown candidates. Document the chosen safe behavior for a definitively ineligible legacy candidate.
6. Current modern YES, one eligible legacy YES, replay SID, repeated YES, A-to-B-to-A, legacy terminal retries, upgrade CAS race, post-upgrade retarget race, bounded recursion, pending YES never books, alternate-time notification failure, and all existing lifecycle consent/provenance tests stay green.
7. Use actual functions and the real active-tour helper. Mock persistence/provider boundaries, not the matcher under test. Where eligibility is mocked for race control, retain the existing actual-resolver lifecycle suite as the separate authority boundary proof.

## Verification and runtime

Use Node22.23.0 explicitly, 4GB heap, maxWorkers1 focused and maxWorkers2 full unit, one compiler at a time across all agents. `SMS_RUNTIME_ENABLED=0`, `SMS_OUTBOX_SCHEDULER_READY=0`. No real Twilio/Resend messages. Dev DB only `emstjswhotsnyksqhqyf`, guard hostname before cloud writes. Private role-verified sessions at `/Users/akhilvemuri/.local/share/proplane-codex/dev-test/`; canonical credentials `tests/fixtures/qa-accounts.mjs`. Never output/commit tokens or passwords.

Port3008 is pinned, root-owned server session51411 was left alive and the existing manager browser session `backlog` is still open. Coordinate exact server stop with root before build, then root restarts it. Use Playwright skill/wrapper. Refresh expired login state using canonical credentials, save privately mode600. Do not wipe/reseed shared fixtures or modify Morgan. The existing task-only resident event `80eb0801-755d-4cf8-be15-bff69eafb61c` may be inspected and safely rescheduled if fresh connected-path QA is needed; inspect its current generation/window first. Require real inbox sent result, durable exact message ID and recipient view, plus desktop/mobile and repeat/failure behavior. Existing positive proof is recorded in correction2 handoff/root verification, not a substitute for a changed-path regression.

Run new focused red/green tests, the prior 164-case affected set, relevant integration tests, then full unit/lint/tsc/build on stable final source. Report exact commands and numeric exits. Run graph hook and portable check, retaining the known CLI incompatibility honestly rather than generating legacy sidecars. Review the complete accumulated PRP-473 diff with fresh Astra and new dated security-review/bugbot reports after execution. Keep any new failures explicit.

## Shipping and next-issue constraints

Root fetched main/production read-only: both now `2d1353af42c3a652be6cf8a69640468b453f4cea`; `origin/staging` and remote keeper remain absent. New main has no direct current PRP473 changed-file overlap, but changed communication eligibility/contact and listing dependencies. Keep this fix on the agreed base until reviewed; no merge/rebase during dirty execution. New integrated source must be tested before any later release claim.

The requested production push cannot bypass root AGENTS: agents do not merge protected branches, staging QA is mandatory, and production data is never a testing target. Vercel skill's generic direct deploy is not an alternate shipping lane. Complete fixes and keeper review, then root may commit/push the approved keeper fast-forward only. Captain integration, restoring staging and its QA, production deployment/TestFlight verification, and a designated handset remain separate unresolved shipping prerequisites. Do not silently start later issue implementation before the requested shipping checkpoint is reconciled; read-only planning can continue.

Leave `docs/plans/2026-09-10-prp-473-resumed-handoff.md` with source scope, test results, fresh QA evidence, limitations, and a fresh Astra review prompt. Do not commit/push/PR/promote or update trackers from the execution phase.
