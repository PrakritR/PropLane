# PRP-473 correction 1 bugbot review

Reviewed 2026-09-10 in the pool worktree, keeper `akhil/backlog-repeat-issues`, base/current HEAD `0b6d56794407277761ad5f6c680a522e97db2e6d`. Findings apply to the current uncommitted PRP-473 implementation, including the untracked resolver and lifecycle regression. This reviewer changed only this report. No source edits, external sends, database writes, compiler suites, protected-branch operations, or no-mistakes pipeline were performed.

## P1 - Actual planned-tour changes discard the owner required by all notification paths

Location: `src/lib/tour-planned-change.server.ts:47`, with cancel delivery at line 203 and reschedule delivery at line 308. The shared projection includes guest identity, property and consent provenance but omits `managerUserId`. Neither actual notification call supplies the owner in its window. The owner was already resolved and authorized by `loadOwnedPlannedTour` and remains available on the persisted event.

Consequences at the actual delivery boundary:

- `notifyTenantTourChanged` resolves an empty manager id at `src/lib/tour-notification-delivery.server.ts:743`. Even a guest with explicit opt-in or valid conversation evidence receives `invalid_sms_scope` from the real resolver (`src/lib/sms/tour-sms-eligibility.server.ts:131`). No SMS is accepted and no actionable reschedule reply proposal is recorded.
- The canonical inbox append is never attempted: `resolveTourManagerIdentity` returns null for the empty id at delivery line 54, and line 820 requires a manager identity before appending.
- `buildReplyAddress` receives the empty id at delivery line 757 and returns null even with valid reply configuration, since its sender must be a UUID. Consequently planned change emails cannot use the signed manager reply path introduced by this correction.

The calendar mutation can still return `ok:true`, with a failed `guestNotification`. The correction handoff's real browser fixture explicitly reports that its PropLane inbox notification was not saved. That observation is consistent with this defect, rather than proof that the communication flow passed.

The projection omission predates this diff; it is nevertheless a blocker for the requested planned-tour SMS and truthful reply-path acceptance. The correction modified this projection to preserve origin and must carry its already-authorized owner as well. Do not substitute the actor id, since an admin actor can operate on another manager's event.

Independent reproduction: a `node` heredoc used TypeScript `transpileModule` and `vm.runInNewContext` to execute the actual current `reschedulePlannedTour` and `cancelPlannedTour` modules. Only external dependencies/storage were stubbed; notification arguments were captured and passed to the actual current `resolveTourSmsEligibility` module with explicit opt-in. The fake DB throws if the eligibility resolver attempts any database access. Both mutation calls succeeded and the following assertions passed:

```json
{"kind":"rescheduled","persistedOwner":"manager-1","projectedOwner":null,"windowOwner":null,"eligibility":{"eligible":false,"reason":"invalid_sms_scope"}}
{"kind":"canceled","persistedOwner":"manager-1","projectedOwner":null,"windowOwner":null,"eligibility":{"eligible":false,"reason":"invalid_sms_scope"}}
```

Command exit: 0. Runtime: the shell's `node --version` reported `v23.7.0`. This was an isolated branch-behavior probe, not a supported-Node application gate or provider integration test.

Required regression: invoke the actual planned mutation caller with the real notifier and real eligibility resolver, mocking provider and persistence boundaries. Check both a positive eligible SMS guest and a non-SMS/no-opt-in guest; assert canonical inbox persistence and signed Reply-To when configured. Cover cancellation as well as reschedule. The current `tests/unit/tour-lifecycle-sms-provenance.test.ts:120` manually reconstructs the inquiry with `managerUserId`, and line 131 also supplies the window owner, bypassing the faulty production projection. Its passing negative test cannot establish that the positive path works.

## Other correction findings and resolutions

- Consent provenance is now present in both confirmation projections and the planned-event notification projection. The original provenance finding is resolved at those data boundaries. The original report's asserted concrete unwanted send through planned changes was stronger than the caller evidence supported: the independent missing-owner defect prevents all such SMS. Both conditions must be tested together after the owner is repaired.
- START-derived and inbound-derived grants now retain derivation evidence and the original source timestamp; retry and the exact five-purpose dispatcher gate revalidate current source authority. The source inspection supports resolution of the original revocation finding. This reviewer did not independently rerun the provider-mock suite.
- Legacy compatibility is implemented but is not yet safe under a changed snapshot. The separate [correction security review](2026-09-10-prp-473-correction-1-security-review.md) independently reproduced legacy generation A repair overwriting terminal generation B and then confirming obsolete A. Its P2 remains outstanding; this report does not claim a second independent race reproduction.
- The account fallback has a real destination: `buildTourNotificationContext` supplies the existing create-account route with `tour_inquiry` and `next=/rent/tours-contact?propertyId=...`; create-account preserves that return path, and the destination offers a Send message tab plus resident portal handoff. No additional finding is raised merely because this is a communication follow-up rather than automatic SMS YES confirmation. A direct message destination or clearer follow-up wording would improve navigation, but absence of a confirmation-specific URL alone does not prove the promise is unavailable.
- Default copy only advertises signed email replies when the same address is attached to the payload. Conservative supplied previews remain preserved, and customized manager prose remains untouched. The missing-owner issue above prevents the richer configured reply path from being selected in actual planned changes.

## Verification scope and disposition

Read the root/Akhil instructions, correction plan/handoff, original bugbot findings, tour/SMS architecture notes, and the separate correction security review. Inspected the changed delivery, copy, consent resolver, dispatcher, proposal compatibility, origin creation/tool bindings, and actual planned change callers; inspected the account fallback destination and signed reply helper. No repository graph was present, matching the handoff's established graph tooling limitation. Routine source-inspection commands exited 0 except an initial search at the ungrouped `src/app/rent/tours-contact` path (exit 2); the route was subsequently found and read under `src/app/(public)/rent/tours-contact`.

The in-memory reproduction above was independently run. Full unit, lint, build, browser and live provider results were not rerun by this reviewer. The handoff's green suites do not cover the omitted manager context, and its browser outcome is not successful inbox delivery. No handset, staging or production acceptance is claimed.

Disposition: changes required for the P1 owner projection and the separately documented P2 legacy repair race, followed by fresh review and real caller-level regression coverage.
