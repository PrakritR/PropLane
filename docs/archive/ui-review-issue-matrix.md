> **ARCHIVED — snapshot, not current guidance. Do not act on this file.**
> Completed audit from 2026-07-22; every row is Done, OK, or an explicit
> Exception. Its one remaining open row (the `manager-*` → `pro-*` rename)
> was lifted out to PRP-185 before archiving. Current UI rules:
> [`../agents/ui-change-checklist.md`](../agents/ui-change-checklist.md).

# UI Review Issue Matrix

Structured audit of all five Blue Steel surfaces against [`design.md`](design.md) and the canonical portal list-section pattern in [`portal-list-section-layout.md`](portal-list-section-layout.md) / [`portal-list-section.tsx`](../src/components/portal/portal-list-section.tsx).

**Severity:** P0 = breaks spec or accessibility; P1 = visible inconsistency; P2 = maintainability / naming drift.

| Surface | Route/Section | Dimension | Severity | Current | Expected | File(s) | Fix phase |
|---------|---------------|-----------|----------|---------|----------|---------|-----------|
| Primitives | Global | Component consistency | P1 | ~~Dual empty states~~ | Portal panels use `PortalDataTableEmpty` only | `portal-workspace-client.tsx` | **Done** (Wave 0) |
| Primitives | Global | Component consistency | P1 | ~~Dual tables~~ | Portal panels use `PORTAL_DATA_TABLE_*` | `portal-workspace-client.tsx` | **Done** (Wave 0) |
| Primitives | Global | Component consistency | P1 | ~~Dual shells~~ | `PortalListSectionShell` wrapper | `portal-list-section.tsx` | **Done** (Wave 0) |
| Primitives | Global | Deprecation | P2 | ~~`PORTAL_EMPTY_STATE_BOX`~~ | Single source in `portal-empty-state.tsx` | `portal-data-table.tsx` | **Done** (Wave 0) |
| Pro portal | Fallback workspace | Portal patterns | P1 | ~~Legacy shell/table/empty~~ | Canonical list-section pattern | `portal-workspace-client.tsx` | **Done** (Wave 1) |
| Pro portal | All list sections | Portal patterns | P2 | ~~Shell not implemented~~ | `PortalListSectionShell` | `portal-list-section.tsx` | **Done** (Wave 0) |
| Pro portal | Filters | Component consistency | P2 | Mixed pill controls | Documented pick per use case in JSDoc | `portal-list-section.tsx` | **Done** (Wave 0) |
| Marketing | `/`, `/partner`, `/rent/apply` | Chrome & substrate | — | Per spec | Per spec | `(public)/*` | OK |
| Marketing | `/billing/success` | Chrome & substrate | P2 | ~~Quiet chrome~~ | Full chrome per spec | `billing/success/page.tsx` | **Done** (Wave 2) |
| Auth | `/auth/*`, `choose-portal` | Chrome & substrate | — | Per spec | Per spec | `auth/*` | OK |
| Auth | OAuth finish pages | Copy & hierarchy | P2 | ~~Inconsistent spinners~~ | `AuthOAuthLoading` shared component | `auth/*-oauth*`, `continue` | **Done** (Wave 2) |
| Resident | `move-in` (locked) | Empty & loading | P1 | ~~Custom glass-card empty~~ | `PortalDataTableEmpty` | `render-portal-section.tsx` | **Done** (Wave 2) |
| Resident | Dashboard | Responsive | P2 | ~~Tiles lacked min touch height~~ | `min-h-[88px]` on `PortalDashboardTile` | `portal-metrics.tsx` | **Done** (Wave 2) |
| Resident / Admin | Nav, review queues | Surface differentiators | — | Per spec | Per spec | `portal-sidebar.tsx`, `admin-properties-client.tsx` | OK |
| All portals | Layout | Accessibility | P0 | ~~No skip link~~ | `PortalSkipLink` → `#portal-main-content` | portal layouts | **Done** (Wave 3) |
| All portals | Modals | Accessibility | P1 | ~~No focus trap~~ | `useFocusTrap` in `Modal` | `ui/modal.tsx` | **Done** (Wave 3) |
| All portals | Mobile `<lg` | Responsive | P2 | ~~Mobile nav unlabeled~~ | `aria-label="Portal sections"` | `portal-sidebar.tsx` | **Done** (Wave 3) |
| Pro portal | Naming | Maintainability | P2 | `manager-*` components at `/portal` route | Incremental rename to `pro-*` | `components/portal/manager-*.tsx` | Wave 4 |
| Primitives | Global | Component consistency | P0 | ~~Duplicate, contradictory Button components — `radix-button.tsx` (shadcn/CVA) shipped a filled-red `destructive` variant, violating the documented "danger is text-only red" rule in `design.md`~~ | Single `Button` (`ui/button.tsx`) with `asChild`/Slot support added; the two `radix-button` call sites migrated and the file deleted | `ui/button.tsx`, `ui/navbar1.tsx`, `ui/radix-button.tsx` (deleted) | **Done** (Wave 5) |
| Pro / Resident portal | Filters | Component consistency | P1 | ~~Two untracked tab one-offs beyond the documented `TabNav` / `ManagerPortalStatusPills` / `PortalSegmentedControl` set: `PortalPanelTabs` ("demo — local state", unused) and `resident-financials-panel.tsx`'s hand-rolled inverted-color (`bg-foreground text-background`) tabs~~ | `PortalPanelTabs` deleted as dead code; the financials panel merged into `ResidentPaymentsPanel` and deleted. Resident Payments has since been simplified to **Charges-only** (no sub-tab switcher; the Pending / Overdue / Paid `ManagerPortalStatusPills` remain) — see [`docs/agents/resident-payments.md`](agents/resident-payments.md) | `panel-tab-strip.tsx` (deleted), `resident-financials-panel.tsx` (deleted), `resident-payments-panel.tsx`, `render-portal-section.tsx` | **Done** (Wave 5) |
| Documents / PDF export | All formal documents | Visual consistency | P1 | ~~PDF generators (`pdf.ts`, `rent-receipt-pdf.ts`, `form-1099-nec.ts`) were ad hoc, disconnected from the on-screen `DocumentPaper` letterhead — no logo image, no bordered/zebra tables, footer missing on the formal generators~~ | Shared `pdf-theme.ts` template (Blue Steel cobalt/navy tokens, embedded logo mark, bordered/zebra tables, distinct totals row, page-X-of-Y + confidentiality footer) migrated into all three generators | `lib/reports/export/pdf-theme.ts`, `pdf.ts`, `formal/rent-receipt-pdf.ts`, `form-1099-nec.ts` | **Done** (Wave 5) |
| Documents / PDF export | Occupancy report preview | Component consistency | P2 | ~~`formal-document-preview.tsx` used raw Tailwind grays/emeralds/ambers for status-like cells instead of the shared status palette~~ | Shared `Badge` tones (`confirmed` / `pending`) | `portal/reports/formal-document-preview.tsx` | **Done** (Wave 5) |

## Portal layout conformance (pro portal)

Audit against [`portal-list-section-layout.md`](portal-list-section-layout.md). **Canonical:** Inbox, Residents, Services, Leases.

| Section | Component | Status | Notes |
|---------|-----------|--------|-------|
| Dashboard | `manager-dashboard.tsx` | Exception | KPI tile grid — not a list section |
| Properties | `manager-properties.tsx` | OK | Header CTA only; divider via always-on shell rule |
| Calendar | `portal-calendar.tsx` | Exception | Week/month grid |
| Applications | `manager-applications.tsx` | OK | `filterRow` + table pattern |
| Residents | `manager-residents.tsx` | **Canonical** | Reference implementation |
| Leases | `manager-leases.tsx` | **Canonical** | Reference implementation |
| Payments | `manager-payments.tsx` | OK | `filterRow` + table pattern |
| Services | `manager-all-services-panel.tsx` | **Canonical** | `TabNav` + conditional header CTA |
| Inbox | `manager-inbox.tsx` | **Canonical** | Reference implementation |
| Documents | `manager-documents-panel.tsx` | **Fixed** | Was nested surface + tabs in body; now `TabNav` + flat toolbar |
| Finances | `manager-finances-panel.tsx` | **Fixed** | Was nested surface; now `TabNav` + `titleAside` actions |
| Co-managers | `pro-account-links-panel.tsx` | **Fixed** | Was multi-card layout; now `filterRow` link form + table body |
| Feedback | `portal-bug-feedback-panel.tsx` | **Fixed** | Divider via shell; badge sizing aligned |
| Settings | `portal-profile-client.tsx` | Exception | Form sections, not data table |

| Pro portal | List-section layout | Portal patterns | P1 | ~~Documents / Finances / Co-managers / Feedback off-pattern~~ | Match Inbox / Residents shell | `manager-documents-panel.tsx`, `manager-finances-panel.tsx`, `pro-account-links-panel.tsx`, `portal-bug-feedback-panel.tsx` | **Done** |
| Pro portal | Shell divider | Portal patterns | P1 | ~~Missing header rule when no filterRow~~ | Always-on `border-b` in `ManagerPortalPageShell` | `portal-metrics.tsx` | **Done** |

## Cross-cutting inventory (legacy vs canonical)

| Pattern | Legacy usage | Canonical |
|---------|--------------|-----------|
| Page shell | ~~`ManagerSectionShell` in workspace client~~ | `PortalListSectionShell` |
| Empty state | `EmptyState` — loading skeletons only | `PortalDataTableEmpty` in data panels |
| Data table | ~~`DataTable` in workspace client~~ | `PORTAL_DATA_TABLE_WRAP` + raw `<table>` |
| Header CTA | Ad-hoc `Button` classes in some panels | `PortalSectionPrimaryButton` |

## Clusters for fix PRs

1. **Wave 0 — Foundations:** `PortalListSectionShell`, deprecate dual helpers, filter-control JSDoc
2. **Wave 1 — Workspace fallback:** Migrate `portal-workspace-client.tsx`
3. **Wave 2 — Surface polish:** Billing success chrome, move-in empty, dashboard tiles, OAuth loading
4. **Wave 3 — A11y:** Skip link, modal focus trap, mobile nav audit
5. **Wave 4 — Naming:** `manager-*` → `pro-*` (incremental, low priority)
6. **Wave 5 — Financials UI cleanup:** Button consolidation (delete `radix-button.tsx`), resolve the two untracked tab one-offs (resident financials merged into `ResidentPaymentsPanel`), shared branded `pdf-theme.ts` across all PDF generators, `Badge` tones in `formal-document-preview.tsx`
