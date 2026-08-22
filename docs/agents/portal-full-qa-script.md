# Manager + resident portal — full QA script (agent playbook)

Use this document when the captain asks to **test every manager and resident portal feature and fix what breaks**. It is written for Claude (or any agent) running in a PropLane worktree — not for `/demo` alone.

## Mission

1. Exercise **every navigable section** in both portals (happy path + edge cases).
2. Record failures with URL, role, repro steps, and screenshot if visual.
3. **Fix in code** (minimal diff), add/adjust unit tests when the bug is logic-shaped.
4. Re-run targeted tests + affected e2e before handoff.
5. Summarize what was tested, what was fixed, and what remains blocked.

**Do not** treat a green unit suite or a `/demo` walkthrough as proof — use seeded dev/test accounts on localhost (captain review port **3010** on `cursor-1`).

---

## Prerequisites

```bash
# From worktree root (e.g. proplane-cursor-branch-1)
npm run seed:env          # once per fresh worktree if .env missing
npm run test:seed         # dev/test Supabase seed (core accounts)
# Dev server on captain review port (cursor-1 → 3010)
npm run dev -- -p 3010
```

| Item | Value |
| --- | --- |
| Base URL | `http://localhost:3010` |
| Manager | `manager@test.proplane.local` / `TestManager123!` |
| Resident | `resident@test.proplane.local` / `TestResident123!` |
| Resident AXIS id (seed) | `AXIS-TESTRSID` (see `tests/fixtures/index.ts`) |
| Second manager (isolated flows) | `manager2@test.proplane.local` / `TestManager123!` |

**Browser:** Use real browser automation (Playwright locally or browser MCP). Test **desktop (≥1024px)** and **mobile (390×844)** for header actions, bottom nav, and expandable rows.

**Stripe:** E2e mocks Stripe routes via `mockStripeAllRoutes` / `mockStripeCheckoutRoutes` — for manual QA, payment buttons may show test UI; do not charge real cards.

---

## Operating rules

| Rule | Why |
| --- | --- |
| Sign in as the **correct role** per section | Manager tools 401 on resident routes and vice versa |
| Prefer `/portal` and `/resident`, not `/demo` | Demo is sandbox; production-like flows use real auth + seed |
| Locked resident nav = **inert** (no navigation) | Clicking a padlocked tab must not redirect home |
| Communication has **no folder tabs** | Only `active` / `archived` segments + thread deep links |
| One header action per control on mobile | Split `titleAside` + `md:hidden` row duplicates break strict locators and PostHog |
| Cross-check money on **lease doc, listing, charges** | `resolveStayPricing` / `computeLeasePaymentAtSigning` must agree |
| Fix high/critical before ship | Run `security-review` + `bugbot` on branch diff for non-trivial fixes |

### Fix-and-verify loop (per bug)

1. Reproduce once (note exact URL + account).
2. Grep for the surface component under `src/components/portal/` or `src/lib/`.
3. Fix with smallest correct change; read `docs/agents/<area>.md` when touching leases, payments, inbox, etc.
4. `npm run test:unit -- <pattern>` for the area.
5. Re-walk the same UI step manually.
6. If the bug was locator/e2e-shaped, update the spec (use `:visible` when duplicate `data-attr` exists on split sections).

---

## Phase 0 — Automated baseline

Run before and after manual QA:

```bash
# Unit (fast)
npm run test:unit -- tests/unit/portal-
npm run test:unit -- tests/unit/listing-fees.test.ts tests/unit/long-term-lease-parity.test.ts
npm run test:unit -- tests/unit/resident-portal-nav.test.ts

# E2e (seed required; pin dev/test Supabase — see docs/ship-gate.md)
PLAYWRIGHT_SKIP_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3010 \
  E2E_TESTS_ENABLED=1 npx playwright test tests/e2e/manager-portal.spec.ts
PLAYWRIGHT_SKIP_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3010 \
  E2E_TESTS_ENABLED=1 npx playwright test tests/e2e/resident-portal.spec.ts
PLAYWRIGHT_SKIP_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3010 \
  E2E_TESTS_ENABLED=1 npx playwright test tests/e2e/portal-interconnect.spec.ts
```

**Known-failing e2e on `main`:** see `docs/ship-gate.md` § "Known-failing specs" — do not re-triage those 18 without checking if band-only header fixes already resolved them.

---

## Phase 1 — Manager portal (`/portal`)

Sign in as **manager@test.proplane.local**. Source of truth for sections: `src/lib/portals/pro.ts`.

For each section: **load URL → heading visible → no error toast → primary CTA works → expand one row if table exists**.

### 1.1 Dashboard (`/portal/dashboard`)

- [ ] KPI stat row visible
- [ ] "Needs attention" groups render; empty groups collapsed
- [ ] AI drafts group (if pending actions exist) shows Approve/Discard — confirm does not execute without click
- [ ] Customize dashboard modal toggles sections; refresh preserves choices
- [ ] Cash-flow chart loads without console errors

### 1.2 Properties (`/portal/properties`)

- [ ] List shows seeded properties; stage pills (Live / Pending / Drafts / Unlisted) filter
- [ ] **Add property** opens wizard; Close saves draft when edited (autosave debounce)
- [ ] Draft: Continue editing resumes step; Delete removes row + reclaims photos
- [ ] Live listing: expand row → detail panels (House details, Application questions, Lease config)
- [ ] **Share** / row **Send to prospect** opens `ShareLeadLinkModal` (email and/or SMS if work number exists)
- [ ] Unlist → row moves to Unlisted; relist in place (no duplicate id delete)
- [ ] Co-managed property visible if seed includes link
- [ ] Plan cap: at-limit account cannot publish new live listing (403 toast with limit message)

**Listing / lease config checks (recent fixes):**

- [ ] Payment at signing checkboxes on listing → public listing shows bundle fees only in lease basics (not per-room rent in basics)
- [ ] Floor plans show per-room rent/utilities
- [ ] Generate preview lease: Section 5 fees formatted `$X.XX`; Section 8 only named tenant; Section 9 shared spaces bulleted; Premises city/state/ZIP from listing fields (not neighborhood)

### 1.3 Calendar (`/portal/calendar/tours`)

- [ ] Week grid loads; tour inquiries appear
- [ ] Availability: Copy previous week / Create block / Clear week
- [ ] Confirm tour proposal (if automation on) appears in proposals panel
- [ ] Google busy events show on grid but Free/declined do not block slots
- [ ] Sub-routes: `/portal/calendar/all`, `/portal/calendar/availability` load

### 1.4 Applications (`/portal/applications/pending`)

- [ ] Tabs: Pending / Approved / Rejected
- [ ] Expand row: applicant details, screening status, group badge `Group N/M` when `groupId` set
- [ ] Approve → charges generated; Reject / Send reminder / Delete
- [ ] Approved tab links to resident / lease pipeline
- [ ] Screenings order (if enabled on plan)

### 1.5 Leases (`/portal/leases`)

- [ ] Pipeline statuses: Manager review / Resident signature pending / Manager signature pending / Signed
- [ ] Create lease from approved application
- [ ] Preview HTML matches billing (payment at signing respects checkboxes)
- [ ] Send for signature gated on application approved + uploaded lease review confirmed
- [ ] Joint bundle lease: one household row when bundle group complete
- [ ] Upload third-party lease: parse review + mismatch warnings before send

### 1.6 Residents (`/portal/residents/current`)

- [ ] Table loads; expand row shows household, charges, group roster
- [ ] No erroneous "Previous" tab
- [ ] Links to application / lease / communication work

### 1.7 Payments (`/portal/payments`)

- [ ] Charges list; status filters
- [ ] Setup / Stripe Connect CTA if not connected (single visible control)
- [ ] Record manual payment; resident ledger updates
- [ ] Late fees / reminders surfaces

### 1.8 Services (`/portal/services/*`)

| Tab | Path | Checks |
| --- | --- | --- |
| Requests | `/portal/services/requests` | Add-on service requests list; create modal |
| Work orders | `/portal/services/work-orders` | Maintenance WO list; dispatch |
| Vendors | `/portal/services/vendors` | Vendor list; invite |

- [ ] Legacy `/portal/work-orders` → redirects to work-orders tab

### 1.9 Communication (`/portal/communication/active`)

- [ ] Conversation list (no Unopened/Sent folder tabs)
- [ ] Open thread; unread dot clears
- [ ] Compose: email channel; subject + body; attachment chip (PDF download disposition)
- [ ] Schedule send → inline scheduled card in thread; Send now / Cancel / Edit
- [ ] Archived segment `/portal/communication/archived`
- [ ] Legacy `/portal/inbox/*` redirects here

### 1.10 Team (`/portal/relationships`)

- [ ] Co-manager list; invite flow
- [ ] Property assignment on invite

### 1.11 Promotion (`/portal/promotion`)

- [ ] Promotion list; New promotion modal (one visible create control)
- [ ] Referral links / codes if seeded

### 1.12 Finances (`/portal/financials/*`)

Visit each tab id from `pro.ts` (income, expenses, trial-balance, balance-sheet, general-ledger, cash-flow-statement, payout-history, trust-account-balance, security-deposits, financial-diagnostics, ap-aging, bills, budget-vs-actual, bank-reconciliation, owner-statement, owner-distributions):

- [ ] Tab loads without 500
- [ ] Date filters / export if present
- [ ] Numbers match seeded ledger (spot-check one charge + one payment)

### 1.13 Documents (`/portal/documents/*`)

Tabs: library, templates, applications, leases, income-documents, expense-documents, occupancy, 1099, tax-summary

- [ ] Each tab loads
- [ ] Upload to library; signed URL download after auth
- [ ] Lease template preview uses `/api/portal/lease-template` (not public storage URL)

### 1.14 Feedback (`/portal/bugs-feedback`)

- [ ] Submit feedback form
- [ ] List shows prior submissions

### 1.15 App (`/portal/app`)

- [ ] Mobile app / TestFlight copy; deep link info

### 1.16 Settings (`/portal/profile`)

- [ ] Plan tier display matches `/api/manager/subscription` effective tier
- [ ] Notification preferences save
- [ ] Assistant display mode (popup vs docked)
- [ ] Phone / SMS work number provisioning UI
- [ ] Sign out

### 1.17 Manager — global chrome

- [ ] Sidebar nav matches `proPortal.sections`; paywalled sections show upgrade on free tier
- [ ] ⌘K / Ask PropLane focuses assistant
- [ ] Axis assistant: read tool call + gated write preview + confirm
- [ ] Mobile bottom nav / More sheet reaches all sections
- [ ] Legacy `/manager/*` redirects to `/portal/*`

---

## Phase 2 — Resident portal (`/resident`)

Sign in as **resident@test.proplane.local**. Nav **varies by stage** — see `src/lib/resident-portal-nav.ts`.

### Stage detection (do all three if you can seed or impersonate)

| Stage | Unlocked sections | Locked (inert) |
| --- | --- | --- |
| Pre-approval (application submitted, not approved) | Tour, Application, Dashboard, Communication, Settings | Lease, Payments, House details, Services, Documents (most) |
| Pre-lease (approved, lease not fully signed) | + Lease, Payments, Documents | Services, House details until signed |
| Post-sign (fully signed lease) | Full nav including Services, House details | — |

**Regression:** Manager+resident same account must not show empty lease while Applications says Approved.

### 2.1 Dashboard (`/resident/dashboard`)

- [ ] Attention groups mirror manager pattern
- [ ] Status reflects application / lease stage
- [ ] No duplicate mobile header buttons

### 2.2 Tour (`/resident/tour`)

- [ ] Scheduled tour details or empty state
- [ ] Reschedule / cancel links if tour confirmed

### 2.3 Application (`/resident/applications`)

- [ ] Wizard status / submitted summary
- [ ] Group ID display when applicable
- [ ] Cannot edit after final submit (unless allowed flow)

### 2.4 Lease (`/resident/lease`)

- [ ] Document renders; signature flow for pending signature
- [ ] Payment at signing amounts match manager lease preview
- [ ] Fully signed: certificate / download

### 2.5 Payments (`/resident/payments`)

- [ ] Charges-only view (no Summary/Statements tabs)
- [ ] Legacy `/resident/payments/pending` → same page with Pending pill
- [ ] Legacy `/resident/finances/*` → redirects to payments
- [ ] Pay flow (Stripe test); processing fee shown per `docs/agents/resident-payments.md`
- [ ] Filter pills: Pending / Overdue / Paid

### 2.6 Communication (`/resident/communication/active`)

- [ ] Thread with manager; reply sends (optimistic bubble only after success)
- [ ] No schedule-later on compose (control absent)
- [ ] Scheduled messages from manager appear inline; resident can cancel own scheduled, not edit manager's

### 2.7 Services (`/resident/services/*`) — post-sign only

- [ ] Add-on services tab: purchase / request
- [ ] Work orders tab: submit maintenance request
- [ ] Label says "Add-on services" not "work orders" for purchasables

### 2.8 House details (`/resident/move-in`) — post-sign

- [ ] Move-in checklist / house info loads

### 2.9 Documents (`/resident/documents/*`)

Tabs: application, lease, receipts, other

- [ ] Each tab loads; upload where allowed
- [ ] Legacy `/resident/documents/shared` → other

### 2.10 Settings (`/resident/profile`)

- [ ] Login & security: Set password vs Change password (has-password probe)
- [ ] Notification preferences
- [ ] Sign out

### 2.11 Resident — global chrome

- [ ] Bottom nav primary tabs match unlocked stage (`tests/unit/resident-portal-nav.test.ts`)
- [ ] Locked nav rows are inert, not dead links
- [ ] Native parity paths in `src/lib/platform/parity.ts` unchanged unless intentional

---

## Phase 3 — Cross-surface interconnect

Run as both roles in sequence:

| Flow | Manager action | Resident check |
| --- | --- | --- |
| Application | Approve in Applications | Dashboard + nav unlocks Lease/Payments |
| Lease | Send for signature | Resident sees sign CTA; email link works (`token_hash` not PKCE `code`) |
| Charges | Approve application charges | Resident Payments shows rows; amounts match lease |
| Message | Send from Communication | Appears in resident thread; timestamp sorts correctly |
| Work order | Create from Services | Resident sees WO in Services (post-sign) |
| Listing share | Share listing to prospect email | Public `/rent/listings/{id}` loads; browse multi-id works |
| Tour | Confirm inquiry | Resident tour tab updated; public slot no longer offered |

**Identity drift:** If resident lease missing but manager shows signed, run `npm run test:seed:repair-identity-drift` (dev only).

---

## Phase 4 — Public surfaces (manager/resident adjacency)

Not the portals, but breaks portal flows if wrong:

- [ ] `/rent/browse` — cards, no stock photos for photo-less listings
- [ ] `/rent/listings/{id}` — floor plans, lease basics bundle-only, no "Due at signing" sidebar block
- [ ] `/rent/apply` — wizard submit creates application visible in manager Applications
- [ ] Tour booking — slot offered = published − busy − booked; rate limit not hit in normal use

---

## Phase 5 — Mobile + accessibility spot checks

- [ ] 390px width: manager Properties add flow completable
- [ ] Resident bottom nav: all four primary tabs reachable
- [ ] Expand chevron inline after label (not far-right-only)
- [ ] Focus trap in modals; Escape closes compose
- [ ] No horizontal scroll on Communication thread

---

## Phase 6 — Regression targets (lease/listing bundle)

Explicitly verify after recent template work:

1. **Payment at signing** — only checked line items (e.g. security deposit only → lease shows $400 not full move-in total).
2. **Premises address** — `City, ST ZIP` from listing city/state/zip; street from structured fields; neighborhood never in legal city line.
3. **Guest policy** — Section 8 lists only named tenant(s), not "additional authorized occupants".
4. **Shared spaces** — bulleted `<ul>` with amenities comma-separated inside each bullet.
5. **Fee table** — currency formatted consistently; note references selected signing items when checkboxes set.
6. **Daily rent rooms** — listing shows `$/day`; charges use daily basis (`docs/agents/rent-basis.md`).

---

## Deliverable template (agent handoff)

```markdown
## Portal QA — <date> — <branch>

### Environment
- URL: http://localhost:3010
- Seed: yes/no
- Accounts used: manager, resident, (+ others)

### Automated
- unit: pass/fail (commands)
- e2e: pass/fail (specs run)

### Manager portal
| Section | Status | Notes |
|---------|--------|-------|
| ... | pass/fail | |

### Resident portal
| Section | Stage tested | Status | Notes |

### Fixes landed
- <commit or file>: description

### Open / blocked
- item + why (credentials, seed gap, product decision)

### Reviews
- security-review: summary
- bugbot: summary
```

---

## Related docs

| Area | File |
| --- | --- |
| Ship gate + e2e | `docs/ship-gate.md` |
| Portal UI patterns | `docs/portal-ui-system.md` |
| Lease generation | `docs/agents/lease-generation.md` |
| Resident payments | `docs/agents/resident-payments.md` |
| Communication | `docs/agents/communication-inbox.md` |
| Web/native parity | `docs/web-and-native-parity.md` |
| Ladder / ports | firstmate skill `proplane-ladder` |

---

## Optional: full e2e sweep (expensive)

```bash
PLAYWRIGHT_SKIP_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3010 \
  E2E_TESTS_ENABLED=1 npm run test:e2e
```

Use when the captain explicitly wants the entire suite before promote — not for every feature fix.
