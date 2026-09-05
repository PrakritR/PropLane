# PropLane Assistant — architecture, tool catalog, and how to extend it

The in-app AI assistant ("PropLane Assistant") runs on **all three portals** —
manager/admin, resident, and vendor — with one shared agent core and a
portal-scoped tool registry per surface. Users ask in natural language; the
assistant answers from live data and **proposes** actions that only execute
after the user explicitly confirms.

All conversational surfaces assemble their runtime prompt through
`src/lib/agent/system-prompts.ts`. It is the catalog for portal, public-site,
leasing SMS, resident SMS, vendor work-order SMS, and resident inbox agents.
Role-specific tool and safety instructions remain in the adjacent prompt files,
while the catalog applies one standing natural-response policy everywhere and a
stricter no-markdown policy to SMS. Personal instructions are appended only
after that assembled platform prompt on surfaces that support them. Traced
surfaces hash the exact final string in Langfuse.

## Architecture

```
axis-assistant.tsx (one panel, portal-aware copy/suggestions/endpoints)
        │
        ▼
GET/POST /api/agent/chat            (manager/admin) ┐
GET/POST /api/agent/resident-chat   (resident)      ├─ resolve portal context → registry
GET/POST /api/agent/vendor-chat     (vendor)        ┘
POST /api/agent/demo-chat       (public /demo sandbox, simulated actions)
        │
        ▼
runAgentTurn (src/lib/agent/loop.ts)
  · Anthropic SDK, native tool-calling, ≤8 iterations
  · model routed per turn by complexity (src/lib/agent/model.ts)
  · READ tools run inline; so do writes the SURFACE allow-listed
    (allowWriteTools — e.g. the SMS agents' escalate_to_manager)
  · every other WRITE tool call runs its preview() and HALTS the turn
        │
        ▼ (write proposal)
agent_pending_actions row (validated input + preview; 15-min TTL by default,
  longer for async queues like the 7-day tour approvals)
  → client renders PendingActionCard from the preview
        │ user confirms
        ▼
POST back to the SAME chat endpoint  { confirmActionId } | { denyActionId }
  · atomic exactly-once claim (actor-scoped on user_id, expiry-checked)
  · the claimed row's portal must match the calling route's portal
  · re-validates stored input against the tool's CURRENT schema
  · tool handler() re-resolves every target from actor-scoped data
  · audit_log row written BEFORE the side effect (dedupe_key idempotency)
```

### The three contexts (security choke points)

| Portal | Resolver | Scope rule every tool must apply |
|---|---|---|
| manager | `resolveAgentContext` (`src/lib/tools/context.ts`) | `.eq("manager_user_id", ctx.landlordId)` |
| resident | `resolveResidentAgentContext` (`src/lib/tools/resident-context.ts`) | `.or("resident_user_id.eq.<uid>,resident_email.eq.<email>")` or `.eq("resident_email", …)` |
| vendor | `resolveVendorAgentContext` (`src/lib/tools/vendor-context.ts`) | `.eq("vendor_user_id", ctx.userId)` |

Identity always comes from the authenticated session — **never** from model
input. `buildRegistry` throws at module init if a write tool's input schema
declares an identity-shaped field (`landlordId`, `manager_user_id`, …).
Target ids (a charge id, a recipient email) are allowed in inputs and are
re-verified against actor-scoped data in both `preview()` and `handler()`. A
target that unavoidably reads as an identity (`submit_vendor_invoice`'s
`managerUserId`, the manager being BILLED) opts out explicitly via
`allowedIdentityInputs` and is re-verified in both phases.

### Registries

- Manager: `src/lib/tools/index.ts` (`agentRegistry`)
- Resident: `src/lib/tools/resident-index.ts` — filtered per request by
  application phase and the linked manager's subscription tier, so the
  assistant's capabilities always equal the resident portal's.
- Vendor: `src/lib/tools/vendor-index.ts`

### Write-action lifecycle

1. Model calls a write tool → `previewWriteTool` Zod-validates and runs
   `preview(ctx, input)` (READ-ONLY: validate against live data, build an
   `ActionPreview`). The preview signals failure by THROWING; the message is
   fed back as a `tool_result` error so the model self-corrects.
2. The loop halts and returns `pendingAction`; the chat route persists it with
   `createPendingAction` and sends the client only `{id, preview}` — never the
   raw input. A preview that resolved something the user is approving (an
   auto-picked visit slot) pins it with `confirmedInput`, which
   `previewWriteTool` STRIPS out of the stored/returned preview and uses as the
   stored input, so the handler executes exactly what the card showed.
3. The user confirms → the client posts `{ confirmActionId }` back to the same
   chat endpoint → `runConfirmedPendingActionForPortal` claims the row
   atomically (`status='proposed' AND expires_at > now() AND user_id = <me>`),
   checks the row's portal against the caller's, re-validates against the
   tool's CURRENT schema, and runs `handler(ctx, input)`. A claim that does not
   land returns a single 410 whatever the reason, so the response can never
   enumerate other users' action ids.
4. `handler` re-resolves ownership of every target, writes the audit row
   FIRST (`writeAuditLog`, `src/lib/tools/audit.ts`), performs the side
   effect, then stamps the outcome (`updateAuditResult`). A throw is recorded
   with `markPendingActionFailed` — never silently left reading "executed".

Batch actions are **tool-level array inputs** (e.g. `send_rent_reminder`
takes `chargeIds[]`) — one proposal, one card, one confirm; per-target dedupe
keys keep every item independently idempotent.

Dedupe-key conventions:
- Repeatable sends: `{tool}:{scopeId}:{targetId}:{YYYY-MM-DD}`
- One-shot transitions: `{tool}:{scopeId}:{targetId}`

### Sessions & memory

Conversations persist into `agent_sessions` / `agent_messages`
(`src/lib/agent/sessions.ts`) before a successful chat response is returned,
so a refresh, layout switch, or second device can immediately reopen the turn.
Persistence failures remain fail-soft and never replace a valid assistant reply.
Cancelled/expired proposals stay in
`agent_pending_actions` and feed the eval set.

#### Portal chat archive

The portal-wide popup and dock share one `AssistantConversationProvider`, so
opening, pinning, or unpinning the assistant never starts a second transport or
strands a pending confirmation. Their archive is server-backed and follows the
signed-in person across devices:

- Pressing **New chat** immediately creates a main portal
  `agent_sessions.kind = 'portal_chat'` record with a server-owned title, then
  reuses that stable `sessionId` for later turns. Failed database writes are
  logged and reported to the UI rather than being mistaken for an empty archive.
  `agent_sessions_portal_chat_archive_idx` supports newest-first paging by
  `(user_id, portal, updated_at)`.
- Each role-scoped chat route exposes `GET`: without `sessionId` it returns a
  paginated list (and accepts an optional private `search` query over that
  person's prompts); with one it returns a transcript and, only when it is still
  proposed and unexpired, its safe confirmation preview. Stored pending-action
  input is never returned to the browser.
- Every session read/reuse is constrained by authenticated `user_id`, portal,
  and kind. A malformed id is rejected; a foreign/other-portal id returns the
  same not-found response as an unknown id. The client never supplies a role
  or ownership id.
- Modal assistants remain task-scoped: they send `archive: false`, use
  `kind = 'modal_chat'`, and keep their text-only local storage isolated from
  the archive. Existing old browser history is intentionally not imported,
  because it was not user-scoped and could reveal a prior shared-device user's
  chat. Thread labels use the lowest-cost configured Claude model (Haiku) to
  produce a 2–4 word description of the first useful user prompt; a greeting or
  generic help request defers title generation to the next useful prompt. A
  deterministic prompt label is used only if title generation is unavailable.
  Each role route also exposes scoped `DELETE` for one archive item; it removes
  that transcript and marks an attached, unconfirmed draft as denied. V1
  provides new chat, browse, prompt search, resume, pagination, delete, and
  pending-preview restoration; it intentionally has no rename.

#### Personal custom instructions

`agent_user_preferences` stores one private `custom_instructions` record per
authenticated user. `GET/PATCH /api/agent/preferences` authenticates the user
server-side, accepts at most 2,000 characters, and clears the row for an empty
value. The shared Settings section is available in manager/admin, resident,
and vendor profiles.

The route loads this value into the relevant signed-in portal prompt, including
task-bound modal assistants. It is deliberately a lower-priority prompt block:
it may guide tone, format, and relevant drafted content for the intended
recipient (for example, how to close a resident message), but it can never
override platform instructions, tool scope, grounded facts, privacy,
untrusted-content handling, or confirmation-gated writes.

For automated prospect SMS, `runLeasingSmsAgentTurn` loads the preference of
the manager who owns the sending work number (`session.landlord_id`), not a
prospect-supplied identity. Those preferences may shape a relevant prospect
reply, while the leasing agent's SMS brevity, listing-data access, escalation,
and safety rules still win. Manager Settings explicitly call out this behavior.

### Images

The manager chat accepts up to 3 images on the **last user message only**
(client downscales to ≤1568px JPEG; server validates via
`src/lib/agent/images.ts`; ≤4MB total under the Vercel body cap). The model
reads them natively — "create a property from these listing pictures" flows
into the `create_property` write tool, whose confirm card shows every
extracted field for human verification before a draft (never live) listing is
created.

## Observability & analytics (build requirement)

- **Langfuse** (`src/lib/observability/langfuse.ts`): one `axis-agent-turn`
  trace per turn (per-LLM-call generations with tokens/cost, per-tool spans
  with full args/results, `pending:<tool>` spans for proposals) and one
  `axis-agent-action` trace per confirm/cancel. Traces carry the
  `TraceActor` metadata: role + landlordId (manager) or managerIds
  (resident/vendor). The trace session identity and fully composed system prompt
  (including any saved custom-instruction block) are retained for replay.
  No-ops when `LANGFUSE_*` env is unset.
- **PostHog** (ids/enums only, never PII): `assistant_opened` (the `/demo`
  surface adds `{surface}`), `assistant_message_sent {portal, tools, model,
  tier}`, `assistant_action_proposed {portal, tool, batch}`,
  `assistant_action_confirmed {portal, action}`,
  `assistant_action_denied {portal, known}`. There is no
  `assistant_action_cancelled` — it died with the standalone confirm route;
  denials are `assistant_action_denied`.

### Latency-aware model routing

Interactive text turns use a conservative two-provider route. When enabled,
clear product questions use no tools and clear single-record lookups expose
exactly one read tool to OpenRouter's `google/gemini-3.5-flash-lite` model.
Attachments, writes, ambiguous/multi-step questions, SMS, and complex analysis
remain on Anthropic. The fast lane is read-only and has one Anthropic retry, so
an OpenRouter failure cannot execute or duplicate an action. Every trace and
`assistant_message_sent` event records provider, route, fallback, and latency.

Configure the server-only `OPENROUTER_API_KEY`, then set
`AXIS_AGENT_FAST_ENABLED=true` and move `AXIS_AGENT_FAST_ROLLOUT_PERCENT` from
0 to 10, 50, and 100 only after checking latency and fallback rates. Requests
set OpenRouter `data_collection: "deny"`; disable OpenRouter input/output
logging and data-discount sharing in its dashboard. Never expose the key in a
`NEXT_PUBLIC_*` variable.

## Security model

- **Confirmed-by-human is the backstop.** The model can only produce a
  pending row; nothing in a tool result can execute anything. `runReadTool`
  refuses write tools even if one reaches it (defense in depth).
- **Prompt injection:** tenant/applicant/vendor/message text returned by
  read tools is wrapped as
  `{ untrustedContent: "<<<EXTERNAL_MESSAGE …>>> … <<<END…>>>" }` and every
  system prompt forbids following instructions found in tool results or
  proposing actions because tool-result text asked.
- **Cross-tenant isolation** is enforced three times: context resolution,
  every tool's own scope filter, and handler-time re-resolution. Unit suites
  (`tests/unit/tools/*scope-isolation*`, `pending-actions.test.ts`) seed
  foreign rows and assert they never surface.
- **Anti-enumeration:** every claim that does not land — unknown id, expired
  row, already-confirmed row, another actor's row — returns the same 410, so a
  response can never reveal that someone else's action id exists.
- **Rate limits:** per-user on every chat route (confirm/deny posts back to the
  same route, so it is rate-limited with the turn); per-IP on the public demo.
- **Money invariants:** `approve_and_pay_work_order` transfers exactly the
  accepted bid's `amount_cents` (immutable anchor — never a model- or
  client-supplied amount); vendor `set_my_price` refuses once a bid is
  accepted.

## Tool catalog

> The live source of truth is the registry files; this table is the
> orientation map. Kind: R = read, W = confirm-gated write, W* = inline
> low-risk write the surface allow-lists (`MANAGER_INLINE_WRITE_TOOLS`, still
> audited by its own handler).

### Manager (`src/lib/tools/index.ts`)

See `src/lib/tools/domains/` — payments (`get_overdue_charges`,
`list_charges`, `send_rent_reminder` W batch), charges (`create_charge` W,
`update_charge` W, `delete_charge` W, `mark_charge_paid` W), automation
(`get_automation_settings` R, `update_automation_settings` W,
`cancel_scheduled_reminder`/`reschedule_reminder` W), messaging
(`send_message` W, `schedule_message` W, `cancel_scheduled_message` W),
inbox (`list_inbox_threads` R, `get_thread_messages` R, `reply_to_thread` W,
`update_thread` W*),
calendar (`list_calendar_events` R, `list_tour_inquiries` R,
`update_manager_availability` W, `create_calendar_event` W,
`cancel_calendar_event` W, `accept_tour_inquiry` W, `confirm_tour_inquiry` W —
backs the approval-first auto-tour proposals), tours (`list_open_tour_slots` R —
the ONE source of bookable times; `book_tour` W from scratch, `reschedule_tour` W,
`cancel_tour` W, both of which email the guest; see
`docs/agents/tours-scheduling.md`), work orders
(`list_work_orders` R, `list_work_order_bids` R, `suggest_vendors_for_work_order` R,
`create_work_order` W, `assign_vendor` W, `offer_to_vendors` W,
`schedule_vendor_visit` W, `accept_bid` W, `complete_work_order` W,
`approve_and_pay_work_order` W destructive, `send_work_order_reminder` W),
properties (`list_properties` R, `get_property_details` R, `create_property` W,
`update_property` W, `share_property_link` W), residents (`list_residents` R,
`set_resident_approval` W, `send_resident_welcome` W, `revoke_resident_access`
W destructive, `record_move_out` W), applications (`list_applications` R,
`get_application_details` R, `update_application_bucket` W,
`order_background_check` W — env-gated, costs money), leases (`list_leases` R,
`create_lease_draft` W, `update_lease_draft` W, `amend_lease` W, `void_lease` W
destructive, `send_lease_for_signature` W),
vendors (`list_vendors` R, `add_vendor` W, `update_vendor` W,
`invite_vendor` W), financials (`run_financial_report` R, `record_expense` W,
`record_income` W — tier-gated), accounting (`financials-write.ts`:
`create_manager_bill` W, `approve_manager_bill` W, `record_bill_payment` W,
`create_manager_budget` W, `update_manager_budget` W, `dispose_security_deposit`
W, `create_owner_distribution` W, `approve_owner_distribution` W,
`reconcile_bank_statement_line` W), search (`find_records` R), profile
(`get_manager_profile` R, `get_dashboard_summary` R), promotions
(`list_promotions` R, `create_promotion` W, `update_promotion` W,
`delete_promotion` W destructive), team (`list_co_managers` R), documents
(`list_documents` R), services (`list_service_requests` R,
`decide_service_request` W).

### Resident (`src/lib/tools/resident-index.ts`)

Reads: `get_my_balance`, `list_my_charges`, `get_my_lease`,
`get_my_application_status`, `list_my_service_requests`,
`list_my_work_orders`, `get_move_in_info`, `list_my_inbox_threads`,
`get_my_payment_methods`, `get_my_scheduled_messages`,
`list_my_shared_documents`, `list_open_tour_slots`. Writes:
`create_service_request`, `add_service_request_note`,
`report_maintenance_issue`, `send_message_to_manager`, `report_manual_payment`,
`request_lease_extension`, `schedule_message`, `cancel_scheduled_message`,
`request_tour` (files a pending inquiry; the manager still confirms),
`start_rent_payment` (returns a hosted Stripe Checkout link — the agent never
completes a payment). Application-phase residents get
`get_my_application_status` + `send_message_to_manager` + the two tour tools
(touring is exactly what a pre-approval resident does); a free-tier manager
hides services/inbox tools.

Deliberately NOT tools: lease signing (legal ceremony — deep-link to
`/resident/lease`), autopay (feature doesn't exist).

### Manager SMS (`buildManagerSmsRegistry()` in `src/lib/tools/index.ts`)

The manager catalog above MINUS every tool flagged `destructive`, for a manager
texting their own work number from their verified cell. Derived from the flag,
never a name list. Reasoning and the upgrade path:
[`docs/agents/sms-system.md`](agents/sms-system.md).

### Prospect leasing SMS (`leasingSmsAgentRegistry`)

Reads: `list_live_listings`, `get_listing_details`, `build_prospect_links`,
`get_site_links`, `list_open_tour_slots`. Writes, both inline allow-listed via
`LEASING_SMS_INLINE_WRITE_TOOLS` because an anonymous texter has no `user_id` to
claim a pending action on: `escalate_to_manager`, `request_tour`. Both only
notify the manager; nothing here books, charges, or reads personal data.

### Vendor (`src/lib/tools/vendor-index.ts`)

Reads: `list_my_jobs`, `get_job_details`, `list_my_bids`, `list_my_offers`,
`list_my_payouts`, `get_my_availability`, `list_my_schedule`,
`list_my_inbox_threads`, `get_my_profile`, plus invoicing
(`list_vendor_invoices`, `list_vendor_payouts` — see
`docs/agents/vendor-invoicing.md`). Writes: `submit_bid`, `set_my_price`
(refuses once a bid is accepted), `mark_job_done`, `update_my_availability`,
`send_message_to_manager`, `submit_vendor_invoice`. Stripe Connect onboarding,
W-9/tax, and document uploads stay on the Profile page (deep-link only).

## What the agent still cannot do

The audited gap list — resident maintenance depth, the resident work-order
lifecycle, the remaining tour tools, and the ceilings that are deliberate — is
[`docs/agents/agent-capability-backlog.md`](agents/agent-capability-backlog.md).
Check it before adding a tool, and prune the row you close.

Inspection capabilities (`list_inspections`, `get_inspection`, `create_inspection`, `save_inspection_observations`, `change_inspection_status`) use the shared manager/resident service and existing confirm gate. See [inspection architecture](agents/inspections.md). Status changes are excluded from manager SMS because completion is irreversible.

## How to add a new tool (checklist)

1. **Define it** in the right `src/lib/tools/domains/` file (or a new one):
   `defineTool` for reads, `defineWriteTool` for writes (preview + handler,
   audit row, dedupe key per the conventions above). Never accept identity
   fields; always scope queries to the context.
2. **Back it with the shared lib.** If the capability lives in an API route,
   extract the logic into a `*.server.ts` lib the route AND the tool share —
   tools never `fetch()` internal routes.
3. **Register it** in the portal's registry index. Resident tools also need a
   `TOOL_SECTION` entry if they belong to a tier-gated section.
4. **Test it**: scope isolation (foreign rows never actionable), preview
   rejection of invalid/foreign ids, audit row + dedupe key, happy path —
   pattern: `tests/unit/tools/`.
5. **Prompt note**: if the tool has honesty caveats (feature limits, money,
   env gating), add a line to the portal's system prompt
   (`src/lib/agent/*system-prompt.ts`).
6. **Analytics**: nothing to do — proposal/confirm/cancel events are emitted
   by the framework. Only add a named PostHog event if the action is a
   funnel moment (reuse existing names first; see AGENTS.md).

## Environment setup

| Var | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | the agent loop and fast-lane fallback |
| `OPENROUTER_API_KEY` | no | optional server-only fast lane |
| `AXIS_AGENT_MODEL` (+ `_SIMPLE/_STANDARD/_COMPLEX`) | no | model overrides per tier |
| `AXIS_AGENT_FAST_ENABLED` / `_ROLLOUT_PERCENT` / `_MODEL` / `_TIMEOUT_MS` | no | OpenRouter fast-lane rollout controls |
| `LANGFUSE_SECRET_KEY` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_BASE_URL` | no | tracing (no-op when unset) |
| `POSTHOG_KEY` / `POSTHOG_HOST` | no | analytics |
| `RESEND_API_KEY` / `RESEND_FROM` | no | outbound email (tools degrade to portal-only delivery) |
| `CHECKR_API_KEY` / `CERTN_API_KEY` | no | background-check ordering (tool reports "not configured" otherwise) |
| Stripe keys + Connect | no | rent checkout links, vendor payouts (tools report honestly when unconfigured) |

Database: migrations `20260625000000_agent_observability.sql`
(`audit_log`, `agent_sessions`, `agent_messages`),
`20260713000000_agent_pending_actions.sql` (creates `agent_pending_actions`,
claimed on `user_id` + status `proposed`, 15-minute default expiry) and
`20260716090000_agent_pending_actions.sql` (additive only — the `portal` and
`session_id` columns; it must never rename the claim key). Apply with
`npm run db:push` (dev/test project only — see
`docs/database-environments.md`).

The archive/preferences extension is
`20260804120000_agent_chat_archive_preferences.sql` (`agent_sessions.title`,
the partial `portal_chat` archive index, and `agent_user_preferences`).
