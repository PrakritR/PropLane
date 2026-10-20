# One-number cutover runbook (human-run)

Moves every existing PropLane workspace onto the shared PropLane line and creates the PropLane Service
"Seattle" workspace in the admin account. Decisions it carries out: #4-#8, #10, #11 in
[`one-number-decisions.md`](one-number-decisions.md). Map of the code: [`one-number.md`](one-number.md).

**Agents do not run this against staging or production.** Every script below is dry-run by default and refuses
production unless every guard is present (see "Guards"). A human, or claude-1 on the captain's explicit go after he
has reviewed `prakrit`, types the commands. The scripts live in `scripts/one-number/`; each prints the exact
Supabase project it will touch before it does anything.

## Guards (the same for every script)

| Situation | What the script demands |
| --- | --- |
| any run | `--target dev|staging|production` (no default). The project ref in the env file must be the one that target owns: dev `emstjswhotsnyksqhqyf`, staging `xwszcafaontidfgznlxd`, production `qahnczmilgptcedaqype`. A mismatch is refused. |
| staging or production, even a dry run | `--confirm-ref <that ref>` |
| staging write (`--apply`) | the above + `--reason "<at least 10 characters>"` |
| production write (`--apply`) | the above + `--backup <file>` where the file was written by `backup.mjs` for production, is complete, and is under 2 hours old |
| `--rollback` and `--undo` | count as writes: same guards |

Exit codes: `0` ok, `1` a check failed or an error, `2` refused (guard, usage or an unmet prerequisite).

Env file: the scripts read `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (and, for `cutover.mjs`,
`TWILIO_ACCOUNT_SID` with `TWILIO_AUTH_TOKEN` or `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET`) from `--env-file <path>`.
For `--target dev` the worktree's `.env.local` is read when no file is given. Use a production env file that exists
only on the machine of the person running this, and never commit it.

In every command below `PROD="--target production --env-file <prod env file> --confirm-ref qahnczmilgptcedaqype"`.

## 0. Before anything (humans)

1. Production code with the one-number build is deployed. It is safe before the migrations: every read of a new
   table or column treats Postgres 42P01 / 42703 and PostgREST PGRST204 / PGRST205 as "nothing there", and
   `sms_runtime_config.line_mode` defaults to `per_workspace` (today's behaviour).
2. Supabase point-in-time recovery is on for production and a manual backup exists (Supabase dashboard). The file
   backup in step 1 is not a substitute: it holds the rows the scripts touch, not the database.
3. The shared number is bought, registered (mixed-use campaign, first reply names the business and says "Reply STOP
   to opt out"), attached to the shared Messaging Service in Twilio, and the Messaging Service SID is known (`MG` +
   32 hex). Address autocreate for Conversations stays OFF on that number. Agents never do this step (decision #10).
4. The website number, the Twilio webhook (`/api/twilio/inbound`), and the Conversations webhook point at production.
5. Staging rehearsal: run steps 1-6 against staging with `--target staging` (needs the staging service-role key; none
   was available to the builder, so this rehearsal has **not** been done). Do not skip it.

## 1. Backup

```bash
node scripts/one-number/backup.mjs $PROD
```

Read-only. Writes `~/.cockpit/backups/one-number-production-<time>.json` (mode 0600; it holds phone numbers). Note
the path: every `--apply` below needs `--backup <that path>` and the file expires after 2 hours, so take a fresh one
before each production write if time passes. Contents and what each part restores: header of `backup.mjs`.

Rollback: not applicable (read-only).

## 2. Migrations

All additive and idempotent; nothing is dropped. Order is the timestamp order. Preview first:

```bash
supabase db push --dry-run        # review the PENDING list against the table below
npm run db:push                   # human, against production, after the review
```

Production's migration ledger can disagree with the files (a merged migration that never ran; a live table
that lacks what the list claims). Read the dry-run's pending list line by line; if it names anything older than
`20261018090000` that you did not expect, stop and reconcile before pushing. Then:

```bash
node scripts/one-number/list-migrations.mjs --since 202610     # the files on disk, in order
```

`--since` is a filename prefix, so that call also prints the earlier October files; this batch is every version
from `20261018090000` on, and the table below is the list it must match.

The one-number migrations, in order (a file marked "branch" is not on `on/migration`'s base; it lands with its
branch, and `db:push` applies it only once merged):

| Version | File | Adds |
| --- | --- | --- |
| 20261018090000 | `one_number_shared_line` | `sms_runtime_config.line_mode / shared_number_e164 / shared_messaging_service_sid / shared_pilot_workspace_ids`; router state; entry codes; unassigned leads; `sms_phone_contacts`; `workspace_id` on the six message tables; MMS files; phone-bound links; OTP challenges; knowledge entries; reply modes |
| 20261018110000 | `one_number_transport` | receipt and turn workspace stamp triggers; shared-line conversation identity; `project_shared_line_event` |
| 20261018120000 | `vendor_dispatch_rules` | dispatch rules, runs, attempts |
| 20261018120100 | `vendor_dispatch_engine` | engine columns, `vendor_dispatch` audit domain |
| 20261018150000 | `share_links_token_hash` | hashed share-link tokens |
| 20261018160000 | `one_number_knowledge` | knowledge audience, escalations, AI drafts, digests |
| 20261018180000 | `phone_auth` | phone sign-in state and RPCs |
| 20261018180001 | `phone_auth_reset` | owner-mediated phone release |
| 20261018190000 | `house_groups` | house group chats |
| 20261018200000 | `automations` | preset auto-sends and the escalations inbox (branch: `on/automations`, in `claude-1`) |
| 20261018210000 | `one_number_feel` | bubbles, burst debounce RPCs, latency columns |
| 20261018220000 | `booking_exact_times` | exact check-in/out timestamps on stays + backfill from property defaults, time-aware capacity trigger (claude-2 bookings-times-1018) |
| 20261018220001 | `stay_time_reminders` | arrival-guide and checkout-reminder sends keyed on stay times (claude-2 bookings-times-1018) |
| 20261018230000 | `one_number_onboarding` | first conversation, DEMO, setup links |
| 20261018240000 | `sms_outbox_media_urls` | outbound MMS |
| 20261018250000 | `number_subscription_manager_role` | PropLane Number for a manager's workspace (branch: `on/numbers`, in `claude-1`) |
| 20261018260000 | `admin_service_workspaces` | service owner settings, `is_service` / `city`, `create_portal_service_workspace` (branch: `on/admin-service`). **Step 5 needs this one.** |
| 20261018260100 | `service_owner_of_record` | owner-of-record name and flag (branch: `on/admin-service`) |
| 20261018270000 | `owner_management` | management agreements, owner statements (branch: `on/owners`) |
| 20261018290000 | `one_number_fixes` | `sms_onboarding_replies` (turn replay per MessageSid), `sms_moved_notices` (moved-number marker and cutover queue) (branch: `on/fixes`) |
| 20261018300000 | `action_event_domains_explicit` | restates `action_events_domain_check` with every domain spelled out, incl. `vendor_dispatch` |
| 20261018310000 | `withdrawal_reserve_exists_stored_values` | `reserve_party_withdrawal` answers a reused key with the stored reservation, never the new request |
| 20261018310100 | `phone_auth_failure_cap` | lifetime failed-code cap for phone sign-in (10 wrong codes in 24 hours locks the phone) |
| 20261019010000 | `burst_original_shared_line` | `resolve_sms_completed_receipt_original` also proves the shared PropLane line (live config, shared number, router-stamped workspace); needed before durable prospect bursts (`PROSPECT_SMS_BURSTS_ENABLED=1`) are on for the shared line (branch: `on/msge2e`) |
| 20261019100000 | `managed_read_only` | `managed_read_only_workspace_ids()` - a PropLane-managed client's own workspace is view-only unless she pays for a plan herself (staff keep write). Superseded by v2 and v3 below; all three land, in order, and the migration goes BEFORE the code (a missing function refuses every non-allowlisted write) |
| 20261019120000 | `managed_read_only_v2` | restates that rule: self-paid is a `manager_purchases` row matched by `user_id` alone, tier pro/business, with a Stripe subscription id or an Apple anchor - a free-tier row written before payment no longer counts |
| 20261019130000 | `vendor_line_history` | two partial unique indexes on `agent_sessions` (PropLane-line vendor chat, personal-line carry-over) and `agent_sessions_directory_identity_check` restated with `vendor_line_sms`; no table (branch: `on/smsvendor`) |
| 20261019140000 | `managed_refund_gross` | a full refund of a managed capture may reverse principal PLUS the processing fee the resident added at checkout (one defaulted column, create-or-replace) |
| 20261019150000 | `phone_first_accounts` | `sms_runtime_config.phone_required` (default FALSE on every row; production flips it deliberately), `phone_otp_challenges.purpose` gains `sms_signup`, `sms_signup_sessions` (sign-up by text state, service role only) (branch: `on/smssignup`) |
| 20261019150100 | `phone_auth_failure_cap_per_purpose` | the 24-hour failed-code cap is counted per purpose (renamed from a duplicate 20261019150000 version) |
| 20261019160000 | `phone_auth_send_budget_per_purpose` | `phone_auth_start` send budget per purpose under the phone-wide ceiling |
| 20261019160100 | `service_vendors_and_manager_phone` | `platform_service_settings.manager_phone_e164` / `manager_phone_verified_at`, `phone_otp_challenges.purpose` gains `service_manager` (rebuilt as the union of the live list), partial index on roster vendor rows (branch: `on/adminops`) |
| 20261019170000 | `sms_stay_offers` | the options a texter was quoted for a short stay and the one they picked (service role only, RLS on, no client grants); additive, inert until the leasing agent calls `quote_short_stays` (branch: `on/smsstay`; applied to dev only) |
| 20261020100000 | `managed_read_only_v3` | the final view-only rule: admin is `profile_roles`, never the legacy `profiles.role` column |
| 20261020100100 | `phone_required_skip_cap` | "Skip for now" on `/auth/verify-phone` is capped per account (7-day cooldown, 3 in a lifetime), because the person chooses the number whose failed send is the skip's own proof |
| 20261020100200 | `sms_confirmation_codes` | the hashed 4-digit code a manager phone repeats to confirm a write on the PropLane line, with its attempt count (three wrong codes cancel the proposal) |
| 20261020100300 | `sms_confirmation_code_proposal` | `proposal_id` on that row: a NEW proposal on the same run resets the guess budget, a re-ask of the open one does not |
| 20261020100400 | `manager_plan_reconcile_retry` | the daily plan reconciler stamps every outcome and backs a failed provider off, so an outage cannot hold the head of the queue |
| 20261020110000 | `phone_required_skip_atomic` | `record_phone_required_skip`: the skip cap's count and insert in ONE transaction under a per-account advisory lock |
| 20261020110100 | `sms_confirmation_failures_and_stay_request` | `sms_confirmation_failures` (a keyed hash of the phone, never the number: ten wrong codes in 24 hours pause the coded path for it) and `subject_kind` gains `stay_request` |
| 20261020120000 | `sms_confirmation_phone_reserve` | that per-phone budget reserved atomically (count + insert under a per-phone advisory lock), so a burst of guesses cannot walk past it |
| 20261020130000 | `manager_purchase_subscription_status` | `manager_purchases.subscription_status`: a `trialing` Checkout subscription is not a self-paid plan, so a card-on-file trial does not lift the managed view-only lock |
| 20261020140000 | `manager_purchase_first_paid` | `manager_purchases.first_paid_at`: a Stripe subscription also needs a real paid invoice, so a trial that fails into `past_due` and a 100%-off promotion stay locked |
| 20261020150000 | `managed_policy_activation_terms_guard` | `activate_managed_policy` re-checks the row's OWN live fee terms against the snapshot the owner signed (and refuses an owner signature on an unsent draft), so an admin edit landing between her page's load and her signature cannot activate terms she never saw |
| 20261020150100 | `phone_otp_start_atomic` | `phone_otp_start`: the phone-code budget check, the retire of older codes and the insert in ONE transaction under a per-phone advisory lock, so two concurrent sends cannot both pass the 3-per-hour cap or leave two live codes behind |
| 20261020160000 | `phone_otp_start_caps_from_app` | the same function with the three caps as ARGUMENTS from `SHARED_LINE_OTP_RULES` / `PHONE_LIFETIME_FAILED_CODE_CAP` (the old 7-arg signature is dropped), so editing the constant changes what is enforced |
| 20261020160100 | `managed_policy_guard_full_terms` | the activation guard covers canonical v3: `reserve_target_cents` and `repair_approval_threshold_cents` join the comparison, so an admin cannot raise the no-ask repair threshold between the owner's page load and her signature |

Check after the push (SQL editor, read-only):

```sql
select line_mode, shared_number_e164, shared_messaging_service_sid, shared_pilot_workspace_ids from sms_runtime_config;
-- expect: per_workspace | null | null | {}
select to_regclass('public.sms_phone_contacts'), to_regclass('public.platform_service_settings');
```

Rollback: none needed. The columns and tables are inert in `per_workspace`. If a migration itself fails halfway,
fix forward (they are idempotent) and re-run `db:push`.

## 3. Baseline

```bash
node scripts/one-number/verify.mjs $PROD --save-baseline ~/.cockpit/backups/one-number-baseline.json
```

Read-only. Records the conversation and contact ids, the turn count, every currently opted-out phone and the
old conversation keys that already resolve to nothing. Keep the file; step 4 and step 9 compare against it.

## 4. Backfill

```bash
node scripts/one-number/backfill.mjs $PROD                        # plan only: read the numbers
node scripts/one-number/backfill.mjs $PROD --apply --reason "one-number backfill" \
  --backup <backup path> --service-sid <MG...>
node scripts/one-number/verify.mjs   $PROD --baseline ~/.cockpit/backups/one-number-baseline.json --service-sid <MG...>
```

What it does (all additive, idempotent, re-runnable): global contacts from profiles and manager contacts;
`sms_projection_aliases` for every conversation's old key; `workspace_id` on turns, outbox, receipts, manager
messages, inbound log and manager contacts (only NULLs, only a workspace the row's own owner holds); scoped
opt-outs copied onto the shared Messaging Service. `--apply` writes a journal
(`~/.cockpit/backups/one-number-backfill-journal-production-<time>.json`) of exactly what it inserted or stamped.

How to read the plan: "left (owner_has_no_workspace)" / "(no_owner)" are rows that cannot be stamped and are
reported, never guessed. `verify` fails only on rows that can be stamped; add `--strict-orphans` to make the rest fail
too. Old conversation keys that resolved to nothing **before** the backfill are listed as a note, not a failure.

Rollback:

```bash
node scripts/one-number/backfill.mjs $PROD --apply --reason "undo backfill" --backup <fresh backup> \
  --undo <journal path>
```

removes the inserted contacts, aliases and consent events and clears only the stamps still carrying the value the
backfill wrote. Leaving the backfill in place is also safe: it changes no read while `line_mode` is `per_workspace`.

## 5. The PropLane Service workspace (Seattle)

Needs migration `20261018260000_admin_service_workspaces` (step 2) and an admin account.

```bash
node scripts/one-number/create-service-workspace.mjs $PROD --name "PropLane Seattle" --city Seattle \
  --owner-user-id <the admin account's user id>          # dry run first; the id is only used to seed an empty service-owner row
node scripts/one-number/create-service-workspace.mjs $PROD --name "PropLane Seattle" --city Seattle \
  --owner-user-id <admin user id> --apply --reason "create the Seattle service workspace" --backup <backup path>
```

The service owner is one designated admin account (`platform_service_settings`, a singleton). The script seeds it
only when empty, only from an account that really holds the admin role, and the stored row always wins afterwards.
The workspace is created through `create_portal_service_workspace` (the only writer), so it is an ordinary workspace
owned by that account and exempt from the 10-workspace ceiling. Re-running finds it by name and writes nothing.
It **moves no property**: after the captain reviews, he moves the Ambika, Vinod, Prakrit and other accounts' houses
into it himself. Other admin operators join it through Admin > Service > Team.

Rollback (human, only while it holds no property):

```sql
delete from portal_workspaces where name = 'PropLane Seattle' and is_service
  and not exists (select 1 from manager_property_records p where p.workspace_id = portal_workspaces.id);
```

## 5b. Bring existing owners under PropLane Service (one owner per run)

Needs step 5's service owner and migrations `20261018260000` / `20261018260100` (step 2). Two modes, one script:

- **`--mode attach` (the default).** The owner's workspace **stays with the owner**. The script writes exactly two things:
  the workspace row (`is_service = true`, `city`, `name` = `--label`, `owner_of_record_name` = the owner's name) and one
  membership row (the service owner as an accepted Admin of that workspace, all houses). **No house, lease, charge, listing,
  conversation or number row is written**, so nothing can be left behind. After the write it re-reads every house-keyed table
  and compares a fingerprint of every row (every column) with the snapshot taken first: the owner, every house-keyed row and every
  other member must be byte-identical, and only the workspace row and the service owner's membership may differ.
- **`--mode transfer`.** Hands the workspace to the service owner through the app's `transfer_portal_workspace_ownership`
  (see "Transfer mode" below). Refuses unless `--acknowledge-unmoved`.

The admin attach action in the production port is not in this repo; attach mode writes the equivalent two rows directly, with the
owner pinned in the `where` (`owner_user_id` = the owner it read), so it cannot touch a workspace the owner does not own.
Note for the port: `loadServiceWorkspace` (W15) today accepts only workspaces **owned by the service owner**, so an attached,
owner-held workspace opens from Admin > Service only once the port's attach action relaxes that check; the service owner can
always open it from the normal workspace switcher as an Admin member.

Run it for each owner, one at a time.

```bash
# 1. Pick the account (optional): lists accounts whose name or email matches, then stops.
node scripts/one-number/move-houses-to-service.mjs $PROD --owner-name Ambika

# 2. Back up the rows this touches. --owner-email is required here: a production run refuses any other backup.
node scripts/one-number/backup.mjs $PROD --owner-email ogambik2@gmail.com

# 3. Dry run: every house with residents, leases (open), bookings (upcoming), charges (open), services, applications and
#    conversations. It writes nothing. The house count it ends with is the number to approve.
node scripts/one-number/move-houses-to-service.mjs $PROD --owner-email ogambik2@gmail.com --label "1. Ambika"

# 4. Apply, with the dry run's house count.
node scripts/one-number/move-houses-to-service.mjs $PROD --owner-email ogambik2@gmail.com --label "1. Ambika" \
  --apply --expect-houses 3 --reason "attach Ambika's workspace to PropLane Service" \
  --backup <backup path from step 2> --journal-out ~/.cockpit/backups/attach-ambika.json
```

Vinod's only workspace holds one draft with no address, so the Seattle gate cannot pass it; the captain's explicit
`--workspace-id` is the override that skips the city check (the houses are still printed):

```bash
node scripts/one-number/backup.mjs $PROD --owner-email vinodvinod5@gmail.com
node scripts/one-number/move-houses-to-service.mjs $PROD --owner-email vinodvinod5@gmail.com --label "2. Vinod" \
  --workspace-id e8cb8455-555f-42c4-b909-d83935181fd1
node scripts/one-number/move-houses-to-service.mjs $PROD --owner-email vinodvinod5@gmail.com --label "2. Vinod" \
  --workspace-id e8cb8455-555f-42c4-b909-d83935181fd1 --apply --expect-houses 1 \
  --reason "attach Vinod's workspace to PropLane Service" --backup <backup path> --journal-out ~/.cockpit/backups/attach-vinod.json
```

What it refuses (exit 2): a workspace that mixes cities or holds a house whose city it cannot read (it never splits a
workspace; fix the addresses or pass `--workspace-id`), an owner with two Seattle workspaces (choose with `--workspace-id`),
a missing service owner or migration, a label the owner (attach) or the service owner (transfer) already uses on another
workspace, a service-owner membership that is not an accepted Admin one, a missing or wrong `--expect-houses`, and
(production) a backup not taken with the same `--owner-email`. A re-run after a finished attach finds it and writes nothing.

Order of writes, each saved to the journal (`--journal-out`, default `~/.cockpit/backups/one-number-move-houses-<target>-<time>.json`,
mode 0600) before the next: add the service owner's Admin membership -> mark the workspace. **Any difference in the check, or any
error, undoes the run automatically** and exits 1.

Rollback (attach):

```bash
node scripts/one-number/move-houses-to-service.mjs $PROD --apply --undo ~/.cockpit/backups/attach-ambika.json \
  --reason "undo the Ambika attach" --backup <fresh backup path>
```

Removes the service owner's membership row, restores the workspace's name / city / service flag / owner-of-record name, and proves the
workspace, every house-keyed row and every other member equal the first snapshot. `--undo` without `--apply` prints what it would do.

### Transfer mode (`--mode transfer`), only if the captain wants the service owner to OWN the workspace

Moves the workspace, houses, residents, leases, bookings, charges, applications, services, inbox, members, work number and work
email together through the app's ownership transfer; the former owner stays as an Admin member and owner of record, and gets a fresh
empty default workspace if this was their default. The RPC re-keys **only twelve** house-keyed tables (applications, leases, charges,
rent profiles, work orders, schedule, screening, cosigners, ledger, expenses, scheduled messages, payment automation). Documents,
bills, service requests, security deposits, move-in forms, inspections, owner/vendor settings and about thirty others keep the old
owner's id on the row. The dry run (`--mode transfer`) counts them as LEFT BEHIND; apply needs `--acknowledge-unmoved` and
`--expect-houses`. Extend the RPC (a new migration) before using this mode for an owner who has such rows. No promoted/demoted emails
are sent (the RPC is called directly). Its undo is the same command as above (the journal carries its mode) and hands the workspace
back, which needs the former owner to still be an accepted Admin member.

## 6. Shadow mode (old numbers keep working)

```bash
node scripts/one-number/cutover.mjs $PROD --mode shadow --shared-number <+1...> --service-sid <MG...>   # dry run: also asks Twilio (read-only) that the number is on the service
node scripts/one-number/cutover.mjs $PROD --mode shadow --shared-number <+1...> --service-sid <MG...> \
  --apply --reason "shadow mode" --backup <backup path>
```

Sets exactly `line_mode`, `shared_number_e164`, `shared_messaging_service_sid`, `shared_pilot_workspace_ids` on the
`sms_runtime_config` singleton. In shadow mode nothing is sent from the shared number; every text on a normal work
number is also routed read-only and compared with who really owned it. The cutover refuses unless Twilio confirms
the number is attached to the Messaging Service (GET only; it never buys, attaches or releases anything).

Let it run through real traffic (at least 48 hours, including a weekend), then:

```bash
node scripts/one-number/shadow-report.mjs $PROD --since-hours 72 --min-samples 50 --min-agreement 0.98
```

Exit 0 = READY. Exit 1 = read the listed disagreements first; do not switch. Rollback:
`cutover.mjs $PROD --rollback --apply --reason "..." --backup <backup path>`.

## 7. Pilot (the captain's own workspace)

```bash
node scripts/one-number/cutover.mjs $PROD --mode shared --shared-number <+1...> --service-sid <MG...> \
  --pilot <captain's workspace id> --apply --reason "pilot" --backup <backup path>
```

Only the pilot workspace is served on the shared line; everyone else is left on today's numbers (an ambiguity
between a pilot and a non-pilot team resolves to the pilot team). Text the number from the captain's phone as a
resident, a vendor, a stranger and a manager (HUMAN, a gas smell, STOP and START). Rollback as above.

## 8. Switch everyone

```bash
node scripts/one-number/cutover.mjs $PROD --mode shared --shared-number <+1...> --service-sid <MG...>     # dry run: lists who moves and who keeps a paid number
node scripts/one-number/cutover.mjs $PROD --mode shared --shared-number <+1...> --service-sid <MG...> \
  --apply --reason "switch everyone to the shared line" --backup <backup path>
```

Every workspace without a paid personalized number texts on the shared line (decisions #4-#6; nobody pays today,
so that is everyone). The printed list mirrors the app's own rule for information only: the app decides live from
the entitlement, so the list cannot move anyone. The switch is instant and reversible with `--rollback`.

Then tell people, as a **separate** step after a few minutes of watching real traffic:

```bash
node scripts/one-number/cutover.mjs $PROD --mode shared --shared-number <+1...> --service-sid <MG...> \
  --notify-moved --since-days 365                  # dry run: counts per workspace, opted-out and idle contacts skipped
... same command + --apply --reason "send the moved notice" --backup <backup path> --per-minute 30
```

Queues one `sms_moved_notices` row per **phone** (`We've moved to (XXX) XXX-XXXX. Save this number.`), at most
`--per-minute` an hour apart and only 9:00-19:59 Pacific. **These are PropLane's cost, not the workspace's**: the
platform dispatcher (`/api/cron/moved-notices`, every 5 minutes, up to 100 per sweep) sends each from the **shared
number** as a platform send (`sendSms` purpose `platform_lead`: no workspace wallet, no credit hold), so the contact
gets the notice from the number they are being asked to save. Opted-out phones (global ledger, profile flags, any
scoped revoke for that team) are never queued, and the dispatcher still applies the opt-out ledger, quiet hours and
the real-customer shield. Re-running queues nothing twice (one row per phone; a phone already told by an auto-reply in
the last 30 days is skipped). `--rollback` deletes notices not yet sent.

Spot checks (SQL, read-only):

```sql
select line_mode, shared_number_e164 from sms_runtime_config;
select count(*) filter (where workspace_id is null) as unstamped, count(*) as total from sms_projection_turns;
select count(*) from sms_unassigned_leads where status = 'open';
select source, status, count(*) from sms_moved_notices group by 1, 2;
```

## 10. Retire the old numbers (day 60)

For 60 days after the switch a text to an old number of a workspace that moved (shared mode, and the workspace is
not dedicated: `workspaceOnSharedLine`) is handled in `src/app/api/twilio/inbound/route.ts` by
`src/lib/one-number/old-number.server.ts`:

- the sender gets "We've moved to (XXX) XXX-XXXX. Save this number." **once per sender per 30 days** (marker: one
  `sms_moved_notices` row per phone, claimed before the send and handed back if the text did not go out), sent from
  the shared number as a **platform send at PropLane's cost** (same path as the one-time notices in step 9);
- the text itself is **routed as if it had arrived on the shared line**, so nothing is lost and the answer to the
  actual message comes from the shared number. If the shared line takes nothing from it, it continues on the old
  number exactly as before.

A dedicated workspace's number, and `per_workspace` / `shadow` modes, behave exactly as before. Replies to a thread
now leave from the shared number.

On day 60, with the captain's go:

1. List candidates (SQL, read-only): old numbers of workspaces that moved, with their last inbound text:

```sql
select n.id, n.phone_number, n.workspace_id, n.provision_state,
       (select max(created_at) from inbound_sms_log l where l.to_phone = n.phone_number) as last_inbound
from manager_sms_numbers n
where n.released_at is null and n.phone_number is not null
order by last_inbound nulls first;
```

2. A number with recent inbound texts still has people on it: leave it, or re-send the notice.
3. Release is two steps. In the database `releaseManagerNumber` marks the row `released` and is reversible
   (`restoreManagerNumber`). At the provider (detach from the Messaging Service, deregister from the campaign,
   release the number) it is a destructive, money-adjacent operator step in the Twilio console; nothing in this
   repo does it. After the provider release a number cannot be recovered, so rollback only exists until then.
4. Rollback before day 60 at any time: `cutover.mjs ... --rollback --apply`.

## Rollback matrix

| Step | Undo | Window |
| --- | --- | --- |
| migrations | none needed (inert) | always |
| backfill | `backfill.mjs --undo <journal> --apply` | until a later legitimate write re-stamps a row (those are left alone) |
| Seattle workspace | the SQL in step 5 | while it holds no property |
| owner attached to Service (5b) | `move-houses-to-service.mjs --apply --undo <journal>` (also automatic on any failed check) | always (it writes one workspace row and one membership row) |
| shadow / pilot / shared | `cutover.mjs --rollback --apply` (also cancels unsent notices) | until old numbers are released at the provider |
| moved notices | `--rollback` deletes unsent ones; sent ones cannot be recalled | before dispatch |
| old number release | `restoreManagerNumber` (database only) | until the provider release |

## Known gaps (reported by the builder; not fixed here)

- STOP / START on the shared number are global only (the webhook passes no manager for the shared number), which is
  right; but nothing restores scoped grants after a START on the shared line, which is why the backfill copies only
  scoped-only revokes and skips phones the global ledger already blocks.
- The staging rehearsal (step 0.5) has not been done: no staging service-role key was available.

## Apple Pay and Google Pay on the payment link

The in-page form on `/l/<token>` is Stripe embedded checkout. The wallet buttons show only on a domain Stripe knows: add `proplane.ai`
(and any other host the links are served from) under Dashboard > Settings > Payment methods > Payment method domains, in the live account
for production and in test mode for dev and staging. Nothing in the repo registers it. Until it is added the form still offers card and
"Pay from bank".

