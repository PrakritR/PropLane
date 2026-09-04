#!/usr/bin/env bash
# File product-vision roadmap tickets (cursor-1, 2026-09-04).
# Captain goal: text-first WO ops, personal AI, platform payments, SaaS messaging, profitability.
#
# Requires LINEAR_API_KEY in .env.local
#
# Usage:
#   bash scripts/linear-file-vision-roadmap-batch.sh
#   bash scripts/linear-file-vision-roadmap-batch.sh --dry-run
#
# Manifest: docs/linear/manifests/product-vision-roadmap-2026-09-04.md

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DRY=()
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY=(--dry-run)
fi

P_AI='09 — AI Assistant'
P_COMM='06 — Communication Hub'
P_PAY='08 — Payments & Finance'
P_GROWTH='12 — Marketing & Growth'
P_ADMIN='05 — Admin Portal'
P_INFRA='01 — Infrastructure & Ops'

MS_SMS='SMS agents'
MS_AUTO='Automation'
MS_MGR='Manager assistant'
MS_RES='Resident assistant'
MS_VND='Vendor assistant'
MS_STRIPE='Stripe & payouts'
MS_EPIC='Epic — Unified hub'

run_ticket() {
  if ((${#DRY[@]})); then
    npm run linear:ticket -- --dry-run "$@"
  else
    npm run linear:ticket -- "$@"
  fi
}

echo "=== Epic: Text-first operations ==="

run_ticket \
  --title "[Epic] Text-first operations — work order number drives actions for all roles" \
  --project "$P_AI" \
  --milestone "$MS_SMS" \
  --priority 2 \
  --labels "Feature,area:ai,area:sms,portal:manager,portal:resident,portal:vendor" \
  --body "$(cat <<'EOF'
## Vision
Managers, residents, and vendors should be able to **text a work order number** (or describe a problem once) and PropLane creates the right **pending actions**, updates the WO, and **notifies every party** — without opening the portal for routine ops. Portal remains the source of truth for detail; SMS/chat is the command surface.

## Scope (umbrella)
- Inbound SMS routes to the correct agent surface (manager / resident / vendor / leasing).
- Outbound confirmations and reminders reference a stable **WO id** humans can reply to.
- Every automated action goes through existing **write-tool preview + confirm** (portal) or **SMS YES gate** (manager SMS).

## Relates
- PRP-102 Unified messaging hub
- `docs/agents/sms-system.md`, `docs/agents/vendor-dispatch-agent.md`
- `docs/agents/agent-capability-backlog.md`

## Acceptance
- [ ] Written product spec with message → action matrix per role
- [ ] Child implementation tickets filed and sequenced
- [ ] Langfuse traces for every SMS turn
EOF
)"

echo "=== SMS + automation (under PRP-102 where noted) ==="

run_ticket \
  --title "[SMS] Resident texts maintenance issue → create work order + notify manager and vendor" \
  --project "$P_COMM" \
  --milestone "$MS_SMS" \
  --priority 2 \
  --labels "Feature,area:sms,portal:resident,portal:manager,portal:vendor" \
  --body "$(cat <<'EOF'
## User story
As a resident, I text my manager's PropLane number describing a problem; the system creates a **real** `portal_work_order_records` row, dispatches to vendor when configured, and texts back a WO reference id (e.g. WO-12345) with status I can query by replying with that number.

## Current state
`report_maintenance_issue` exists for in-app assistant; resident SMS path uses `createWorkOrderFromResidentSms` with inferred fields only (`docs/agents/agent-capability-backlog.md`).

## Expected
- [ ] Inbound resident SMS → maintenance agent with landlord scoping
- [ ] WO row + dispatch + thread message to manager
- [ ] Reply template includes WO reference number
- [ ] Idempotent dedupe per session/hour

## Relates PRP-102
EOF
)"

run_ticket \
  --title "[SMS] Reply with work order number to get status or take allowed actions" \
  --project "$P_COMM" \
  --milestone "$MS_AUTO" \
  --priority 2 \
  --labels "Feature,area:sms,area:ai,portal:manager,portal:resident,portal:vendor" \
  --parent PRP-102 \
  --body "$(cat <<'EOF'
## User story
Any authorized party texts **"WO-12345"** or **"status 12345"** and receives current job status, next step, and (where allowed) one-tap replies: confirm visit, request reschedule, escalate to manager.

## Implementation notes
- Parse WO id against caller's scoped rows (manager owner, resident email, vendor assignment).
- Read-only by default; writes only through gated tools / YES confirmation on SMS.
- Vendor surface stays answer-only except `escalate_to_manager` unless captain expands allowlist.

## Acceptance
- [ ] Parser + auth matrix documented
- [ ] Happy path for manager, resident, vendor
- [ ] Unknown or cross-tenant WO returns generic reply (no oracle)
EOF
)"

run_ticket \
  --title "[SMS] Automated rent payment reminders to residents with pay link" \
  --project "$P_COMM" \
  --milestone "$MS_AUTO" \
  --priority 2 \
  --labels "Feature,area:sms,area:payments,portal:resident,portal:manager" \
  --body "$(cat <<'EOF'
## User story
When a charge is due or overdue, PropLane texts the resident a **Stripe Checkout link** (platform-only payment) and logs the reminder on the household thread.

## Current state
Manager can send rent reminders from UI; no scheduled SMS payment reminder product.

## Expected
- [ ] Manager-configurable cadence (due date, +3d, +7d)
- [ ] Uses `resolveServiceFeePayerFor` — **launch default: no PropLane markup** (pass-through Stripe only when resident pays fee)
- [ ] Opt-out respects `notification-preferences`
- [ ] Langfuse + audit log per send

## Relates
`docs/agents/resident-payments.md`
EOF
)"

run_ticket \
  --title "[SMS] Manager digest — tasks that need attention (payments, WOs, applications)" \
  --project "$P_AI" \
  --milestone "$MS_MGR" \
  --priority 3 \
  --labels "Feature,area:ai,area:sms,portal:manager" \
  --body "$(cat <<'EOF'
## User story
As a manager, I receive a daily or weekly SMS summarizing **Needs attention** items (unpaid charges, open WOs, pending applications, unsigned leases) with deep links to the portal or one-word SMS actions where safe.

## Expected
- [ ] Pulls from same sources as `manager-dashboard.tsx` attention groups
- [ ] Destructive actions NOT on SMS without portal confirm (see AGENTS.md SMS ceiling)
- [ ] Preference: assistant vs SMS in manager notification settings
EOF
)"

echo "=== AI assistant depth ==="

run_ticket \
  --title "[AI] Resident work-order lifecycle tools — edit, cancel, nudge manager" \
  --project "$P_AI" \
  --milestone "$MS_RES" \
  --priority 2 \
  --labels "Feature,area:ai,portal:resident" \
  --body "$(cat <<'EOF'
## Gap
UI supports edit/cancel/nudge in `resident-services-panel.tsx`; agent cannot (`docs/agents/agent-capability-backlog.md`).

## Deliverables
- [ ] `update_work_order` write tool with preview
- [ ] `cancel_work_order` write tool
- [ ] `nudge_manager_on_work_order` write tool (wraps send-reminder route)
- [ ] Registered in `residentAgentRegistry` + confirm gate tests
EOF
)"

run_ticket \
  --title "[AI] Resident maintenance report — full fields + photo attachments via chat" \
  --project "$P_AI" \
  --milestone "$MS_RES" \
  --priority 2 \
  --labels "Feature,area:ai,portal:resident" \
  --body "$(cat <<'EOF'
## Gap
`report_maintenance_issue` is description-only; UI collects title, priority, category, arrival window, entry permission, photos.

## Design
Chat route stashes parsed images (`src/lib/agent/images.ts`); tool references attachment index server-side — do NOT put base64 in tool schema.

## Acceptance
- [ ] Schema parity with `resident-add-service-modal.tsx`
- [ ] Photos persist to work order record
- [ ] Preview shows all fields before confirm
EOF
)"

run_ticket \
  --title "[AI] Manager assistant — payment reminders and charge actions via confirm card" \
  --project "$P_AI" \
  --milestone "$MS_MGR" \
  --priority 2 \
  --labels "Feature,area:ai,area:payments,portal:manager" \
  --body "$(cat <<'EOF'
## User story
Manager asks "remind John about rent" or "mark March rent paid" and gets a proper **ActionPreview** card, not a dead-end.

## Audit
Check `agent-capability-backlog.md` + `src/lib/tools/domains/` for missing money tools.

## Acceptance
- [ ] `send_rent_reminder` / schedule reminder tools if missing
- [ ] All money figures tool-grounded
- [ ] Unit tests with `previewWriteTool`
EOF
)"

run_ticket \
  --title "[AI] Agent action quality gate — top-20 write tools E2E preview harness" \
  --project "$P_AI" \
  --milestone "$MS_MGR" \
  --priority 2 \
  --labels "Improvement,area:ai" \
  --body "$(cat <<'EOF'
## Goal
Prove the chatbot creates **proper pending actions** (title, fields, warnings) for the highest-traffic write tools across manager, resident, vendor.

## Scope
- CI script invoking `previewWriteTool` + fake ctx for: `create_work_order`, `report_maintenance_issue`, `schedule_message`, `create_charge`, `escalate_to_manager`, etc.
- Optional Playwright: open assistant, send canned prompt, assert preview card renders (mock LLM or recorded fixtures).

## Evidence (2026-09-04)
Unit suite green for work-order + resident maintenance + loop-write-proposal; extend coverage list in manifest.

## Acceptance
- [ ] Documented tool list per portal
- [ ] Failing preview = CI red
- [ ] Manual playbook in `docs/agents/portal-full-qa-script.md` assistant section
EOF
)"

run_ticket \
  --title "[AI] Langfuse regression suite for denied agent proposals" \
  --project "$P_INFRA" \
  --milestone "Observability" \
  --priority 3 \
  --labels "Improvement,area:ai" \
  --body "$(cat <<'EOF'
## Goal
Use `agent-rejected-actions` eval dataset (`npm run langfuse:sync-eval-dataset`) as a release gate so bad action previews ship less often.

## Acceptance
- [ ] `langfuse:run-regression` in ship preflight or weekly cron
- [ ] Dashboard for `action-approved` / `numeric-grounding` scores
EOF
)"

echo "=== Platform payments ==="

run_ticket \
  --title "[Epic] Platform-only payments — residents pay and vendors receive through PropLane" \
  --project "$P_PAY" \
  --milestone "$MS_STRIPE" \
  --priority 2 \
  --labels "Feature,area:payments,portal:manager,portal:resident,portal:vendor" \
  --body "$(cat <<'EOF'
## Vision
All rent and vendor payouts flow through PropLane Connect — no off-platform settlement for production portfolios. **Launch:** PropLane charges **no service-fee markup**; Stripe pass-through only when policy says resident/manager pays processing (`resolveServiceFeePayerFor`).

## Children
Resident checkout-only path, vendor Connect payout completion, admin fee controls, reconciliation reporting.

## Relates PRP-253 (Connect onboarding dead-end)
EOF
)"

run_ticket \
  --title "[Payments] Residents pay rent only through PropLane checkout (deprecate manual mark-paid for residents)" \
  --project "$P_PAY" \
  --milestone "$MS_STRIPE" \
  --priority 2 \
  --labels "Feature,area:payments,portal:resident,portal:manager" \
  --body "$(cat <<'EOF'
## User story
Residents never "pay off platform"; manager manual mark-paid remains for edge cases but not advertised as primary path.

## Acceptance
- [ ] Resident UI always routes to Checkout when Connect ready
- [ ] Clear blocker when manager Connect incomplete (fix PRP-253)
- [ ] Product copy: platform-only payments
EOF
)"

run_ticket \
  --title "[Payments] Vendor invoice → Connect payout — single path, no duplicate mark-paid" \
  --project "$P_PAY" \
  --milestone "$MS_STRIPE" \
  --priority 2 \
  --labels "Feature,area:payments,portal:vendor,portal:manager" \
  --body "$(cat <<'EOF'
## User story
Accepted bid → completed WO → vendor invoice → **one** `vendor_payouts` row → Stripe transfer (`docs/agents/vendor-portal.md`).

## Acceptance
- [ ] Manager cannot double-pay vendor off-platform without audit flag
- [ ] Vendor portal shows payout timeline
- [ ] Reconcile with PRP-252 payer display bug
EOF
)"

run_ticket \
  --title "[Admin] Platform service fee controls — staff override per manager with audit trail" \
  --project "$P_ADMIN" \
  --milestone "Records" \
  --priority 3 \
  --labels "Feature,area:payments,portal:admin" \
  --body "$(cat <<'EOF'
## User story
Staff sets `serviceFeePayer` override (including `proplane` absorb) per manager in admin; changes logged.

## Launch default
**No PropLane markup** — overrides for exceptions only; document in admin UI help text.

## Code refs
`resolveServiceFeePayerFor`, admin manager service fee API, `payment-policy.ts`

## Acceptance
- [ ] Admin UI shows current effective payer
- [ ] Audit row on change
- [ ] Docs updated in `docs/agents/resident-payments.md`
EOF
)"

run_ticket \
  --title "[Payments] Manager profitability dashboard — gross rent, fees, SMS, and vendor spend" \
  --project "$P_PAY" \
  --milestone "Documents & GL" \
  --priority 3 \
  --labels "Feature,area:payments,portal:manager" \
  --body "$(cat <<'EOF'
## Business goal
Managers (and PropLane ops) see whether a portfolio is profitable after Stripe fees, vendor payouts, and optional SMS costs.

## Acceptance
- [ ] Read-only dashboard widgets sourced from ledger + payouts
- [ ] Export CSV for accountant
- [ ] No invented numbers — tool/DB grounded
EOF
)"

echo "=== SaaS messaging backbone ==="

run_ticket \
  --title "[Comm] Action event bus — work order / payment / lease events fan out to threads + SMS" \
  --project "$P_COMM" \
  --milestone "$MS_EPIC" \
  --parent PRP-102 \
  --priority 2 \
  --labels "Feature,area:communication" \
  --body "$(cat <<'EOF'
## Goal
When the system creates or updates a WO, charge, or lease event, **one bus** appends the inbox thread and triggers SMS/email per preferences — no one-off route hacks.

## Acceptance
- [ ] Event catalog documented
- [ ] Idempotent consumers
- [ ] Matches `docs/agents/communication-inbox.md` thread rules
EOF
)"

run_ticket \
  --title "[Infra] SaaS webhooks API — subscribe to WO, payment, and message events" \
  --project "$P_INFRA" \
  --milestone "Production env" \
  --priority 3 \
  --labels "Feature,area:communication" \
  --body "$(cat <<'EOF'
## Goal
External integrators (or future mobile native) receive signed webhooks for key lifecycle events.

## Relates
`docs/agents/mcp-api.md` — reuse auth patterns; webhooks are read-only notifications, not writes.

## Acceptance
- [ ] HMAC-signed delivery + retry
- [ ] Manager-scoped subscription keys
EOF
)"

echo "=== Business / growth ==="

run_ticket \
  --title "[Growth] Unit economics model — SMS, AI, and Stripe cost per active manager" \
  --project "$P_GROWTH" \
  --milestone "(general)" \
  --priority 3 \
  --labels "Improvement" \
  --body "$(cat <<'EOF'
## Goal
Spreadsheet + doc: cost per manager at 10/50/200 units; when to enable PropLane service fee; Twilio + Anthropic + Stripe assumptions.

## Deliverable
`docs/business/unit-economics.md` with captain-reviewed defaults.
EOF
)"

run_ticket \
  --title "[Growth] Pricing tiers — Pro/Business entitlements for AI turns and SMS volume" \
  --project "$P_GROWTH" \
  --milestone "(general)" \
  --priority 3 \
  --labels "Feature,area:payments" \
  --body "$(cat <<'EOF'
## Goal
Align `docs/agents/plan-entitlements.md` with future caps: assistant messages/month, outbound SMS, vendor dispatch.

## Launch
Assume generous limits; instrument usage in PostHog first.

## Acceptance
- [ ] Usage meters defined
- [ ] Paywall copy drafted (not necessarily enforced day one)
EOF
)"

echo "=== QA harness ==="

run_ticket \
  --title "[QA] Four-portal assistant manual test — confirm cards on manager, resident, vendor" \
  --project "$P_AI" \
  --milestone "$MS_MGR" \
  --priority 2 \
  --labels "Improvement,portal:manager,portal:resident,portal:vendor" \
  --body "$(cat <<'EOF'
## Test plan (localhost:3010)
| Portal | Prompt | Expected preview |
| --- | --- | --- |
| Manager | "Create a work order for leaky faucet at [property]" | `create_work_order` card |
| Resident | "Report maintenance: no hot water" | `report_maintenance_issue` card |
| Vendor | "I need the gate code" | read tool or escalate preview |

## Acceptance
- [ ] Checklist added to `docs/agents/portal-full-qa-script.md`
- [ ] Failures filed as separate bugs with screenshots
- [ ] Unit smoke: `npm run test:unit -- tests/unit/agent/loop-write-proposal.test.ts`
EOF
)"

echo "=== Vision batch complete ==="
