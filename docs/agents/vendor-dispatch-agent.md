> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

# Vendor dispatch + 24/7 vendor messaging agent

**Everything ships dark until a manager opts in** via `manager_automation_settings.vendor_dispatch`
(`src/lib/vendor-dispatch-settings.ts`; UI: "AI vendor dispatch" card in the payments
reminder-settings modal). Mode `off | approve | auto`; `agentMessagingEnabled` gates the
vendor-facing agent; guardrails = approved vendor list, categories, spend cap (advisory —
dispatch commits no money; real enforcement stays at bid-accept).

**Dispatch is deterministic — no LLM call.** New resident work orders (POST
`/api/portal-work-orders`, new-row detection + `after()`) trigger `prepareDispatch`
(`src/lib/work-order-dispatch.server.ts`): ranks vendors via the existing
`suggestVendorsForWorkOrder`, persists a proposal on `row_data.dispatch`
(type `WorkOrderDispatch`, client-safe module `src/lib/work-order-dispatch.ts` — the row
type is extended via `WorkOrderRowWithDispatch`, NOT by editing `DemoManagerWorkOrderRow`),
audit-logs with dedupe key `dispatch_prepare:{id}` (client re-sync replays are no-ops), and
notifies the manager (`notifyManagerFromAgent` in `src/lib/agent-notify.server.ts` — direct
inbox-row write + push + optional SMS). **`POST /api/portal/dispatch-proposals` is the ONLY
path that approves or declines a proposal today**, and the manager card in the work-orders
panel is its one surface. It calls `executeDispatch`: server
re-derives everything from the persisted proposal (client sends only workOrderId), re-checks
vendor ownership, assigns (acceptBid write pattern), books the vendor's next open slot when
availability exists, notifies the vendor, and best-effort notifies the resident
(vendor-assigned always, plus visit-scheduled when a slot was booked — mirroring the manual
manager flow). Auto mode runs the same executor when `guardrailsAllowAutoDispatch` passes,
else downgrades to a proposal. `row_data.dispatch` is strictly server-owned: the work-orders
POST drops any client-supplied `dispatch` and replaces it with the persisted server copy (or
deletes it when none exists), so a forged proposal on a brand-new resident row can't spoof
the manager UI or suppress the real dispatch.

**The assistant cannot approve a dispatch — a known capability GAP, not a design choice.** A
`confirmAction.type === "dispatch_work_order"` branch in `src/app/api/agent/chat/route.ts`
(line 62 at `a2449a06^1`) used to let a manager confirm a dispatch straight from chat; the
Cursor write-action-framework lane (`a6e6568d`, merged as `a2449a06`) rewrote that route and
dropped it, and the later one-framework reconciliation kept it out. Do NOT hand-restore that
legacy special-case confirm branch — there is exactly ONE write-action framework
(`docs/ai-assistant.md`), and a second confirm path is what the reconciliation existed to
remove. The follow-up `axis-restore-dispatch-approval` restores this as a `defineWriteTool`
whose `preview` renders the persisted proposal and whose `handler` calls `executeDispatch`, so
it goes through the same `agent_pending_actions` gate as every other write.

**The vendor agent is answer-only by construction.** Registry
`vendorWorkOrderAgentRegistry` (`src/lib/tools/domains/vendor-work-order.ts`) = 3 reads
pinned to ONE work order via `ctx.vendorScope` (which also drops read access the moment the
manager reassigns the work order to another vendor, mirroring the portal GET route's
`vendor_user_id` scoping) + `escalate_to_manager`, the single write,
autonomously callable through the explicit `allowWriteTools` allowlist added to
`runAgentTurn`/`toAnthropicTools`/`runReadTool` (a boolean would silently open future
writes; the allowlist can't). No reschedule/price tools exist. Access codes live in
`manager_property_access` — a SEPARATE owner-only-RLS table, deliberately NOT a column on
`manager_property_records` whose `select_live` policy exposes live rows to the anon key —
and are released only by `get_job_access_info` when the session's vendor is assigned AND
the visit is scheduled (`resolveWorkOrderAccessInfo` overlays property defaults with the
resident's per-work-order `entryPermission`/`entryNotes` from intake).

**Conversations reuse the once-dormant `agent_sessions`/`agent_messages` tables**
(`20260716120000_vendor_agent_sessions.sql`; kind `vendor_work_order`, one session per
(work order, vendor), non-partial unique index because PostgREST upsert can't infer partial
indexes). Both channels share one session + one vendor inbox thread (`thread_type:
"vendor_agent"`): inbound SMS (`/api/twilio/inbound` for manager work numbers (legacy `/api/webhooks/twilio/sms` remains available) — Twilio signature over
`TWILIO_WEBHOOK_URL`/derived origin, fail-closed on Vercel, per-phone rate limit, STOP
unbinds the number + sets `profiles.sms_opt_out_at` without killing the in-app thread,
unknown numbers silently dropped, empty TwiML + `after()` turn) and in-app replies
(`send-inbox-message` thread-append hook, owner-only, short-circuits normal fan-out).
`runVendorAgentSessionTurn` (`src/lib/agent/vendor-agent.server.ts`) enforces a
20-inbound/hour session cap, runs the pinned-Sonnet turn with
`VENDOR_AGENT_SYSTEM_PROMPT` (language-mirroring: replies in whatever language the vendor
writes), persists both sides, mirrors SMS into the inbox thread, and delivers replies
(inbox append always + the prepaid work-number dispatcher) — delivery is code, never a
model tool. The SMS leg is consent-gated: it fires only when the vendor is replying to their
own SMS (inherently responsive) or has granted `sms_consent_at`, and the unsolicited opening
text goes out only to a consented signed-up vendor (a pre-signup invitee was disclosed the
job-texts terms in the invite modal, so their number is fair game). Langfuse traces every
turn as `vendor-agent-turn` grouped by session id.

**Vendor contact fields**: `profiles.phone` (E.164, validated by the intl-aware
`normalizeE164` in `src/lib/phone-e164.ts`, re-exported from `src/lib/twilio.ts`),
`preferred_language`,
`sms_consent_at` (vendor-granted in settings; a manager can never consent for them),
`sms_opt_out_at` (STOP) — profiles is canonical for the agent; the directory row keeps a
display copy + pre-signup `preferredLanguage`/phone from the invite modal.

**Deploy**: `npm run db:push` for `20260715120000` (vendor_dispatch), `20260715130000`
(manager_property_access), `20260715140000` (profiles contact), `20260716120000`
(agent sessions); env `AXIS_AGENT_SMS_FROM` (+ optional `TWILIO_WEBHOOK_URL`); Twilio
console: number + A2P 10DLC campaign + inbound webhook + Advanced Opt-Out. `vercel.json`
unchanged. Not yet built from the plan: vendor portal UX overhaul (M7) and Spanish-first
vendor i18n (M8) — see `/Users/akhilvemuri/.claude/plans/i-want-to-work-sorted-bengio.md`.

Work-number inbound resolution additionally scopes sessions by `landlord_id` from
the destination number. SMS turns reserve AI credit before running; completion
metadata and a stable outbox dedupe key make delivery retries safe.
