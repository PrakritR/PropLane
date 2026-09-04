# PropLane Linear ticket system

How we file, sort, and ship work in the **PropLane** team (`PRP-`) on
[axishousing](https://linear.app/axishousing). Cursor connects via MCP —
see `docs/cursor-linear-mcp.md`.

Linear has no literal nested folders. We use **Projects** as top-level folders
and **Milestones** as sub-folders inside each project.

---

## Create tickets from Cursor chat (preferred)

Just type in chat — the agent files Linear for you.

**Examples:**

- *"Create a ticket: calendar bookings UI needs a revamp"*
- *"File this bug in Linear — manager Residents tab crashes on open"*
- *"Linear: add feature for sending applications via SMS"*

The agent runs `npm run linear:ticket -- --chat "…"` (or Linear MCP) and replies
with **PRP-###** + URL. Routing, labels, project, and milestone are inferred from
`docs/linear-ticket-system.md` and `scripts/linear/ticket-routing.mjs`.

**Manual CLI (same routing):**

```bash
npm run linear:ticket -- --chat "Residents tab crashes when clicking Payments"
npm run linear:ticket -- --title "[Calendar] Revamp bookings panel" \
  --project "11 — Calendar & Tours" --milestone "Manager calendar UI" \
  --labels "Improvement,area:calendar,portal:manager"
npm run linear:ticket -- --chat "…" --dry-run   # preview payload only
```

**Auth:** `LINEAR_API_KEY` in `.env.local` (required — GraphQL only, no MCP).

**Auto-assign (2026-09-04):** Communication Hub → **Akhil**; everything else → **M
(Prakrit)**. Priority is inferred (happy-path breaks + comms = High; frequent
surfaces = Medium; polish = Low). Re-run batch triage:

```bash
npm run linear:triage
```

New tickets from `npm run linear:ticket` get the same assignee + priority automatically.

Cursor rule: `.cursor/rules/linear-chat-tickets.mdc`.

**Full pipeline:** See **`docs/agents/captain-dev-workflow.md`** and
**`docs/share/proplane-collaborator-workflow.md`** (share with collaborators).

**One-shot (preferred):** `npm run workflow:plan -- --chat "…"` — ticket + Lavish plan.

**Export ticket for friends (phase ②):**

```bash
npm run linear:export -- --ticket PRP-180 --out .lavish/plans/PRP-180-slug/ticket.md
```

---

## Folder map (Projects → Milestones)

```
01 — Infrastructure & Ops
├── Production email          Resend, RESEND_FROM, inbound support@
├── Production env            CRON_SECRET, API keys, ship:preflight gaps
├── Observability             PostHog, Langfuse, alerts
└── Mobile releases           TestFlight, Capacitor, iOS/Android shell

02 — Manager Portal
├── Properties                List tab, drafts wizard publish, ownership
├── Residents                 Resident directory, move-in, guest access
├── Payments                  Household charges, reminders, ledger views
├── Services                  Add-on services + maintenance (manager view)
├── Settings                  Account, phone, calendar prefs, co-managers
└── Dashboard                 Needs attention, KPIs, AI drafts

03 — Resident Portal
├── Applications              Apply flow, bundles, pre-approval
├── Lease                     Sign, review, move-in instructions
├── Payments                  Charges, pay flow, receipts
├── Services                  Add-on services requests
├── Documents                 Resident document vault
└── Housing                   Browse, listing detail, tours (resident-facing)

04 — Vendor Portal
├── Work orders               Bids, dispatch, job detail
├── Messaging                 Vendor ↔ manager threads
├── Payouts                   Connect, invoices
└── Profile                   Insurance, availability

05 — Admin Portal
├── Inbox                     support@ inbound, staff comms
├── Feedback                  Bug reports from users
└── Records                   Internal admin tables

06 — Communication Hub
├── Epic — Unified hub         PRP-102 parent; cross-channel strategy
├── SMS                       Outbound/inbound SMS, A2P, listing CTAs
├── Email & Inbox             Threads, scheduled sends, attachments
├── Resident messaging        Resident ↔ manager on-platform chat
├── Vendor messaging          Vendor multi-manager threads
└── Automation                AI workflows triggered by messages

07 — Leases & Applications
├── Lease documents           Templates, uploaded leases, legal disclaimers
├── Signatures                E-sign, execution evidence, send gates
├── Application flow          Manager approve/deny, fees, screening
└── Group applications        AXISGRP bundles, per-member approval

08 — Payments & Finance
├── Charges & ledger          Household charges, late fees, NSF
├── Stripe & payouts          Connect, resident-paid fees, subscriptions
├── Deposits                  Security deposit liability
└── Documents & GL            Owner statements, QuickBooks export

09 — AI Assistant
├── Manager assistant         Floating popup / dock, manager tools
├── Resident assistant        Resident-scoped agent
├── Vendor assistant          Work-order-pinned vendor agent
└── SMS agents                Leasing SMS + vendor dispatch SMS

10 — Listings & Properties
├── Create wizard             Add-property steps, rooms, pricing
├── Browse & detail           Public listing page, gallery, lead CTAs
└── Pricing & rooms           Rent basis, short-term, bundles

11 — Calendar & Tours
├── Manager calendar UI       Schedule view, bookings chrome
├── Bookings                  Tour slots, confirmations
├── Google sync               OAuth, calendar busy time
└── Resident scheduling       Resident-facing tour booking

12 — Marketing & Growth
└── (general)                 Landing, promos, pricing page, SEO
```

**Archived legacy projects** (do not file new work here): old `Application`,
`lease pipeline`, `UI Fixes`, `Communication integration`, `payment feature`,
`FINANCE AND DOCUMENTS`, `PROMOITON PIPELINE`, `Maintenance requests`,
`observability` — all merged into the numbered projects above.

---

## Where do I put this ticket? (decision tree)

Answer in order. First match wins.

1. **Production down or env missing?** (email dark, cron 401, wrong Supabase)
   → **01 — Infrastructure & Ops** → pick **Production email** or **Production env**

2. **Which portal does the user see the bug in?**
   - Manager (`/portal/...`) → **02 — Manager Portal** → pick section milestone
   - Resident (`/resident/...`) → **03 — Resident Portal** → pick section milestone
   - Vendor (`/vendor/...`) → **04 — Vendor Portal**
   - Admin (`/admin/...`) → **05 — Admin Portal**

3. **Cross-portal messaging** (SMS, email, inbox thread, scheduled send)
   → **06 — Communication Hub** → pick SMS / Email & Inbox / Resident / Vendor /
   Automation (or **Epic — Unified hub** only for umbrella epics)

4. **Lease PDF, signature, application approval, group apply**
   → **07 — Leases & Applications** → pick milestone

5. **Money** (charge, payment, Stripe, deposit, ledger, GL)
   → **08 — Payments & Finance** → pick milestone

6. **AI chat, agent tool, assistant dock, SMS agent behavior**
   → **09 — AI Assistant** → pick portal-specific milestone

7. **Listing wizard, public browse, room pricing on listing**
   → **10 — Listings & Properties** → pick milestone

8. **Tours, calendar UI, Google Calendar, booking slots**
   → **11 — Calendar & Tours** → pick milestone

9. **Marketing site, landing, pricing tiers, growth experiments**
   → **12 — Marketing & Growth**

**Still unsure?** Default to the **portal project (02–05)** for the role affected,
not **06** or **09**.

---

## How to create a ticket (step by step)

### In Linear UI

1. **PropLane team** → **New issue**
2. **Project** — pick one numbered folder from the map (required)
3. **Milestone** — pick the sub-folder inside that project (required for Todo+)
4. **Title** — `[Area] Short imperative — user-visible outcome`
5. **Labels** — see below (required before moving to Todo)
6. **Priority** — Urgent / High / Medium / Low (Backlog may stay unset)
7. **Status** — start in **Backlog**; move to **Todo** only with full description
8. **Description** — paste the template below (screenshots alone = Backlog only)
9. **Parent issue** — if this is a sub-task, set parent to the epic (e.g. PRP-102)

### Required labels

| Layer | Pick |
| --- | --- |
| **Portal** (≥1) | `portal:manager` · `portal:resident` · `portal:vendor` · `portal:admin` |
| **Area** (1 primary) | `area:listings` · `area:leases` · `area:payments` · `area:calendar` · `area:communication` · `area:ai-assistant` · `infra:production` |
| **Type** (1) | `Bug` · `Feature` · `Improvement` · `type:epic` (epics only) |

Labels should **agree** with the project/milestone (e.g. Payments bug → project
**08** or portal **02/03** Payments milestone + `area:payments`).

---

## Title format

```
[Area] Short imperative — what changes for the user
```

Examples:

- `[Residents] Directory crashes on open — trim on undefined email`
- `[Calendar] Revamp bookings panel layout on manager schedule`
- `[Infra] Production Resend vars empty — no product email sends`

Avoid: `create listing`, `bug`, `fix ui`.

---

## Description template

```markdown
## User story
As a [manager | resident | vendor | admin], I want … so that …

## Current behavior
What happens today (steps to reproduce for bugs).

## Expected behavior
What should happen.

## Portal / route
e.g. `/portal/residents`, `/resident/payments`

## Project / milestone
e.g. 02 — Manager Portal → Residents

## Acceptance criteria
- [ ] …
- [ ] Unit test or manual step documented

## Out of scope
…

## Links
- Related PRP-…
- `docs/agents/<area>.md`
```

For **bugs**: role, URL, browser width, `/demo` yes/no.

---

## Status workflow

| Status | Meaning |
| --- | --- |
| **Backlog** | Idea or screenshot-only; not scheduled |
| **Todo** | Spec complete, correct project + milestone + labels |
| **In Progress** | Assignee actively coding |
| **Done** | Shipped + verified on localhost:3011 or staging |
| **Canceled** | Won't do |
| **Duplicate** | Link canonical PRP in comment |

---

## Examples by section

| You noticed… | Project | Milestone | Labels |
| --- | --- | --- | --- |
| Co-manager can't see properties | 02 — Manager Portal | Settings | Bug, portal:manager |
| Application fee charge wrong | 08 — Payments & Finance | Charges & ledger | Bug, area:payments, portal:resident |
| Tour slot double-books | 11 — Calendar & Tours | Bookings | Bug, area:calendar |
| Send application link via SMS | 06 — Communication Hub | SMS | Feature, area:communication |
| Assistant can't confirm lease send | 09 — AI Assistant | Manager assistant | Bug, area:ai-assistant |
| Listing wizard room step confusing | 10 — Listings & Properties | Create wizard | Improvement, area:listings |
| TestFlight build failed | 01 — Infrastructure & Ops | Mobile releases | infra:production |
| Lease template legal disclaimer | 07 — Leases & Applications | Lease documents | Feature, area:leases |

---

## Epics and children

- **PRP-102** — `[Epic] Unified messaging hub` lives in **06 / Epic — Unified hub**
- Children PRP-103–109, 150, 151 stay under that parent; when a child ships, move
  it to the specific milestone (SMS, Automation, etc.) and mark Done
- Do not close PRP-102 until all children are Done or Canceled

---

## Dev / agent workflow

1. Pull from **Todo** in your project milestone (Urgent → High first)
2. **In Progress** + assign yourself
3. Code on `cursor-2` → http://localhost:3011
4. Read `docs/agents/<area>.md` before touching that subsystem
5. Commit message includes `PRP-###`
6. **Done** after happy path + edge checks (not `/demo` alone)
7. Comment on issue: what shipped, how tested

```bash
cursor agent mcp login linear          # once per machine
cursor agent mcp list                  # linear: ready
```

---

## Monthly hygiene

- No description for 90+ days → spec or **Canceled**
- Duplicate titles → one canonical, rest **Duplicate**
- Every **Todo** has project + milestone + labels
- Unarchive issues if they disappear from board views
