# Billing migrations and temporary direct production releases

User authorization, 2026-09-11: "do the billing migrations and also remove the
staging qa necessity for prod, we are ommiting staging for the next few days".
This explicitly changes the former staging requirement for a limited window.
Existing request to ship the reviewed prospect improvement remains active.

## Workspace and scope

Use the existing clean pooled checkout:
`/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/4/AXIS-2`, branch
`prospect-conversation-production`, HEAD
`c391932da41bf19ec2266b4b30e90c5bfb0c7071` (already pushed).
Do not import the original workspace's unapproved evaluation-loop or unrelated
dirty changes. Root performs remote schema/branch/deployment investigation.
Execution owns the bounded release-policy implementation and migration
manifest/waiver preparation, not actual production writes or promotions.

## Temporary release change

Implement an explicit `npm run ship:production -- --skip-staging` option in the
existing production promotion script. The option chooses origin/main instead
of origin/staging only during the user-authorized window, ending
2026-09-15T04:00:00Z (midnight Eastern September 15). Default remains the normal
staging source. Fail closed for expired/missing/malformed policy, unexpected
arguments, and non-fast-forward candidates. Do not use a caller-supplied clock
or unbounded environment variable to bypass expiration in real execution.
Keep one machine-readable dated policy plus a short documentation explanation;
other docs point to the authoritative temporary exception. The policy applies
to Akhil-authorized releases, not an expansion of other developers' authority.

Preserve preflight, reviewed keeper/main consolidation, fast-forward-only
updates, production branch as the only live source, existing Vercel project,
and TestFlight verification. Do not remove default staging support or make
lasting changes to runtime production DB guards. Add concise exception
pointers to AGENTS.md, Akhil instructions, ship gate and deployment guide so
existing unconditional statements cannot silently contradict the temporary
window. Avoid editing unrelated historical developer instructions.

## Billing package

Updated after fetching origin/main 490964121: reuse the existing six-source
package, fixed apply runner, and waiver
`docs/waivers/2026-09-11-production-comms-billing.md`. Do not create a second
manifest or waiver. The sixth source is the identical additive account-recovery
trigger correction, already adopted in main. The bundle requires zero eligible
payment-preference backfill rows under a relation lock. Current authorization
is for the exact bounded migration, not customer payment-setting changes.
Record the current instruction in the existing waiver only after independent
runner review, exact digest verification and fresh target preflight. Root owns
the single apply and fresh-connection verification. Do not reuse the consumed
recovery waiver or retry an uncertain outcome. This update supersedes the
five-source preparation assumptions below.

Execution may temporarily commit its scoped work and merge current origin/main
to preserve new billing/recovery/tour work. No push or production action is
delegated. Preserve prospect quiet handoff behavior when integrating the changed
leasing runtime. No unrelated dirty pool-3 work belongs in this candidate.

Prepare a named one-shot waiver documenting this user's explicit instruction
and exactly these existing migration files, their SHA-256 values, intended
production project qahnczmilgptcedaqype, dependencies, expiry, and effects:

- 20260910140000_manager_communication_credits.sql
- 20260910160000_comms_credit_alerts.sql
- 20260910170000_manager_billing_customer.sql
- 20260910180000_comms_wallet_snapshots.sql
- 20260910190000_sms_outbox_campaign_budget.sql

The first creates tables/functions/columns and one policy row, and backfills
manual_payments from manager_automation_settings.row_data.manualPayments when
the new value is empty. Function definitions do not themselves execute wallet
spending or purchases. List these effects honestly. Do not rewrite existing
migration SQL, seed/wipe production, edit listings, grant model tools, charge
cards, or invoke wallet-spending RPCs. This is a specific migration exception,
not a blanket production-data authorization.

Root will confirm applied migration ledger and actual schema, dependencies,
and prepare an exact allowlisted dry run before any apply. Earlier ledger
inspection found additional historic missing versions, potentially renamed;
never blindly use --include-all or repair history. If the five need other
migrations, report exact prerequisites to root before broadening execution.
Keep the normal migration mechanism and tracking; do not use the SQL Editor
or silently mark unexecuted migrations applied.

## Validation and review

Sol-medium manages disjoint Terra implementation/tests and Luna documentation/
waiver or independent read-only verification. Test allowed/expired boundary,
normal staging default, explicit direct-main selection, bad argument/policy,
and non-fast-forward refusal with temporary local Git fixtures (no real
remote/prod mutations). Validate migration checksums and document actual SQL
side effects/dependencies. Run relevant existing deployment/preflight tests,
lint appropriate to changed files, shell syntax and diff checks. No new UI or
runtime code requires another full application build unless implementation
scope changes. Required graph refresh gets one bounded attempt, not repeated
unsupported CLI invocations.

Provide exact commands/exits and a durable execution handoff. Root launches
fresh Astra review and required security/Bugbot checks before code landing or
operational use. At most two correction cycles. No no-mistakes, Linear,
Lavish, PR, or external messaging. Preserve already obtained prospect patch
validation; do not rerun its entire suite without a new reason.
