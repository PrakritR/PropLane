> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

# SMS / phone system (Twilio)

## Work-order reference routing

Inbound `WO-1042`, `wo 1042`, `#1042`, `status 1042`, or a message containing
only `1042` is parsed before intent handling. The parser only identifies a
claim; it never grants access. Resolution happens through the same scoped row
loaders used by each portal and agent registry:

| Sender | Rows eligible for resolution | Allowed action path |
| --- | --- | --- |
| Manager | Owned work orders plus only co-managed properties available through the current manager-SMS access grant | Manager tool catalog; writes retain the SMS `YES` confirmation gate and destructive tools remain portal-only |
| Resident | `resident_email` match, additionally pinned to the owner of the work number texted | Resident tools; writes retain the SMS `YES` confirmation gate |
| Vendor | Work orders represented by that verified phone's active job sessions (assigned/live-offered jobs only) | Job-bound read tools; only `escalate_to_manager` remains inline-allowed |

The stable handle is per manager, so a co-manager or vendor can legitimately
see two `WO-1042` records under different owners. Several visible matches return
a clarification naming only those visible jobs. No visible match, including a
real reference outside scope, always returns the same `We can't find that work
order.` response. Never add a global reference lookup to distinguish those
cases: that would turn the reference into a cross-tenant existence oracle.

On one visible match, the internal primary key is added to the agent's system
context so the model uses the already-scoped row for intent narrowing and can
pass the opaque id to existing tools. The primary key remains unchanged and is
never exposed as the conversational handle.

## Conversation identity is per-counterparty, NOT the phone pair (read this first)

A conversation used to be derived from the phone-number pair on the wire
(`sms_from_number` = To, `profiles.phone` = From). On the shared agent line
that pair collapses — every manager shares one `To`, so distinct people/roles
folded into one thread and admin saw one flat stream. Conversation identity is
now **explicit and durable**, tied to the counterparty (person + role):

```
conversation_key = <owner_manager_user_id>:<counterparty_role>:<person_ref>
```

- `person_ref` = the counterparty's Axis `user id` when they have an account,
  else their normalized phone (`conversationPhoneRef`). Two different people on
  one shared line therefore ALWAYS get different keys — this is the tenant-
  isolation guarantee, covered by `tests/unit/sms-conversation-identity.test.ts`.
- `counterparty_role` ∈ `resident | applicant | prospect | vendor | manager |
  admin | unknown`. The SAME phone in two roles (a leasing prospect who later
  becomes a resident) is two threads, by design.
- Pure helpers live in `src/lib/sms-conversation-identity.ts`
  (`buildConversationKey`, `conversationPhoneRef`, `deriveCounterpartyRole`);
  the SQL twin is `public.axis_sms_phone_ref()` in
  `supabase/migrations/20260721210000_sms_conversation_identity.sql`, which adds
  `counterparty_role` + `conversation_key` to `manager_sms_messages` and
  `inbound_sms_log` and backfills existing history.

**Writes must stamp the role.** `logManagerSmsMessage` takes `counterpartyRole`
and computes `conversation_key`; `persistClawInboundSms` passes `"resident"`
from the known-resident hub and `"prospect"` from the leasing responder;
`sendFromManagerWorkNumber`/`sendPropLaneSms` thread it so outbound lands in the
SAME thread as the counterparty's inbound. Inbound `inbound_sms_log` rows use
`inboundLogIdentityFields(...)`. A write that omits the role degrades to a
conservative derivation (`unknown` → phone-grouped), never a wrong merge.

**Reads group by `conversation_key`.** `fetchManagerSmsConversations` folds a
directory resident's non-prospect threads (matched by owner + account id OR
phone) into one conversation and keeps prospect threads separate. It accepts a
`scopeManagerIdsOverride` so admin oversight (`fetchAdminSmsConversations`)
threads the same way across the mapped-manager cohort instead of returning one
flat feed. The manager/admin SMS UI keys rows on `conversationKey` and sorts via
`sortSmsConversationRows` (Newest / Oldest / Name A–Z / House).

**Voice call notes land in the same Communication thread.**
A manager voice turn writes the spoken line and the assistant reply through
`logManagerSmsMessage` with a `voice:` message sid (`src/lib/voice/log-voice-call-notes.server.ts`).
The Communication list prefixes that row with `Call:`, and the SMS bubble shows
a Call badge. Threading still uses `conversation_key` (owner + `manager` role +
the verified caller). Do not invent a second inbox for transcripts.

**Manager Communication shows the full phone when there is no better label.**
Every manager/admin SMS row and thread header — the SMS panel and the unified
Communication list alike — takes its label from `smsConversationDisplayName` /
`smsConversationSubtitle` (`src/lib/manager-sms-messages.ts`): name → saved
contact name → property / unit → email → a readable phone
(`+1 (510) 648-9423`) → `Unknown contact`, where a `name` that is itself a
number (`isPhoneLikeLabel`) counts as no name. Phone numbers are not a secret
on this surface, so they are not masked. This is a LABEL rule only —
threading, replies and deletes still key on the phone / `conversationKey`, and
both search boxes keep the phone in their haystack. When a saved contact name
is the title, the subtitle still shows the phone so the manager can see both.
`sortSmsConversationRows` orders Name A–Z and House on that rendered label
rather than the raw `name` for the same reason: sorting a value the list does
not display makes the visible order look random. Coverage:
`tests/unit/manager-sms-messages.test.ts`.

**Add phone contact renames existing sidebar numbers.**
`POST /api/manager/sms-contacts` is an address-book write only (no consent).
When the number already appears in Communication under any role, the route
attaches the display name to that existing thread's
`(manager, phone, role)` contact row and returns that conversation key —
it does not create a parallel `unknown` contact beside the existing
sidebar row. Brand-new numbers still create an `unknown`-role contact.
Coverage: `tests/unit/manager-sms-contacts-route.test.ts`.

**The backfill orders IDENTITY before TOPIC — never the other way round.**
`claw_messaging_threads` holds exactly ONE mutable row per (manager, phone)
(`unique (manager_user_id, resident_phone)`) and `topic` is overwritten on every
thread touch, so it describes the thread *today*, not what any given message
was. The row's own `resident_user_id` / `matched_sender_user_id` is the
per-message fact. The first version of the backfill tested `topic = 'leasing'`
first, which re-stamped a current resident's ENTIRE history as `prospect` the
moment their latest Claw thread happened to be a leasing one — and because the
read path deliberately refuses to fold a prospect thread into a directory
resident, that history vanished from the named conversation with nothing in the
UI disclosing the loss (it resurfaced as an unnamed raw phone number, and the
resident detail page's SMS tab went blank).
`20260721220000_sms_conversation_identity_role_repair.sql` corrects databases
that applied the bad version.
Regression coverage: `tests/unit/sms-conversation-identity-backfill.test.ts`
evaluates the migration's `case` branches as a decision table. Any future
role-derivation change must keep account linkage ahead of thread topic.

**Deletes and replies are scoped by `conversation_key`, not the phone.** One
phone is now potentially two threads, and `deleteManagerSmsConversation` is an
irreversible hard DELETE of both tables — scoping it to the phone destroyed the
other role's correspondence while the confirm dialog named only one thread. The
client sends `conversationKey` on DELETE and POST; the phone-variant match
survives only for legacy rows with a NULL key, and as the fallback when no key
is supplied. The panel's local "hidden" set is keyed on the conversation id
(`axis_manager_sms_hidden_v2`) for the same reason.

Scope by the thread's `memberKeys`, NOT its `conversationKey` alone. A directory
resident's conversation is a MERGE of every non-prospect key matching that owner
by account id or phone, surfaced under one canonical key — so deleting only the
canonical key leaves the phone-keyed and unknown-role halves stored and still
rendering for a co-manager behind an `ok: true`. `fetchManagerSmsConversations`
publishes `memberKeys` for exactly this, and the route forwards it.

Two consequences of the delete being irreversible: legacy NULL-key rows are
swept by phone only when that phone hosts no OTHER thread (a null key carries no
role and cannot be attributed, and under-deleting is recoverable where a hard
delete is not); and once any row is gone, a later failing pass is reported as
`partial: true` with the count, never as a flat failure the manager would retry
against history that no longer exists.

**Admin can message a resident or a manager.** `POST /api/admin/sms-conversations`
routes by recipient phone only (never model input): it logs into the owning
manager's thread and sends a COPY to the admin oversight phone
(`resolveAdminForwardPhone`, the admin profile's own number — `+15103098345` on
the test/prod admin account, resolved from `admin-role.ts`, never hardcoded).
"Phone only" is literal: the recipient number selects the candidate threads, and
`conversationKey` may only disambiguate *within* that set (one shared-line phone
can be both a prospect and a resident thread). A body `residentUserId` never
picks the thread — it is accepted solely as log attribution, and only when it
names a resident in the cohort belonging to the resolved owning manager;
otherwise it is dropped. Letting either field select the thread lets the caller
choose the `ownerManagerUserId` a message is sent *as*, and threads it under an
unrelated resident's `conversation_key`. Coverage:
`tests/integration/admin/sms-conversations-attribution.test.ts`.

The admin SMS surface reuses `ManagerSmsPanel` with `endpoint="/api/admin/…"`
and `allowDelete={false}`: the admin route has no `DELETE` handler, and the
panel's swipe/trash affordances would otherwise confirm a destructive dialog and
then always 405 behind a generic toast. Mounting `ManagerSmsPanel` on a new
endpoint means checking BOTH — does it implement DELETE, and should that
surface be able to delete at all.

**Admin oversight must never PROVISION a number.** `fetchAdminSmsConversations`
passes `managerIds[0]` as the "viewer", which is a threading anchor, not the
person at the keyboard — and `resolveManagerWorkNumber` falls through to
`ensureManagerSmsNumber`, a paid Twilio purchase. It therefore passes
`provisionWorkNumber: false`, and the display number is resolved read-only (the
shared line constant, else `profiles.sms_from_number` already on file). Only a
manager loading their OWN tab may provision on demand. Guarded by
`tests/unit/admin-sms-no-provisioning.test.ts`.


**Design: outbound sends from a per-manager work number; replies land in PropLane.**
Carriers do not allow sending SMS *from* a personal number — do not fake it.
- Manager-facing operational alerts use one preference-aware router
  (`manager-notification-routing.server.ts`). Settings → Preferences stores a
  destination of `assistant` (default), `personal_number`, or `both`, plus
  topic-level SMS switches for messages, maintenance, payment reminders,
  applications, and leasing. The default falls back to PropLane Assistant until
  the manager has both an eligible work number and a personal phone; it switches
  to the manager-cell connection automatically once both are ready. New
  manager-alert call sites must use this router instead of sending directly.
- Outbound manager-owned traffic enters `owner-sms-dispatcher.server.ts`; the
  sender, campaign/service identity, consent, entitlement, segment budget, and
  outbox state are server-derived. `profiles.sms_from_number` is display/cache
  data and is never accepted as send authority.
- Inbound: `POST /api/twilio/inbound` (Twilio Messaging webhook; signature
  validated, `TWILIO_WEBHOOK_URL` overrides the URL behind proxies). Managed
  runtime bypasses the legacy proxy pool and resolves the manager from the
  authoritative `manager_sms_numbers` assignment for `To`, logs to
  `inbound_sms_log`, writes a manager inbox notice + email + push
  (`src/lib/sms-inbox-notice.server.ts`), and records a distributed MessageSid
  execution lease before any agent/reply side effect. Manager-cell forwarding
  is off for this slice; managers reply in the portal.
- MMS capture: inbound attachments are copied out of Twilio (whose media URLs
  need Basic auth and expire) into the PRIVATE `sms-media` bucket
  (`src/lib/sms-media.server.ts`). The durable identifier is the bucket PATH —
  inbox bodies carry `/api/sms-media?path=` links that mint a fresh signed URL
  after an ownership check (the manager-documents model); immediate signed
  URLs feed only the outbound SMS/email legs.
- Personal-number verification: `/api/manager/phone` (GET settings /
  POST send code / PUT confirm / PATCH prefs). When `TWILIO_VERIFY_SERVICE_SID`
  is set, OTPs go through Twilio Verify (needs no owned number and no A2P
  campaign, so verification works while the campaign is in carrier review);
  managed runtime requires that Verify path through the restricted REST client.
  Runtime-off legacy installations may fall back to the hashed 6-digit OTP in `phone_verifications`
  (10-min TTL, 5 attempts, 60s resend throttle — the row's throttles apply on
  both paths). UI: `manager-phone-settings-panel.tsx` on manager Settings.
- **A write that changes `profiles.phone` MUST null `phone_verified_at` in the
  same patch.** Verification belongs to the NUMBER, not the row: leaving the
  stamp in place hands a brand-new, unverified number the previous number's
  authority — a deliverable SMS destination to `portal-inbox-delivery` and an
  authorized inbound-SMS identity to the manager SMS agent — that is, the whole
  portfolio. The non-obvious writer is
  `applyProspectMessagingContactToProfile` (`src/lib/tour-resident-link.server.ts`),
  which `/api/auth/create-resident-account` reaches with a caller-supplied
  `phone`, so this cannot be closed at a call site.
- Env required before managed traffic sends: `TWILIO_ACCOUNT_SID`, restricted
  `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET`, the exact service/campaign,
  callback and webhook URLs, `SMS_RUNTIME_ENABLED=1`, and
  `SMS_OUTBOX_SCHEDULER_READY=1`. `TWILIO_AUTH_TOKEN` is reserved for webhook
  signatures. Missing or partial production credentials fail closed.

**Claw shared agent line (mapped-manager trial + admin oversight).**
`src/lib/claw-resident-messaging.server.ts` / `claw-relay.server.ts` run a
SEPARATE transport from the Twilio work-number system above: when Claw is
enabled (`isClawTransportEnabled()`), all sends route through one shared
agent line. A small trial cohort (`clawMappedManagerEmails()`, env
`CLAW_MESSENGER_MANAGER_EMAILS`) shares that line; forwarding targets for
their threads are the env `CLAW_MESSENGER_MANAGER_FORWARD_PHONES` list plus
`resolveAdminForwardPhone()` — the Axis admin account's own `profiles.phone`
(any account holding the admin role per `src/lib/auth/admin-role.ts`:
`profile_roles`, legacy `profiles.role`, or the primary-admin email), NOT a
hardcoded constant. Set the admin's phone from admin Settings
(`/admin/profile`) to change where these forwards land; when no admin
profile has a phone on file it falls back to the first env forward phone,
then the hardcoded `+15103098345` trial default. Admin views
these same threads read-only at `/admin/communication` → SMS
(`fetchAdminSharedLineSmsConversation` in `manager-sms-messages.server.ts`,
merging `inbound_sms_log` + `manager_sms_messages` across the mapped
managers) — Admin Communication → Email is the pre-existing admin inbox
(`AdminInboxClient`), reachable at `/admin/communication/inbox/*`
(old `/admin/inbox/*` and `/admin/communication/email|sms/*` links redirect
there via `render-portal-section.tsx`).

⚠️ **Every portal's Communication SMS panel is hidden by default** (manager,
resident, vendor, admin) — the sections render only when `SMS_COMM_UI_ENABLED`
is on. Nothing in this document's transport, webhook, provisioning or agent
paths is affected; the flag gates UI only. The full rule, including the
inbound-notice fall-through that keeps texts visible while the panel is hidden,
lives with the inbox invariants in AGENTS.md → "Communication is one unified,
conversation-based inbox".

**Proxy-pair relay: manager ↔ resident text from their personal phones through
a pooled number, neither seeing the other's real number**
(`src/lib/sms-relay.server.ts`; schema + rationale in
`supabase/migrations/20260718120000_sms_relay_pool.sql`). Routing is the
globally unique active pair `(participant_phone, proxy_phone)` → thread + role
in `sms_relay_bindings`; one proxy number serves unlimited residents but only
one active thread per manager (`allocate_sms_proxy_number`, concurrency-safe,
service-role only). Relay numbers are DISJOINT from work numbers — a number
must never be in both systems. Manager API: `/api/manager/sms-relay` (GET
threads / POST provision — requires a VERIFIED personal phone; caps: 5 active
threads per manager, 60s between provisions / PATCH close). Closing a thread
puts its number on a 30-day cooldown so a former tenant texting the old number
can never land in a new tenant's thread; in-app account deletion
(`/api/account/delete`) sweeps the user's bindings via
`closeRelayThreadsForUser` (bindings hold real cells with no auth-users FK).
Relayed messages are stored idempotently (`sms_relay_messages.twilio_sid`
unique — Twilio retries webhooks) and mirrored into the manager's Axis inbox.
Pool maintenance: daily cron `/api/cron/sms-pool-topup` (Vercel Hobby crons
must be once-per-day; an hourly schedule fails the whole deploy) always releases
expired cooldowns, but the auto-buy loop (target 5 free, hard cap 100) stays
dark unless `SMS_RELAY_POOL_AUTOBUY=1`. The relay pool is not part of the
manager-number first slice and its auto-buy flag stays off; manager-owned
numbers use the approved PropLane Standard brand/campaign instead.
Bought numbers must join the Messaging Service
(`TWILIO_MESSAGING_SERVICE_SID`) to inherit the A2P campaign; a failed attach
releases the number. A2P compliance pages: `/sms-terms`, the SMS opt-in
section on `/privacy`, and the public consent page `/sms-consent` (owner
section: "Public SMS consent page" below).

**Web opt-in consent (carrier-required).** Every public form that collects a
phone and can lead to an outbound text renders the shared `SmsConsentCheckbox`
— its wording, invariants, and the reviewer-facing `/sms-consent` page are
owned by the "Public SMS consent page" section below (the tours-contact page
gates anonymous visitors behind a manager link, so it is NOT the page a
carrier reviewer can inspect cold). On the tours-contact page
(`/rent/tours-contact`), the decision is persisted two ways: `smsConsent` + a SERVER-stamped
`smsConsentAt` on the `PartnerInquiry` record (the route coerces the flag to a
strict boolean and ignores any client-supplied timestamp, so per-lead consent is
provable), and a positive opt-in written to the `sms_consent` ledger via
`recordOptIn(..., "tours-contact")` in the `partner-inquiries` /
`property-lead-message` routes. The load-bearing
send gate is in `textTourGuest` (`tour-notification-delivery.server.ts`): a
prospect is texted ONLY when `smsConsent === true`. Absence of a prior STOP is
NOT consent — `sendResidentOutboundSms`/`sendSms` only check `isPhoneOptedOut`,
which fails open, so a positive opt-in is required before any tour SMS. A later
inbound STOP still supersedes the recorded opt-in. Coverage:
`tests/unit/tour-guest-sms-consent.test.ts`,
`tests/unit/partner-inquiry-sms-consent.test.ts`,
`tests/unit/tours-contact-sms-consent-ui.test.tsx`.

## Per-manager number: provisioning + registration state machine

`profiles.sms_from_number` is the denormalized "active number" cache every send /
inbound path reads; **`manager_sms_numbers`** (migration
`20260725120000_manager_sms_numbers.sql`, service-role-only, RLS no policies) is
the source of truth for the number's LIFECYCLE and the manager's MESSAGING
REGISTRATION. Pure gates live in `src/lib/sms/number-registration-policy.ts`; the
server state machine in `src/lib/sms/manager-number-provisioning.server.ts`.

- **`provision_state`** ∈ `pending_registration | provisioning | active | failed
  | released`. **`registration_state`** ∈ `pending | approved | rejected`.
- **One number per manager, idempotent.** A service-only provisioning-claim RPC
  serializes requests before any provider purchase. A durable provisioning
  operation is inserted first, and its request UUID is stamped into Twilio's
  friendly name. The five-minute reconciliation worker can therefore recover a
  lost purchase response without buying a second number. Messaging Service attachment
  is mandatory; attachment or persistence failure requires a confirmed release. A
  number remains `provisioning` until a newer, allow-listed Event Streams event
  marks that exact phone SID registered.
- **Money guard.** Real Twilio purchases happen ONLY when
  `SMS_PROVISIONING_ENABLED=1`, the DB runtime mode allows the owner, and the
  owner explicitly clicks Request in Settings → Messaging. Signup only seeds a
  parked row. The legacy provisioning route returns 410 and the old backfill
  cron is inventory-only and no longer scheduled. There is no automatic fleet
  purchase path.
- **One PropLane brand/campaign.** Workspace registration uses the approved
  PropLane campaign. Sendability still requires the individual number's carrier
  registration to be `registered`, attachment to the configured Messaging
  Service, exact account/service/campaign allow-list match, active paid
  entitlement, and both runtime kill switches.
- **Signup** (`scheduleManagerMessagingReady`) always seeds a parked record via
  `ensureManagerNumberRecord`. Release on deactivation is reversible
  (`releaseManagerNumber` → `released`, history kept; `restoreManagerNumber`).
- **Paid entitlement is enforced.** Explicit setup reconciles Stripe/Apple into
  `sms_manager_entitlements`; trialing, past-due,
  canceled, legacy-unknown, and unreadable plans fail closed. Comp grants carry
  no Stripe subscription to revalidate, so `reconcileManagerSmsEntitlement`
  recognises all THREE shapes the portal's own plan resolver does — `billing =
  'admin'`, an `admin_`-prefixed checkout session, and a payment waiver
  (`promo_code`). Recognising only the first read a waiver-granted Business
  manager back as `legacy_unknown`: every other paid feature worked while
  Settings → Messaging refused their number as unpaid. Dispatch uses the
  persisted state and never calls billing providers in the hot path. The pilot
  allowlist controls rollout only; it is never accepted as proof of payment.
  Stripe and RevenueCat lifecycle webhooks refresh this cache.

The additive `20260825120000_sms_control_plane.sql` migration owns runtime
configuration, scoped consent evidence, the durable outbox/attempt ledger,
provider events, delivery events, and atomic campaign segment budget. It seeds
runtime mode `paused`; applying it cannot send or buy anything.

### Managed first-slice scope

The managed-number launch covers manager-to-resident/applicant/prospect portal
messages, consented lifecycle acknowledgements, weekly rent reminders, inbound
messages and replies, STOP/START/HELP controls, delivery receipts, and explicit
manager number setup. Those sends are owner-scoped and use the durable outbox.

Personal-cell forwarding of INBOUND resident/prospect texts is now part of the
slice — the two conditions it was waiting on are both met. It has its own
consent scope (purpose `manager_inbound_forward`, materialized from the
manager's own phone verification, revocable without touching their conversation
traffic) and an unambiguous reply model (Leg 2 below pins the reply to the
manager's active resident conversation). It goes only to a number that account
proved it controls via the verification code, honours
`profiles.sms_forward_inbound`, and dedupes on the inbound MessageSid so a
webhook retry cannot text twice.

Manager-directed ALERT SMS (tour alerts, work-order alerts, manager assistant
introductions, and other platform-to-manager notices) are still outside it.
Managers receive those through the durable portal inbox, email, and push paths,
and they must not be silently moved onto a manager work number until they have
a consent scope of their own. The legacy pooled proxy-number relay is
also not a managed-runtime launch rail; `/api/twilio/inbound` bypasses it while
`SMS_RUNTIME_ENABLED=1` and uses `sms_inbound_receipts` as the execution
idempotency authority.

### Activation order (fail closed)

The Twilio campaign's current `LOW_VOLUME` registration is a carrier campaign
classification, not an application architecture choice. The code keeps the
campaign/service identifiers configurable so a future throughput upgrade does
not change tenant ownership, consent, provisioning, or delivery semantics.

Run the read-only repository gate at every rung; it validates the deployment
environment without printing secrets and refuses to treat a suppressed Vercel
CLI table as an empty environment:

```bash
npm run sms:cutover:check                                      # all flags exactly 0
npm run sms:cutover:check -- --phase=scheduler-ready           # scheduler=1 only
npm run sms:cutover:check -- --phase=provisioning-canary       # scheduler + purchasing
npm run sms:cutover:check -- --phase=runtime-canary            # canary sending enabled
```

The gate also refuses to claim production migration coverage while the Supabase
CLI is linked to dev/test. Link production deliberately for the check and
restore the documented dev/test link immediately afterward. To stage Twilio
values, `npm run setup:twilio-vercel` is a dry run. Add `-- --apply` to update
Production only; Preview/Development require an explicit `--target` and are
never populated as a side effect. Updates use Vercel's atomic `--force` replace,
not remove-then-add.

1. Apply the control-plane migration while both SMS environment flags remain
   off and the DB runtime row remains `paused`.
2. Rotate the Twilio Auth Token atomically with the deployment that receives
   webhooks. Production REST access requires the restricted API key pair; the
   Auth Token is retained only for signature validation.
3. Configure the exact inbound, status callback, and Event Streams sink URLs.
   The restricted key must be able to read inbound Message resources (for
   provider-grounded STOP/START ordering), manage IncomingPhoneNumbers, and
   read/write the configured Messaging Service sender pool and Verify service.
   Set `TWILIO_VERIFY_SERVICE_SID` so personal-phone verification never borrows
   a manager work number.
   Create the Event Streams subscription for the A2P number registration and
   deregistration event types; the webhook validates the exact signed URL,
   Account SID, Messaging Service SID, Campaign SID, Phone SID, event id, and
   provider timestamp.
4. Verify that no existing `manager_sms_numbers` row is treated as current
   without a Twilio-owned Phone SID, sender-pool attachment, and carrier
   registration evidence. The migration deliberately defaults old rows to
   unattached/unregistered; stale `profiles.sms_from_number` values are never
   backfilled into sendable state.
5. Put one paid owner UUID in `pilot_manager_user_ids`, set DB mode to
   `allowlisted_self_service`, then enable provisioning only. The owner requests
   exactly one number from Settings. Keep sending disabled until Event Streams
   marks that exact number registered.
6. Configure a five-minute authenticated scheduler for `/api/cron/sms-outbox`
   (Vercel Pro Cron, Supabase Cron/pg_net, or another monitored scheduler), then
   set `SMS_OUTBOX_SCHEDULER_READY=1`. The checked-in Vercel job remains a daily
   safety net because the connected Vercel project is Hobby and rejects
   sub-daily cron expressions. The monitor must alert on a non-2xx response and
   inspect `unknownInventory`, `unknown`, `blocked`, and provisioning review
   counts in the JSON response; a successful HTTP request alone is not health.
7. Enable runtime for the canary and verify: inbound storage, portal reply,
   rental-application-consented weekly reminder, STOP, replayed START rejection,
   genuine START restoration, queued/delivered/failed callbacks, a forced
   pre-dispatch failure, billing revocation, and unknown-submission handling.
8. Expand the allowlist only after the canary has delivery receipts and no
   unexplained `blocked`, `unknown`, stuck `provisioning`, or outbox backlog.

Every `unknown` outbox row is terminal and operator-reviewable: the scheduler
scans the durable backlog on every run and logs a structured alert with the
bounded outbox-id inventory, the manager UI says not to resend, and automatic
dispatch never retries it. Resolve the provider Message SID from Twilio logs
before any manual recovery; absence of a locally persisted SID is not proof
that Twilio rejected the submission. Activation requires the scheduler monitor
to alert on both a non-empty inventory and an unreadable inventory.

Applying migrations or setting environment variables is not activation by
itself: the DB mode, provisioning flag, send flag, entitlement, attachment, and
per-number carrier registration must all agree.

## A manager texting a work number gets the AI

`/api/twilio/inbound` forks on `resolveManagerSmsInboundIdentity`
(`src/lib/sms/manager-sms-access.server.ts`). **The To number pins the
work-number owner first** (from `manager_sms_numbers`), then From must be that
owner's verified `profiles.phone` **or** a verified invitee of that owner with a
current accepted assignment. Candidates are taken from THIS owner's invitees,
never a global phone search, so a random verified manager cannot hop onto
someone else's number. `detectManagerSelfReply` still handles the owner-cell
match inside that resolver; do not remove it.

- **Leg 1 (resident → manager):** stored in the PropLane thread AND mirrored to
  the manager's own verified cell from the work number
  (`forwardResidentInboundToManagerCell`), for the resident-agent fork as well
  as leasing traffic. The mirror is labelled with `senderLabelForInbound` and
  never carries the texter's raw number, is sent with `skipLog` so it does not
  render as an outbound the resident never received, and is gated on: a
  verified `profiles.phone` (an unverified one is editable free text and could
  name a stranger's cell), `profiles.sms_forward_inbound`, a sendable
  registered number, and granted `manager_inbound_forward` consent. Managers
  can still read and reply in the portal.

That fork runs the **manager SMS agent**
(`src/lib/agent/manager-sms-agent.server.ts`) — the manager portal's tool
catalog, over text, with proposals confirmed by a `YES` reply. Session kind
`manager_sms`, portal `manager`, so a proposal is an ordinary
`agent_pending_actions` row executed by the same confirm gate the portal chat
route uses.

**Who gets a work number and an assistant email.** Every manager account that
clears the plan check can provision **its own** number and **its own**
`assist-…@` address — including a pure co-manager, who inherits plan eligibility
from an inviter (`getEffectiveManagerSmsEntitlement`). A co-manager used to be
refused the address and told to email the owner's, which meant two people shared
one mailbox and one assistant identity: the owner saw the co-manager's questions
in their own thread, and the co-manager had nothing to hand a resident.

**The address does not carry the scope; the assignment does.** A co-manager's
own number or address resolves through the same
`resolveManagerSmsAccess(actor === owner)` path, which reads their accepted
assignments and produces `combined` — the union of houses assigned to them
across EVERY owner who assigned them, and nothing else. So one co-manager number
answers about all their houses without any owner's other rows becoming
reachable.

Resident-facing SMS **sent by the product for a house** still goes from the
house owner's number; a co-manager's number is how people reach *them*.

**Three access modes** (`ManagerSmsAccess` in `src/lib/sms/manager-sms-access.ts`):

| Who texts | What number | Mode | Assistant scope |
| --- | --- | --- | --- |
| Property-owning manager, no incoming co-manage links | Own work number | `owner` | Full owned portfolio |
| Manager who also co-manages | Own work number | `combined` | Owned houses plus assigned co-managed houses |
| Pure co-manager | **Own** work number / assistant email | `combined` | Assigned houses across every owner who assigned them (they own none) |
| Co-manager texting an owner's number | That owner's work number | `delegated` | Only that owner's assigned houses |

Delegated turns set `landlordId` to the work-number owner (data tenant) and
`userId` to the co-manager (actor). Combined turns keep both as the texter so
owned-house tools stay unchanged. Landlord-wide tools that cannot be
property-filtered (`DELEGATED_SMS_UNSCOPED_TOOLS`: financial reports, dashboard,
calendar list/create, co-managers list, …) are withheld on **delegated** turns
only. Combined writes against another owner's row still fail closed if the write
keys on `ctx.landlordId` (the actor); act on those houses by texting **that
owner's** number. Inbox tools on an SMS turn intersect Communication grants
with the number's data owners (`smsInboxOwnerIds`), so an assignment without
inbox cannot dump the owner's threads. `book_tour` re-checks assigned
properties on delegated/combined turns.

**Communication in the portal** is a separate grant: inbox `read` views the
owner's SMS and email threads, `edit` replies/sends, `delete` deletes. Empty
co-manager permissions still mean a full grant on assigned properties. Sharing
is owner-level (inbox on ≥1 assigned property of that owner), matching existing
SMS scope — there is no per-thread `property_id` on inbox rows.

**Two things it replaced, both deliberately deleted:**

- A **blind relay**. `handleManagerReplyInbound` forwarded whatever the manager
  typed to their most-recently-active resident thread, chosen by recency alone.
  Leg 1 mirroring means the manager may well have seen A forwarded text, but
  never *which thread a bare reply would land in* — with two conversations
  moving, "on my way" went to whoever wrote last. Reaching a resident is now an
  explicit, named proposal: "text Jane that the plumber comes Tuesday" previews
  the recipient and the exact body, and `YES` sends it. Replying to a Leg 1
  mirror is therefore a question to the agent, not a silent relay.
- A **four-intent regex** (`claw-manager-actions.server.ts` /
  `claw-manager-intents.ts`, `agent mark paid` and friends) whose `mark_paid`
  wrote `portal_household_charge_records` directly with the service-role
  client: no tool layer, no preview, no confirmation, on the money path. It was
  also unreachable on the modern work-number route, because `detectManagerSelfReply`
  ran first.

**The registry is narrower than the portal's, on purpose.**
`buildManagerSmsRegistry` (`src/lib/tools/index.ts`) is `agentRegistry` minus
every tool flagged `destructive` — today `approve_and_pay_work_order`,
`void_lease`, `delete_charge`, `delete_promotion`, `revoke_resident_access`,
`cancel_calendar_event`. The Twilio `From` header is attacker-influencable and
the confirmation is one word with no card to re-read; before this surface
existed a spoofed manager cell bought a text relay, and handing it irreversible
writes is a different blast radius. The exclusion is derived from the FLAG, never
a name list, so a newly destructive tool is withheld automatically. The system
prompt tells the manager those actions are portal-only.

Resident-facing traffic is unchanged: **Leg 1 (resident → manager)** is still
stored in the PropLane thread, and personal-cell forwarding stays off during the
managed-number pilot (it needs its own manager-cell consent scope). Managers
read those threads in the portal, or ask the agent.

The turn body is shared with the resident SMS agent
(`src/lib/agent/sms-agent-turn.server.ts`) so the write gate, the
one-open-proposal invariant, and confirmation-before-the-model cannot drift
between the two surfaces. Coverage: `tests/unit/manager-sms-agent.test.ts`,
`tests/unit/manager-sms-access.test.ts`,
`tests/unit/twilio-inbound-retry.test.ts`,
`tests/unit/claw-manager-phone-scoping.test.ts`.

## Portal Communication sends can fan out to SMS (`/api/portal/send-inbox-message`)

A portal message with the SMS channel on picks its transport from the SENDER's
role, so a resident/vendor reply never has to be read in the browser to be seen:

- **Manager sender** → unchanged: the recipient is texted from the manager's own
  work number (`sms_from_number`).
- **Resident sender with a verified phone** → routed into that manager's Claw
  resident thread (`findThreadByResidentPhone`, else `openClawResidentThread`)
  and forwarded with `forwardResidentMessageToManagers`, so the text lands in the
  SAME conversation as the resident's other inbound SMS rather than a new one.
- **Vendor sender (and a resident with no verified phone)** → `sendPropLaneSms`
  to the manager's verified cell, prefixed `(Vendor <name>)` / `(Resident)`.

Only recipients whose role is manager/pro/admin/owner are texted, and a send
carrying an `eventCategory` still checks each recipient's saved SMS preference
(legacy category-less sends text every eligible manager). Manager-initiated prospect shares
(`/api/portal/send-lead-invite`) text from the work number via
`sendFromManagerWorkNumber` and refuse the whole send when the manager has no
work number yet — details in `AGENTS.md` → Sharing listings to a prospect.

## Consent + quiet hours are transport-level (never bypassed)

When `SMS_RUNTIME_ENABLED=1` and `SMS_OUTBOX_SCHEDULER_READY=1`, every
manager-owned Twilio send goes through
`owner-sms-dispatcher.server.ts`; caller-provided From numbers and the raw
`profiles.sms_from_number` fallback are ignored. The dispatcher fails closed on
global suppression, purpose/class/conversation-scoped positive consent, paid
entitlement, exact service/campaign identity, carrier registration, attachment,
runtime mode, quiet hours, and the atomic segment budget. Legacy platform alerts
without an owner scope do not borrow a manager number. Vendor one-job SMS,
Twilio Verify, and the proxy relay remain explicitly separate transports.

`sendClass` ∈ `control | transactional | automated`; quiet hours defer only
`automated` traffic. The **weekly rent reminder**
(`src/lib/sms/weekly-rent-reminder.server.ts`, cron
`/api/cron/weekly-rent-reminders`) sends `automated` from the manager's own
number and is idempotent per owner/resident/ISO week through the durable outbox
unique key. Purpose-specific consent is materialized only from the rental
application's server-owned consent timestamp and matching phone; a later scoped
revoke always wins.

STOP/START/HELP are authenticated and applied by one transactional RPC. A
MessageSid-unique control receipt plus Twilio's immutable Message `dateCreated`
prevents a delayed retry of an older signed START from reopening consent after
a newer STOP. Persistence/provider-read failure returns 503 so Twilio retries. Delivery and
carrier events are append-only, monotonic, and correlation-safe when a callback
races provider-SID persistence.

### `isPhoneOptedOut` is unified across BOTH opt-out stores

STOP is recorded in two places by different webhooks, and the single gate above
(`isPhoneOptedOut`, `src/lib/sms-consent.ts`) honors **both**, so a STOP recorded
on either path blocks every outbound rail:

- **`sms_consent` ledger** (phone-keyed) — the manager work-line webhook
  (`/api/twilio/inbound`) writes it via `recordOptOut`/`recordOptIn`.
- **`profiles.sms_opt_out_at` / `sms_consent_at`** (user-keyed) — the vendor-agent
  webhook (`/api/webhooks/twilio/sms`) writes the column AND now also records the
  ledger, so a vendor STOP is durable on the canonical store too.

Supersede is computed **globally** across both stores (latest opt-in anywhere
beats an older opt-out anywhere), so a STOP on one line followed by a START on
the other re-enables the number instead of dead-ending — carriers expect START to
work. `isPhoneOptedOut(db, phone, { userId })` folds a user-keyed row's timestamps
into the same comparison, so a legacy STOP recorded against a profile whose phone
column is empty still blocks until a later opt-in supersedes it; the vendor-agent
gates use this unified read so they agree with the send choke point. The managed
dispatcher fails closed when either suppression store is unreadable; older
specialized transports retain their compatibility helper until migrated. One shared
`profilePhoneVariants` helper (`sms-consent.ts`) matches un-normalized phone
columns and is reused by the inbound webhooks so the variant sets cannot drift.
Coverage: `tests/unit/sms-opt-out-unified.test.ts`.

## Historical: Claw Messenger shared line

The former PropLane messaging system used one shared agent line (Twilio
per-manager numbers above replace it when managed runtime is enabled —
`ensureManagerSmsNumber` deliberately keeps `sms_from_number` on the Claw
line and does not buy a Twilio number while `isClawSharedLineBridgeEnabled()`).
Inbound flow: `scripts/claw-messenger-gateway.mjs` (a long-running WS client,
NOT a Vercel function) → `POST /api/webhooks/claw-messenger` →
`handleClawLeasingInbound` (`src/lib/claw-leasing-bot.server.ts`) → either the
resident/payment/lease hub (`claw-resident-actions.server.ts`) or the
cross-catalog leasing agent (`src/lib/agent/leasing-sms-agent.server.ts` +
`src/lib/tools/domains/leasing-sms.ts`) depending on sender/thread state.

**Manager registration is DB-driven, not env-driven.** Every manager gets
`profiles.sms_from_number` stamped to the shared Claw line at onboarding
(`assignSharedClawLeasingNumberToManager`) and swept nightly for stragglers
(`backfillManagerWorkNumbers` cron) — so "has an account" already means
"participates in the shared line," no separate opt-in step.
`resolveRegisteredClawManagers()` / `resolveMappedManagerContacts()`
(`claw-resident-messaging.server.ts`) are the single choke point that reads
this: they exclude sandbox/demo accounts (`isPortalSandboxEmail` —
`@axis.local` / `@test.proplane.local`), require `profiles.role` to be one of
`manager`/`pro`/`admin`/`owner`, and only trust a manager's `profiles.phone`
as their identity when `phone_verified_at` is set (an unverified phone is
user-editable and forgeable). The role check matters because
`sms_from_number` and `phone_verified_at` are themselves settable by ANY
authenticated user through `/api/manager/phone` (no role gate there — a
resident verifying their own phone is legitimate) — without the role filter,
that would let a non-manager account self-register onto the shared-line
roster. `CLAW_MESSENGER_MANAGER_EMAILS`
is now an optional ADDITIVE override (e.g. an ops cell not yet fully
provisioned) — empty by default, never a replacement for DB registration, and
never able to re-admit a sandbox email. A tenant text about a listing routes
to that listing's actual owning manager via the cross-catalog property-hint
match in `claw-leasing-bot.server.ts` regardless of this roster; the roster
only decides the deterministic default/anchor manager (oldest-registered
first) when a text names no specific listing, and who a personal-phone text
is recognized as.

**Reply pacing — never instant.** Inbound prospect texts are buffered PER
CONVERSATION inside the gateway process (not the webhook — Vercel functions
here are Hobby-tier, so even Cron is once-per-day only; see the pool-topup
note above) and forwarded as one consolidated frame after
`CLAW_MESSENGER_DEBOUNCE_SECONDS` (default 150) of quiet from the last inbound
message in that thread — a new message resets the window. Manager-authored
texts and WS history replays always bypass the buffer (fetched from
`GET /api/webhooks/claw-messenger/manager-phones`, bearer-authed with
`CLAW_MESSENGER_API_KEY`, refreshed every `CLAW_MESSENGER_MANAGER_PHONES_REFRESH_MS`,
default 5 min). That endpoint returns HMAC digests of phone numbers, not raw
phone numbers — `CLAW_MESSENGER_API_KEY` also travels in the relay WS URL
(upstream logs can capture it, per the sibling webhook route's own comment),
so it must never double as a way to bulk-harvest real managers' cell numbers;
the gateway hashes each inbound `from` with the same key to check membership.
SIGTERM/SIGINT flush pending buffers immediately (awaited, capped at 8s) so a
redeploy doesn't add latency or drop the flush. Hard-crash durability is
deliberately bounded: `sinceIso` never advances past the oldest still-pending
buffered/in-flight frame, so Claw Messenger replays the buffered window on
reconnect — but the webhook skips replay frames unless
`CLAW_MESSENGER_PROCESS_REPLAYS=1` (default off), so a hard crash with a
non-empty buffer loses at most one quiet window of prospect texts. Frequent
gateway restarts make duplicate replies a worse failure mode than that rare
<=150s loss window; durable webhook-side messageId idempotency is the
prerequisite for flipping `CLAW_MESSENGER_PROCESS_REPLAYS` on later.

**A refusal to open a thread is not a failure to handle the text.**
`handleClawLeasingInbound` answers `ok: false` only when it genuinely could not
take responsibility for the message, because `/api/twilio/inbound` turns that
into a 503 — Twilio retries three times and then DROPS the message, so the
texter gets silence, nothing reaches `inbound_sms_log`, and Communication shows
nothing. `openClawResidentThread` returns null for ordinary reasons (the
sender's own number is a registered manager/admin cell; the owning manager has
no personal phone on file), so when the text arrived on ONE manager's work
number that falls through to the leasing responder, which is pinned to the same
manager and logs both sides. Unscoped shared-line traffic still fails loudly:
there the responder picks a manager from the roster, and misrouting one
landlord's resident to another is worse than a retry. Coverage:
`tests/unit/claw-resident-inbound-logging.test.ts`.

**Two-way logging is the single persistence model.** Every message on the
Claw line — inbound (prospect or resident) and outbound (agent or manager) —
is written to `manager_sms_messages` (+ `inbound_sms_log` for inbound) keyed
by `manager_user_id` + the counterparty phone; `fetchManagerSmsConversations`
(`manager-sms-messages.server.ts`) is what the portal Communication → SMS
panel reads, merged with `sms_relay_*` (the separate Twilio proxy-pair
system above) and sorted into one thread by `direction` + timestamp. Outbound
is logged for free inside `sendFromManagerWorkNumber` /
`sendPropLaneSms({ log })`. Inbound must be logged EXPLICITLY at each entry
point that receives it — the cross-catalog leasing-prospect path and the
known-resident hub path (`handleClawLeasingInbound`) each do this themselves;
a new inbound entry point that skips it will silently render as a one-sided
("outbound only") thread in the portal, which is exactly the bug this system
was built to fix.

**Public listing CTAs split by environment (interim, until A2P clears).** The
Twilio A2P campaign is still in carrier review, so the shared Claw line cannot
reliably carry production leasing traffic. `resolveListingCtaSmsPhone`
(`src/lib/listing-cta-phone.server.ts`) is the ONE place that branch is made,
keyed on the existing `isProductionRuntime()`:

- **production** → that listing's OWN manager's `profiles.phone`, and only when
  `phone_verified_at` is set (an unverified phone is user-editable and
  forgeable — same rule as `resolveRegisteredClawManagers`). Resolved per row
  from the owning `manager_user_id`, never a catalog-wide default, so a
  multi-manager fleet cannot cross-route a prospect to the wrong manager.
- **localhost / preview / test** → the shared Claw leasing line, unchanged, so
  the leasing-agent flow stays exercisable in development.

Everything downstream just carries the resolved number: `getPublicListings()`
and `/api/public/property-lead` stamp it onto `contactSmsPhone` (overwriting,
never defaulting — the stored property JSON's own `contactSmsPhone` is
manager-editable and is deliberately ignored), `/api/manager/phone` returns it
as `listingCtaPhone` for manager-side previews, and the browser's
`listingCtaSmsPhone` only normalizes/rejects. The browser must NEVER substitute
a number of its own: `null` means render the "Schedule a tour" / "Apply online"
web links that already sit under those buttons, not an `sms:` to the shared
line. Note `managerContactSmsPhoneForPublicCta` still collapses everything onto
the Claw line — it backs the SEND transport (`proplane-sms-transport.server.ts`)
and work-number UI, not CTAs. Coverage:
`tests/unit/listing-cta-manager-phone.test.ts`,
`tests/unit/public-listings-cta-phone.test.ts`.

**Defensive catalog filter.** `getPublicListings()`
(`src/lib/public-listings.server.ts`) already drops sandbox/demo listings from
the public catalog in production via `filterSandboxFromPublicCatalog`; the
manager-registration choke point above extends that same guarantee to the
Claw line's OTHER lookups (a manager's own-listing tools, the default/anchor
listing, notification fan-out) by ensuring `landlordId` is never resolved to
a sandbox manager in the first place. Do not add a second, independent
sandbox filter inside the listing tools themselves (`leasing-sms.ts`) — the
registration choke point is the intended single source of truth; duplicating
the check there would just be another place to forget to update.

## Public SMS consent page (A2P 10DLC carrier review)

Carrier reviewers open a declared consent URL and look for the opt-in with their
own eyes, so PropLane keeps a **public, no-login** consent page at **`/sms-consent`**
(`src/app/(public)/sms-consent/`). Invariants — breaking any of them gets the A2P
campaign rejected on resubmit:

- It must stay **ungated**: no sign-in, no manager link, no required query param.
  It is a plain server component (renders every disclosure with JS off) plus one
  client island (`sms-opt-in-form.tsx`) whose SSR HTML shows the phone field and
  an **unchecked** checkbox. Middleware does not gate top-level paths — keep it
  that way; do not add a `next.config.ts` redirect for it.
- The consent wording lives in **exactly one place**, `SmsConsentCheckbox`
  (`src/components/marketing/sms-consent-checkbox.tsx`), and must match the
  campaign declaration **verbatim** ("…about my rental application and account.
  Msg & data rates may apply. Message frequency varies. Reply STOP to opt out,
  HELP for help."). It is unchecked by default and consent is optional (never a
  precondition for applying). Locked by `tests/unit/tours-contact-sms-consent-ui.test.tsx`
  and `tests/unit/sms-consent-page-form.test.tsx`.
- The **real** opt-in lives in the rental application flow: the same checkbox
  renders in the wizard Contact step (`rental-wizard-steps.tsx`, step 4), gated
  on the same Phone question as the phone input (no phone collected → no consent
  control), and persists `smsConsent` / `smsConsentAt` /
  `smsConsentWordingVersion` on the submitted application snapshot
  (`RentalWizardFormState`). The number the applicant enters is the one that
  receives texts. The timestamp + wording version are **server-owned**
  compliance evidence: `POST /api/manager-applications` stamps them
  (`anchorServerOwnedSmsConsent`), preserving the first server stamp across
  draft re-upserts and clearing both only on an EXPLICIT `smsConsent: false`
  (a blob that merely omits the field — a legacy client or pre-deploy manager
  mirror — preserves the stored evidence) — client-supplied values are never
  trusted. The wording version constant lives in
  `src/lib/rental-application/sms-consent.ts` (plain TS, imported by both the
  checkbox and the route); **bump `SMS_CONSENT_WORDING_VERSION` whenever the
  checkbox wording changes**. Coverage:
  `tests/unit/manager-applications-sms-consent-stamp.test.ts`.
- Privacy (`/privacy`) and Terms (`/tos`) must name **PropLane** at
  **prop-lane.space** (they do) — the consent page and the campaign both link to
  them; a brand/domain mismatch invites a second rejection.
# Shared Claw line retired (August 6, 2026)

The shared Claw phone and transport are disabled. Environment flags cannot
reactivate them, new managers are never stamped with the shared number, and the
cleanup migration removes the legacy number from existing profiles. Public
listing SMS uses the listing manager's verified phone; managed messaging uses
the manager's own registered Twilio number. The Claw sections below are retained
only as historical implementation notes while the old modules and tables are
removed incrementally.

## Manager agent reminders

Proactive reminders to the owning manager use the same `notifyManagerFromAgent`
delivery path as other PropLane Assistant notices. Preferences → Manager alerts
is authoritative: `none` sends nothing, `assistant` writes the in-app Assistant
notice and push, `personal_number` sends the grounded reminder from the
manager's active work number to their personal phone (falling back to Assistant
until both phone legs are ready), and `both` sends both copies.

`/api/cron/dispatch-reminders` runs every five minutes. Tour, manager-assigned
task, service-order, and work-order sweeps enqueue manager-role copies alongside
counterparty reminders. The dispatcher never self-sends those rows through the
ordinary inbox transport; it renders the snapshotted payload and hands the
result to `notifyManagerFromAgent`. Lifecycle task metadata maps lease/tour
actions to `leasing`, application review to `applications`, work-order tasks to
`maintenance`, and rent collection to `payment_reminders`, so the topic-level
phone choices remain effective. A resident-signature transition also produces
an immediate leasing reminder for the manager to countersign.
