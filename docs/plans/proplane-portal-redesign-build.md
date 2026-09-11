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
- [ ] Workspace persistence, Settings management, top-left switching, properties,
  managers/vendors/sharing and explicit permissions. Server-enforced caps of
  3 owned workspaces and 10 property records per workspace, drafts included.
- [ ] Manager and vendor invite links, property/module grants with No access,
  View, Edit and Manage; empty grants deny access.
- [ ] Resident record pages, dedicated Inspections and move-in/move-out dashboard
  obligations; room-scoped evidence and completion. No general resident Tasks.
- [ ] Complete Vendor business profile/work email/work number, Services (Tasks
  included), invoices/files/payments and workspace access.
- [ ] Shared persistent task system: status/filter/assignee/due/priority,
  recurrence/reminders/checklists/comments/attachments and bulk actions.
- [ ] Offered lease types and inline amenities checkboxes with Other details.
  Daily/weekly, 3/6/9/12 months, month-to-month, long-term and custom bases;
  automatic custom proration and optional advanced partial-period rate.
  Listing setup has no stay dates; actual leases may start any time.
- [ ] Bookings calendar open by default, reservations from dated bookings,
  signed leases/application holds, reversible explicit date blocks with reasons,
  overlap/capacity enforcement and exclusive check-out.
- [ ] Communication: existing one-list/two-pane pattern, phone conversation,
  compact editable contact, work-number strip, full-width composer above nav,
  visible Send via selector in tools row, AI/attachments/emoji/draft recovery,
  authorized channels and scheduling; no resident scheduling.
- [ ] Resident tour popup only Reschedule, Message host and Cancel tour, plus close.
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
