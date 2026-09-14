# Bounded release prerequisite: follow-up controls recovery triggers

## Why this is necessary

Akhil requested another test and movement of PRP470/472 toward production. The four older production schema gaps must not be applied blindly. The independent prospective review found a concrete defect in one prerequisite: `manager_tour_followup_controls` is phase2 manager-owned and recoverable, but the historical recovery installer only attached triggers to tables existing at install time. Staging catalog confirms this later table has no custom triggers or automatic installer. Production does not have the table yet.

Deleting a manager after any SMS archive/restore creates a control row snapshots a delete hold, deletes the row without capture, and leaves archived=false. `account_recovery_finish_archival` then raises Personal record cleanup incomplete; retry cannot capture an already deleted row. This occurs even with tour automation disabled. See `docs/security/2026-09-13-prp472-production-prerequisites-review.md` and private staging/production lifecycle catalogs under `/private/tmp/axis-inbox-release`.

This plan authorizes reversible code/test preparation of the smallest prerequisite repair. It does not authorize unrelated production data repair or applying the older migrations. Root will complete the reviewable candidate/staging QA before resolving the additional production mutation scope with Akhil. No old stuck records, real accounts, provider messages, locked listings or historical migration files may be changed.

## Workspace and ownership

Pool `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2`, keeper `akhil/prp-472-inbox-unread`, currentHEAD `276e1e40a0a9f3f63bee3a87b4fabbbd9edaf54b`. Inbox Sol manager concurrently owns browser QA only and its handoff. Fresh Sol-medium manager for this bounded schema repair delegates Terra the additive migration and Luna test/probe design or independent review. Do not overlap source files or use the browser. There are four slots: run Terra and Luna sequentially if needed while the inbox manager is active. Root owns all Git, DB execution and broad tests.

Read repository/Akhil/feature-cycle instructions, `docs/agents/account-recovery-design-draft.md`, the actual auth manifests, recovery SQL and the prospective review. Favor actual deployed/recorded definitions over dated rollout prose.

## Minimal implementation

Add unique `20260913173000_tour_followup_recovery_guards.sql`. In one transaction, fail closed unless the exact public controls table and existing zero-argument recovery trigger functions exist. Attach the existing `account_recovery_write_guard` BEFORE INSERT/UPDATE/DELETE and `account_recovery_capture_delete` AFTER DELETE on the exact controls table. Use normal repository trigger names. Make repeat apply safe; an existing conflicting same-named trigger must not silently count as correct. Preserve functions, RLS, client grants, columns, ownership/restore policy and data. Do not modify historical SQL, broaden recreatable/never-restore allowlists or disable lifecycle guards. No alternate recovery framework.

The controls table remains classified by the existing ownership manifest. No new table is introduced. This does not repair already stuck recovery requests. Report such records separately if root's read-only aggregate check finds them.

## Validation

Retain meaningful coverage for the new table's guard/capture wiring and prerequisites, using existing migration/lifecycle test patterns rather than merely reproducing the migration text. Design a rollback-only SQL probe against DEV/staging actual functions: use only an isolated synthetic QA account/control key, record a recovery snapshot/hold for that row, prove writes during a hold are blocked, delete through the normal permitted archival path, assert capture updates archived, and prove finalization does not fail for the uncaptured-row condition. Root executes reviewed DB probes; do not call database tools yourself or touch real manager holds. No broad account purge/auth delete/provider calls. The entire database probe must roll back and prove no fixture/hold leakage. Prove applying the migration twice remains safe and exact trigger functions/event masks match.

Run relevant focused migration/recovery unit tests and lint if applicable. The inbox manager and root own browser/fullsuite/build work; avoid duplicate heavy runs. Deliver `docs/plans/2026-09-13-tour-followup-recovery-release-handoff.md` with source, exact tests, a ready-to-review probe artifact, behavior/rollback assertions and limitations. Root will have a fresh Astra/security review assess the final integrated candidate and this bounded migration before any apply or publication.
