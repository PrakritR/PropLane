# PropLane portal redesign — approved build

Prakrit approved the entire `.lavish/property-studio/plan.html` prototype through
Lavish session `483f8173dd91317a`, final feedback delivered by poll 70924:
“BUILD everything in this plan all changes should be merged to prakrit branch build full plan”.
The user ended the review. Do not reopen it or resume polling.

Implementation starts from keeper `codex-1` at `081625a3`. The requested final
integration target is `prakrit`. No Linear tickets or deployment are authorized.
Use actual dev/test data for verification, preserve production locks, and run
the required reviews and no-mistakes before integration.

## Completion checklist

Items remain unchecked until implemented and verified against the approved UI.
Prototype screenshots and simulator checks are references, not product evidence.

- [x] Shared blue brand, compact spacing, canonical plane, full viewport shell;
  sidebar/main/property rail scroll independently. — `5159c624` (shell, canvas,
  sidebar groups), property rail in the desktop detail view (this commit).
- [x] Compact accessible plain utility icons, inline primary Add actions,
  side-by-side mobile controls and bulk actions; no duplicate property groups,
  redundant status badges/counts or portal eyebrow headings. — `5159c624`
  (`PortalIconAction`, `PortalPageHeadline`, one-row command stack, "+ Add"
  footers, group count chips removed, one white card per property).
- [x] Portfolio-wide Manager navigation with explicit property entry/exit;
  mobile bottom navigation remains visible, including conversations. —
  `e67467f6` (portfolio dashboard) + `PortalPropertyRail` with "All properties"
  as the one exit; bottom nav unchanged (Properties · Residents · Dashboard ·
  Communication · More).
- [x] Workspace persistence, Settings management, top-left switching, properties,
  managers/vendors/sharing and explicit permissions. Server-enforced caps of
  3 owned workspaces and 10 property records per workspace, drafts included. —
  `f54f8041` (codex-1's persisted model, switcher, DB caps) + this commit:
  plan-aware caps (Free 1 / Pro 2 / Business 3 workspaces, enforced on create
  under the DB ceiling; properties and team seats read from the same tier
  helpers the listing quota and co-manager cap use), a plan card with usage
  meters and a Free/Pro/Business comparison in Settings → Workspaces, per-
  workspace record meters and team roll-up, and Team / Vendors managed from
  Settings (the manager sidebar no longer has a Teams group; `/portal/teams/*`
  stays routable for deep links). Captain's Sep 11 instruction.
- [x] Manager and vendor invite links, property/module grants with No access,
  View, Edit and Manage; empty grants deny access. — `5b74d6e8` (four-level
  module access editor; vendor links carry property scope onto the directory row).
- [x] Resident record pages, dedicated Inspections and move-in/move-out dashboard
  obligations; room-scoped evidence and completion. No general resident Tasks. —
  this commit: `/resident/inspections/{move-in,move-out}` is its own section
  (old My home sub-tab redirects), "Your next steps" on the resident dashboard
  lists each required report with its due date, resident tour popup is
  Reschedule / Message host / Cancel tour only (`POST /api/portal-resident-tours/cancel`).
  Manager resident record pages already carry Overview … Notes tabs.
- [x] Complete Vendor business profile/work email/work number, Services (Tasks
  included), invoices/files/payments and workspace access. — this commit: a
  vendor-owned `vendor_business_profiles` row (migration applied to dev/test)
  behind `/api/vendor/business-profile`; Settings gains Business profile, Work
  contacts, Workspace access (linked managers + assigned houses) and
  Notifications, none of which wait on a manager link; Tasks is a tab of
  Services (no separate destination; `/vendor/tasks` stays routable); vendor
  bottom bar is Services · Payments · Dashboard · Communication. Invoices,
  files and payouts were already in place. **Scoped down, deliberately:** the
  work number/email are stored business contacts shown on offers, invoices
  and threads — PropLane does not provision a dedicated Twilio line per
  vendor (that would need per-vendor A2P registration and credit reservation
  under docs/agents/comms-billing.md); texts to vendors keep going out from
  PropLane's own line.
- [x] Shared persistent task system: status/filter/assignee/due/priority,
  recurrence/reminders/checklists/comments/attachments and bulk actions. —
  this commit: recurrence (daily/weekly/monthly, next occurrence filed on
  completion with month-end clamp — verified Oct 31 → Nov 30 on dev/test),
  checklists (ticks survive edits), comments (server-stamped author),
  link attachments; priority/urgency now actually persist on create (they
  were dropped server-side). Status tabs, filters, assignee, due, reminders
  and bulk actions were already in place; vendor-assigned tasks share the
  same record.
- [x] Offered lease types and inline amenities checkboxes with Other details.
  Daily/weekly, 3/6/9/12 months, month-to-month, long-term and custom bases;
  automatic custom proration and optional advanced partial-period rate.
  Listing setup has no stay dates; actual leases may start any time. — this
  commit: lease options and amenities are visible checkbox grids
  (`InlineCheckboxGroup`) with an Other field for amenities; Long-term gains
  offered lengths (3/6/9/12 months, `longTermLengthsOffered`) that pre-fill
  the applicant's move-out date from move-in — the lease type stays
  Long-term and the dates stay the truth, so AXI-143's four choices hold.
  Daily/weekly (short-term), month-to-month, custom with automatic proration
  and the optional per-day rate were already in place; setup asks only
  "Available from", never stay dates.
- [x] Bookings calendar open by default, reservations from dated bookings,
  signed leases/application holds, reversible explicit date blocks with reasons,
  overlap/capacity enforcement and exclusive check-out. — this commit: the
  Calendar tab is first and the default (`/portal/bookings` → `/calendar`, the
  property Bookings tab too); the grid draws Airbnb imports, signed PropLane
  stays, approved-application **holds** (until the lease is signed) and manager
  **blocks** (`room_date_block` rows in `portal_schedule_records`, id-scoped to
  the manager) with a legend for all four. "Block dates" (toolbar icon, or
  "Block dates from here" in the day detail) takes property, room / whole
  home, check-in, exclusive check-out and a reason; it refuses a range that
  collides with a stay, hold or block on the same room (whole home collides
  with every room; an open-ended lease has no last night) and names what it
  hit. Blocks are removed from the day detail. Fixes the calendar showing only
  Airbnb (lease entries were never passed to the grid) and a page-load race
  where the sidebar's null-scoped lease sync wiped the manager's rows
  (`lease-pipeline-sync-scope-crossing.test.ts`).
- [ ] Communication: existing one-list/two-pane pattern, phone conversation,
  compact editable contact, work-number strip, full-width composer above nav,
  visible Send via selector in tools row, AI/attachments/emoji/draft recovery,
  authorized channels and scheduling; no resident scheduling.
- [x] Resident tour popup only Reschedule, Message host and Cancel tour, plus close. —
  same commit as the resident section above; driven end to end on dev/test
  (book → cancel → withdrawn, host notified in the property thread).
- [ ] Preserve empty/loading/error/permission states and all existing flows.
- [ ] Browser verification on real dev/test across Manager/Resident/Vendor,
  desktop and phone; route and native parity, relevant unit/integration/e2e.
- [ ] Security-review, bugbot, cache/performance, web/native reviews; graph refresh,
  no-mistakes gate, explicit integration into prakrit and review URL.

## Required route coverage

Portfolio: `/portal/dashboard`, `/portal/properties/listed`.

Global records: `/portal/tours/pending`, `/portal/leases/manager`,
`/portal/residents/current`, `/portal/inspections/move-in`,
`/portal/payments/incoming/pending`, Communication.

Property: `/portal/properties/listed/:id/preview`, Preview, House details,
Move-in, Tours, Bookings, Application, Lease, Services, Promotion.

## Architecture findings

The app already shares `PortalRecordListSurface`, `ManagerPortalPageShell`,
`PortalPageTitleBand`, `PortalSidebar`, and role-independent layout constants.
Reuse these rather than copying the prototype's DOM normalization or sample
sessionStorage APIs. Existing co-manager permissions remain the authorization
source of truth. Workspaces do not yet have a persisted domain model; vendor
open links require their own destination, never the manager invite table.

## Validation evidence

Pending implementation. No product changes are represented as complete yet.
