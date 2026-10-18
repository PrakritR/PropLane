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
`20261018*` that you did not expect, stop and reconcile before pushing. Then:

```bash
node scripts/one-number/list-migrations.mjs --since 20261018     # the files on disk, in order
```

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
| 20261018230000 | `one_number_onboarding` | first conversation, DEMO, setup links |
| 20261018240000 | `sms_outbox_media_urls` | outbound MMS |
| 20261018250000 | `number_subscription_manager_role` | PropLane Number for a manager's workspace (branch: `on/numbers`, in `claude-1`) |
| 20261018260000 | `admin_service_workspaces` | service owner settings, `is_service` / `city`, `create_portal_service_workspace` (branch: `on/admin-service`). **Step 5 needs this one.** |
| 20261018260100 | `service_owner_of_record` | owner-of-record name and flag (branch: `on/admin-service`) |
| 20261018270000 | `owner_management` | management agreements, owner statements (branch: `on/owners`) |

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

Queues one `sms_outbox` row per contact, `We've moved to (XXX) XXX-XXXX. Save this number.`, sent **from the
workspace's old number** so it lands on the thread the contact already has, at most `--per-minute` an hour apart and
only 9:00-19:59 Pacific. Opted-out phones (global ledger, profile flags, any scoped revoke for that team) are never
queued. The outbox dispatcher still applies consent, quiet hours, the real-customer shield and the wallet. Re-running
queues nothing twice (unique `number-moved:<workspace>:<phone>` key). `--rollback` cancels notices not yet sent.

**Open decision for the captain before this step:** whose wallet pays for the notices. The rows are stamped with the
workspace, so the dispatcher bills that workspace's credit; if you want PropLane to absorb them, change that before
`--apply`.

## 9. Verify after

```bash
node scripts/one-number/verify.mjs $PROD --baseline ~/.cockpit/backups/one-number-baseline.json --service-sid <MG...>
```

Checks (all must pass; exit 1 otherwise): conversation and turn counts did not fall and no baseline conversation or
contact vanished; zero rows without a workspace stamp; every phone opted out in the baseline is still opted out and
every scoped revoke holds on the shared service; every old conversation key still resolves; no row is stamped into a
workspace its own owner does not hold; every global contact with a user belongs to one verified profile with that
phone. Add `--strict-counts` when traffic is quiet.

Spot checks (SQL, read-only):

```sql
select line_mode, shared_number_e164 from sms_runtime_config;
select count(*) filter (where workspace_id is null) as unstamped, count(*) as total from sms_projection_turns;
select count(*) from sms_unassigned_leads where status = 'open';
select status, count(*) from sms_outbox where purpose = 'number_moved_notice' group by 1;
```

## 10. Retire the old numbers (day 60)

For 60 days after the switch the old numbers keep answering exactly as before (their inbound path is unchanged, so
a text to an old number lands in the same workspace thread; there is no forwarding to build), and the one
"We've moved" text is the notice. Replies to a thread now leave from the shared number.

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
| shadow / pilot / shared | `cutover.mjs --rollback --apply` (also cancels unsent notices) | until old numbers are released at the provider |
| moved notices | `--rollback` cancels unsent ones; sent ones cannot be recalled | before dispatch |
| old number release | `restoreManagerNumber` (database only) | until the provider release |

## Known gaps (reported by the builder; not fixed here)

- No code sends an auto-reply when someone texts an OLD number after the switch. The old numbers keep working as
  before and the one outbound notice is the only "we've moved" text. Adding an inbound auto-reply is a code change.
- The first-conversation role question (W12) is not idempotent on `MessageSid`: a Twilio retry of a stranger's very
  first text answers with the lead welcome instead of repeating the question
  (`tests/integration/one-number-e2e/prospect-journey.test.ts`, the `it.fails` case).
- STOP / START on the shared number are global only (the webhook passes no manager for the shared number), which is
  right; but nothing restores scoped grants after a START on the shared line, which is why the backfill copies only
  scoped-only revokes and skips phones the global ledger already blocks.
- The staging rehearsal (step 0.5) has not been done: no staging service-role key was available.
