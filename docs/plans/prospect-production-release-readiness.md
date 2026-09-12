# Prospect production release readiness

Checked 2026-09-11 during Akhil's explicit production release request. This is a
read-only release audit; no environment schema or production data was changed.

## Release candidate

The focused conversation and quiet-handoff patch is being prepared on
`prospect-conversation-production`, based on
`8ce3868b4e5775661956c6c3f36fcb146bfa931a`, in the pooled worktree
`/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/4/AXIS-2`.
The implementation plan is `docs/plans/prospect-production-first-release.md`.
The separate unapproved evaluation-loop changes in the original worktree are
not part of this release.

## Confirmed blockers

1. `origin/main` and `origin/staging` both point to `8ce3868`. Production points
   to `2d1353a`. The required fast-forward promotion would include 27 existing
   commits and 141 changed files before the prospect patch, including the
   communication credit feature. It cannot release only the prospect diff.
2. These five migrations are absent from both staging and production migration
   ledgers:

   - `20260910140000_manager_communication_credits.sql`
   - `20260910160000_comms_credit_alerts.sql`
   - `20260910170000_manager_billing_customer.sql`
   - `20260910180000_comms_wallet_snapshots.sql`
   - `20260910190000_sms_outbox_campaign_budget.sql`

   This is not just a ledger discrepancy. A query through Supabase's dedicated
   read-only endpoint found none of `reserve_comms_credit`,
   `comms_wallet_snapshot`, `claim_comms_budget_alert`,
   `comms_wallet_snapshots`, or `spend_sms_outbox_segment_budget` in the public
   schema of either environment. Current leasing runtime calls credit
   reservation before executing the agent.
3. The staging alias is stale. Vercel deployment
   `dpl_DHFznkJpSYESz7pKeXzVrvtoDgUs` is ready but serves commit `0b6d567`,
   not the staging branch's `8ce3868`. GitHub run
   [34552913754](https://github.com/PrakritR/PropLane/actions/runs/34552913754)
   is green because `check-secrets` returned `configured=false`; its actual
   deploy job was skipped. The native Git integration has not produced a
   newer staging deployment in the recent deployment history.

Production's latest ready deployment is `dpl_FqzK3oKWGp5cX78haCY1BAh1Zr7T`,
at `2d1353a`, matching the production branch.

## Other drift requiring reconciliation

Staging has six migration versions absent from its ledger: the five above and
`20260904120001_work_order_human_references.sql`. Production has 37 absent versions. Older differences
may involve renamed migration history and are not, by themselves, proof that
all corresponding schema objects are absent. Do not blindly apply or repair
the entire set. The human-reference migration also backfills existing rows.

Safe evidence files are under `/private/tmp/`:
`prospect-release-migration-check.json`, `prospect-release-schema-check.json`,
`prospect-staging-deployment-source.json`, and
`prospect-vercel-release-history.json`. They contain status and schema metadata,
not credentials or conversation data.

## Required completion path

`npm run ship:preflight` was run in the candidate worktree and exited 0
(11 structural checks passed, four warnings). This does **not** establish
release readiness: its shell had no production environment or database URL,
so the script warned that environment, migration parity, and live Langfuse
regression were not verified. The independent read-only checks above did
verify missing schema dependencies and take precedence over that aggregate
exit code. No deployment or branch promotion occurred.

Finish the focused patch, independent reviews, and non-production validation.
Before promotion, reconcile the exact pending migration set and satisfy the
production-write rule in `.cursor/rules/no-production-data-writes.mdc`, which
requires a named one-shot repository waiver for a specific production write.
The user's release request authorizes the code promotion ladder but does not
supply that migration waiver. Alternatively, an authorized operator can apply
the reviewed migrations manually and the agent can verify read-only afterward.

Once schema prerequisites are satisfied, run the repository preflight, promote
the reviewed keeper through main and staging using fast-forward updates, deploy
the exact staging SHA, complete staging QA, then promote staging to production
and verify Vercel and TestFlight distribution. Never treat a skipped deploy job
or a ready deployment for an older SHA as successful release validation.
