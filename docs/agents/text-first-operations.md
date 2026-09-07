# Text-first operations — the message → action matrix (PRP-264)

**Read this before adding an SMS-reachable capability.** It is the product spec
the "text-first operations" epic asked for: which message, from which role,
produces which action, behind which gate. Everything below rides the ONE
assistant framework (`docs/ai-assistant.md`): a role-scoped registry, a
`defineWriteTool` preview, and a confirmation gate. There is no second
"SMS command parser" and there must never be one.

## The one idea

The portal is the source of truth for detail; **SMS and chat are the command
surface.** A person texts a work-order number (or describes a problem once),
PropLane resolves the row *within that person's own scope*, proposes the right
action, and every affected party is notified through the channels they already
have. Nobody has to open the portal for routine operations, and nothing happens
that the portal could not do — the tools ARE the portal's capabilities.

## Surfaces and gates

| Role | Inbound surface | Registry | How a write is confirmed |
| --- | --- | --- | --- |
| Manager (verified cell → own work number) | `resolveManagerSmsInboundIdentity` | `buildManagerSmsRegistry(access)` = portal catalog **minus every `destructive` tool**, minus landlord-wide tools on a delegated (co-manager) turn | Preview → reply **`YES`** (`src/lib/sms/agent-confirmation.server.ts`) |
| Resident (texting the manager's work number) | resident SMS turn (`sms-agent-turn.server.ts`) | `residentAgentRegistry` (every row `resident_email`-scoped) | Preview → reply **`YES`**; at most ONE open proposal per resident, a new proposal supersedes the old |
| Vendor (verified phone with an active job) | vendor SMS turn | `vendorWorkOrderAgentRegistry` — three reads pinned to one job + `escalate_to_manager` | Answer-only. The single write is inline-allowed because it only notifies the manager |
| Prospect (anonymous, texting a work number) | leasing SMS agent | `leasingSmsAgentRegistry` | No card is possible (no `user_id`); the two inline writes — `request_tour`, `escalate_to_manager` — file a request and change nothing the manager has not then seen |
| Any role, portal chat | `/api/agent/{chat,resident-chat,vendor-chat}` | the same registries | Preview card → Confirm (POSTs only the action id) |

Rules that never bend:

- **Destructive tools are portal-only.** Over SMS the only credential is the
  Twilio `From` header and the confirmation is a bare `YES` with no card to
  re-read; the exclusion is derived from the `destructive` flag, never a name
  list (`docs/agents/sms-system.md`).
- **The YES vocabulary is a small exact allowlist.** "ok" and "sure" are
  conversation, never authorization.
- **A stable work-order handle drives resolution, never access.** `WO-1042`,
  `#1042`, `status 1042` are parsed before intent handling; resolution goes
  through the same scoped loaders the portal uses, and "not found" is the same
  reply whether the row is outside scope or does not exist — no cross-tenant
  existence oracle.
- **Every turn is traced.** `traceAgentTurn` wraps each SMS turn
  (`sms-agent-turn.server.ts`) with `landlordId`, actor, prompt hash and tools;
  a `YES` is scored on the proposal trace by `runConfirmedPendingActionForPortal`
  (`traceAgentAction`, `action-approved`). A failure is reproducible from its
  trace or it is a bug.

## Message → action matrix

Status: **live** = on production today; **PRP-nnn** = filed; **—** = not planned.
"Gate" is the confirmation the write needs on SMS.

### Manager

| The manager texts… | Action | Tool | Gate | Status |
| --- | --- | --- | --- | --- |
| "status 1042" / "what's going on with 1042" | Read the request, vendor, visit, bids | `list_work_orders`, `get_job_details` | read | live |
| "create a work order at Cascade: leaking tap in room 2" | Create the request | `create_work_order` | YES | live |
| "assign Bob to 1042" / "offer 1042 to my plumbers" | Assign / offer to vendors | `assign_vendor`, `offer_to_vendors`, `suggest_vendors_for_work_order` | YES | live |
| "accept the $180 bid on 1042" | Accept a bid (becomes the immutable payout anchor) | `accept_bid`, `list_work_order_bids` | YES | live |
| "schedule the visit for 1042 Tuesday 10am" | Book the vendor visit, notify resident + vendor | `schedule_vendor_visit` | YES | live |
| "remind the vendor about 1042" | Nudge the assigned vendor | `send_work_order_reminder` | YES | live |
| "1042 is done" | Complete the request | `complete_work_order` | YES | live |
| "approve and pay 1042" | Approve + Connect payout | `approve_and_pay_work_order` | **portal-only** (destructive) | live, withheld on SMS |
| "approve the parking request from Maya" | Decide an add-on service request | `decide_service_request` | YES | live |
| "remind John about rent" / "mark March rent paid" | Reminder / mark paid | `send_rent_reminder`, `mark_charge_paid` | YES | live (PRP-270) |
| "reply to the prospect who texted about room 3" | Reply on the SMS thread from the work number | `reply_to_thread` | YES | PRP-424 |

### Resident

| The resident texts… | Action | Tool | Gate | Status |
| --- | --- | --- | --- | --- |
| "status of my request" / "1042?" | Read own requests | `list_my_work_orders`, `list_my_service_requests` | read | live |
| "the heater is broken" | File a maintenance request | `report_maintenance_issue` | YES | live (description only) |
| "…and here is a photo / it's urgent / mornings only" | Full fields + photo attachments on the report | `report_maintenance_issue` (parity with the Services form) | YES | PRP-269 |
| "change 1042 to afternoons" / "add a note" | Edit own request | `update_work_order`, `add_service_request_note` | YES | PRP-268 (note: live) |
| "cancel 1042" | Cancel own request | `cancel_work_order` | YES | PRP-268 |
| "any update on 1042?" (to the manager) | Nudge the manager | `nudge_manager_on_work_order` (send-reminder route) | YES | PRP-268 |
| "I want parking" | Add-on service request | `create_service_request` | YES | live |
| "what do I owe" / "pay rent" | Balance / start checkout | `get_my_balance`, `list_my_charges`, `start_rent_payment` | read / YES | live |
| "I paid by Zelle" | Report a manual payment | `report_manual_payment` | YES | live |
| "tell the manager …" | Message the manager | `send_message_to_manager` | YES | live |

### Vendor

| The vendor texts… | Action | Tool | Gate | Status |
| --- | --- | --- | --- | --- |
| "details for 1042" / "gate code?" | Job details, access info | `get_job_details`, `get_job_access_info` | read (pinned to the job) | live |
| "what else do I have with this manager" | Other active jobs | `list_my_jobs_with_this_manager` | read | live |
| "I can't make it / the part is back-ordered" | Escalate to the manager | `escalate_to_manager` | inline (notify only) | live |
| "done" / "invoice $180" | Mark complete / submit invoice | `submit_vendor_invoice` | — on SMS (portal `vendorAgentRegistry` only; money and completion need the portal card) | live in portal, not planned for SMS |

### Prospect (leasing)

| The prospect texts… | Action | Tool | Gate | Status |
| --- | --- | --- | --- | --- |
| "is the U-District room still open?" | Find / describe a listing | `list_live_listings`, `get_listing_details` | read | live (PRP-426 widens matching to ad titles) |
| "how do I apply / see it" | Send apply / tour / browse links | `build_prospect_links`, `get_site_links` | read | live |
| "can I see it Saturday?" | File a tour request (manager confirms) | `list_open_tour_slots`, `request_tour` | inline (request only) | live |
| anything the tools cannot answer | Hand to the manager | `escalate_to_manager` | inline (notify only) | live |

## Notifications: who hears what

Every action above notifies through the parties' existing channels — inbox
notice always; email/SMS per the recipient's notification preferences
(`deliverPortalInboxMessage` with `eventCategory`, PRP-425). A vendor visit
scheduled by text notifies the resident and the vendor; a resident's nudge lands
in the manager's inbox and, with a work number, as a text; a manager's
completion notifies the resident. The WO handle appears in every outbound
message so a reply can reference it.

## Sequencing of the children

1. **PRP-268** resident edit / cancel / nudge — the largest gap in the resident
   column; unlocks the "reply to the reminder" loop.
2. **PRP-269** full maintenance report with photos — makes the first text as
   good as the form.
3. **PRP-424** manager `reply_to_thread` on SMS threads — closes the loop from
   the manager's side.
4. Vendor completion/invoice over SMS — deliberately **not planned**: money and
   completion stay behind the portal card until the vendor SMS surface has a
   confirmation mechanism as strong as the resident's.

## Adding a row to this matrix

1. Add the tool on the role's registry through `defineWriteTool` with a preview
   (`docs/ai-assistant.md` checklist). No preview → unreachable, not safer.
2. Decide the gate: YES for a resident/manager write; inline only when the tool
   merely notifies; `destructive: true` keeps it off SMS automatically.
3. Make the WO handle resolvable for the new path through the scoped loaders —
   never a global lookup.
4. Add the row here, and a test in `tests/unit/tools/` that the tool is present
   on the intended registry and absent from every other.
