> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

# Financials Phase 4: vendor portal invoicing

**This phase is ADDITIVE on top of the already-shipped vendor portal (Vendor
Portal Phases 1-3 above).** The financials plan's §3 was written before that
portal existed, so its "add the vendor role / PortalKind / portal registry /
Stripe Connect" bullets were already done — do NOT re-add them. The genuine
Phase 4 delta was only: vendor-submitted invoices, `assertVendorFinancialsAccess`,
the vendor-financials AI tools, and a self-service-W-9 flag.

**`vendor_invoices` is the vendor→manager billing channel**
(`supabase/migrations/20260710120000_vendor_invoices.sql`), separate from
`vendor_payouts` (which stays work-order-driven, Phase 3). Status flow
`submitted → approved / rejected → scheduled → paid`. **`bill_id` is nullable
with NO FK yet** — Phase 5's `manager_bills` doesn't exist at this point in the
sequence; Phase 5 adds `references manager_bills(id)` when it lands, so an
approved invoice can become a bill with no schema rework. RLS mirrors the
hardened `vendor_payouts` / `work_order_bids` split: vendor `FOR SELECT` only
(`vendor_user_id = auth.uid()` —
`20260721141000_vendor_invoices_vendor_select_only.sql` replaced the original
`FOR ALL` owner policy, which would have let a vendor's own client bypass the
status flow), manager `FOR SELECT` (denormalized `manager_user_id`). Real
writes go through service-role routes.

**We did NOT create a `vendor_payout_accounts` table** (the plan named one).
Phase 3 already generalized Connect via `profiles.stripe_connect_account_id` +
`ensureVendorConnectAccountId` + `vendor_payouts`; a parallel table would be
duplicate infrastructure. Reuse the shipped pattern.

**Approve + Pay (PLAN-0923-1041).** When a vendor invoice is at least $1,
Approve + Pay starts manager ACH Checkout of invoice + Stripe’s cost
(`feePayer: "resident"` so the manager pays the fee). If the vendor’s
Connect + bank is ready, that is a destination charge to the vendor’s
Stripe — they receive the invoice total. If not, the invoice is held on
PropLane and transfers the moment they connect. Withdraw stays
connected-account → bank only. `vendor_payouts` is inserted pending
before Checkout; the webhook settles with `settleOnly` so a second
Checkout cannot start.

**Routes.** Vendor: `GET/POST /api/vendor/invoices` (list own / submit).
Submit validation is ONE shared implementation — `prepareVendorInvoiceSubmission`
in `src/lib/vendor-invoice-submit.server.ts`, used by both the POST route and
the `submit_vendor_invoice` agent tool so the two paths cannot drift: the total
is recomputed server-side from line items via `sumLineItemsCents`, never trusted
from the body, and a supplied `workOrderId` must resolve to a
`portal_work_order_records` row owned by the billed manager AND assigned to the
submitting vendor, else the submit is a 400 — same never-trust-client-ids rule
as the bids route. Manager: `PATCH /api/vendor/invoices/[id]/decision`
(approve/reject/schedule/paid, scoped to invoices billed to `auth.userId`).
The decision route enforces the status flow via
`canTransitionVendorInvoice` (`src/lib/vendor-invoices.ts`): `submitted →
approved/rejected`, `approved → scheduled/paid`, `scheduled → paid`; `paid` and
`rejected` are terminal. A repeated approval idempotently repairs its bill/GL
without firing analytics again; other repeated statuses return 409. A transition
that omits `decisionNote` preserves the note recorded by the earlier decision
rather than clearing it.
Shared types/helpers live in `src/lib/vendor-invoices.ts` (incl.
`vendorInvoiceBadgeTone`: submitted→pending, approved/scheduled→approved,
paid→confirmed, rejected→overdue — the four shared `Badge` tones, no fifth).

**Scope: single-manager-per-vendor billing.** When a vendor has multiple
linked managers and no explicit `managerUserId` is supplied, the submit route
and the `submit_vendor_invoice` tool refuse (409 / tool error) rather than
silently billing the first link — the submit modal sends no `managerUserId`
and surfaces that error verbatim. A manager picker is deferred to Phase 5.

**UI.** Invoices are an `invoices` TAB added to the existing vendor `financials`
section (not a new portal section) — `VendorFinancesPanel` (`tabId === "invoices"`)
renders the list + `ManagerPortalStatusPills` status filter + a submit modal.
Vendor portal already defaults light (`SurfaceThemeDefault theme="light"` in
`src/app/vendor/layout.tsx`).

**AI tools.** `src/lib/tools/domains/vendor-financials.ts` (`list_vendor_invoices`,
`submit_vendor_invoice` [gated write], `list_vendor_payouts`) scope by
`vendor_user_id = ctx.userId` and bind to `VendorAgentContext`, so a manager tool
cannot even typecheck into their registry. They live in a SEPARATE
`vendorAgentRegistry` (`src/lib/tools/vendor-index.ts`) so the manager
`agentRegistry` never inherits vendor tools. **No W-9 / TIN tool exists in either registry** —
self-service W-9 is UI-only (`/api/vendor/tax-profile`, which now also sets
`vendor_tax_profiles.submitted_by_vendor = true`), per the `1099_candidates`
exclusion precedent. `tests/unit/tools/vendor-financials.test.ts` enforces both
the scoping and the tax-tool exclusion.

**`reports/auth.ts`** gained a `role: "vendor"` branch (a vendor-only user
resolves to the vendor context; dual-role still prefers manager) and
`assertVendorFinancialsAccess` — a role-gate; the real cross-vendor isolation is
that every vendor query filters by `vendor_user_id = ctx.userId`.

**PostHog:** `vendor_invoice_submitted` (server, on confirmed insert — do NOT
also fire it client-side), `vendor_invoice_approved` / `vendor_invoice_rejected`
(server, in the decision route), and `payout_setup_started` /
`payout_setup_completed` (client, via `PortalStripeConnectPanel`'s opt-in
`analyticsScope="vendor"` prop — the manager panel omits it so its analytics are
unchanged).
