# Portal list-section layout

Canonical layout for manager (pro) portal **list and data tabs**. Visual reference: **Inbox**, **Residents**, **Services**, **Leases**.

Full design tokens: [`design.md`](design.md). Implementation helpers: [`portal-list-section.tsx`](../src/components/portal/portal-list-section.tsx), [`portal-metrics.tsx`](../src/components/portal/portal-metrics.tsx), [`portal-data-table.tsx`](../src/components/portal/portal-data-table.tsx).

---

## Structure

```
ManagerPortalPageShell          ← single PORTAL_SECTION_SURFACE (outer card)
├── Header row                  ← title (left) · titleAside (right)   ┐
├── filterRow (optional)        ← tabs, pills, inline filters         ├ fixed chrome
├── border-b divider            ← always present                      ┘
└── Body (children)             ← the only scrolling region
    ├── optional toolbar rows   ← date/property filters (flat, no nested card)
    └── PORTAL_DATA_TABLE_WRAP  ← or PortalDataTableEmpty
```

**Chrome is pinned, the body scrolls** (`stickyPageChrome`, default on). The
shell tags `<html data-portal-sticky-chrome>` (`usePortalStickyPageChrome`) so
portal main becomes a flex viewport, then splits `children` at the first
`PortalPageScrollBody` / `PORTAL_LIST_PAGE_SCROLL_BODY` element — or after the
last `PortalListControlStack` — and wraps everything below it in the scroll body
(`portal-page-chrome-layout.tsx`). Rows above that split stay fixed with the
title and filters. Wrap the table yourself in `PortalPageScrollBody` when the
inferred split is wrong; pass `stickyPageChrome={false}` for a page that should
scroll whole. On phones this makes `.portal-list-page-scroll` — not the window —
the scroller, which is easy to break from CSS: see
[`portal-ui-system.md`](portal-ui-system.md#a-portal-pages-scroller-is-portal-list-page-scroll-not-the-window).

Use `PortalListSectionShell` as a thin alias when building new sections:

```tsx
<PortalListSectionShell
  title="Vendors"
  primaryAction={<PortalSectionPrimaryButton onClick={...}>Add vendor</PortalSectionPrimaryButton>}
  filterRow={<ManagerPortalFilterRow><TabNav ... /></ManagerPortalFilterRow>}
>
  {rows.length === 0 ? <PortalDataTableEmpty message="..." /> : <table>...</table>}
</PortalListSectionShell>
```

---

## Checklist (grep before shipping a new tab)

| # | Rule | How to verify |
|---|------|---------------|
| 1 | **One shell surface** — no nested `PORTAL_SECTION_SURFACE` in `children` | `rg PORTAL_SECTION_SURFACE` in the panel file; only the shell should use it |
| 2 | **Header actions** in `titleAside` via `PortalSectionPrimaryButton` / `PORTAL_HEADER_ACTION_BTN` | Primary CTAs not buried in body |
| 3 | **Header actions reach mobile exactly once** — pick one of the two shapes below, never both | `tests/unit/portal-inline-title-band-duplicate-controls.test.tsx` |
| 4 | **Section tabs** in `filterRow`, not in raw `children` | URL tabs → `TabNav`; status buckets → `ManagerPortalStatusPills` |
| 5 | **Divider** below header/filter block | Provided by `ManagerPortalPageShell` (always-on `border-b`) |
| 6 | **Table body** uses `PORTAL_DATA_TABLE_WRAP` + `PORTAL_DATA_TABLE_SCROLL` + table tokens | See `portal-data-table.tsx` |
| 7 | **Empty state** is `PortalDataTableEmpty` directly — no extra bordered box around it | |
| 8 | **Status badges** use `portal-badge-*` + ring, `text-[11px]`, `px-2.5 py-0.5` | Match Residents portal column |
| 9 | **Secondary filters** (date, property) as flat toolbar rows in body (`mb-4`), not inside a nested card | Finances, Documents |

### Rule 3 — the two legal header-action shapes

`ManagerPortalPageShell` renders `PortalPageTitleBand` at **every** breakpoint once
`hideTitleOnMobileNav` + `titleAside` are set with no `filterRow` (`useInlineTitleBand`).
So a section's header controls can reach a phone exactly one of two ways:

- **Band-only** — an ungated `titleAside` and **no** `PortalPageHeaderMobileActionsRow`.
  This is the default for new sections (Applications, Residents, Properties, Tour).
- **Split** — a `hidden md:flex` `titleAside` (invisible on phones) paired with an
  `md:hidden` mobile actions row. The resident Documents, Lease, and Payments panels
  are the three sections still on this shape.

Mixing them draws every control twice on a phone; deleting the mobile row from a split
section leaves zero. Passing a `filterRow` sidesteps the choice — the shell desktop-gates
the aside itself (`titleAsideDesktopOnly`) and moves the mobile copy into
`PortalPageFooterActions`.

---

## Filter control pick

| Use case | Component |
|----------|-----------|
| URL-linked section tabs (Services, Documents) | `TabNav` in `ManagerPortalFilterRow` |
| In-section status with counts (Inbox, Residents, Leases) | `ManagerPortalStatusPills` |
| Binary view toggle | `PortalSegmentedControl` |
| Property scope | `PortalPropertyFilterPill` in `titleAside` or mobile filter row |

---

## Reference implementations

| Section | File | Notes |
|---------|------|-------|
| Inbox | [`manager-inbox.tsx`](../src/components/portal/pro-inbox.tsx) | Status pills + header/mobile actions. Layout reference only: its `ManagerPortalPageShell` branch renders on `/demo` alone — the real portal mounts the panel embedded in Communication (see AGENTS.md → "Inbox panels"), so controls added there do not ship. |
| Residents | [`manager-residents.tsx`](../src/components/portal/pro-residents.tsx) | Property filter + status pills + table |
| Services | [`manager-all-services-panel.tsx`](../src/components/portal/pro-all-services-panel.tsx) | `TabNav` + conditional header CTA |
| Leases | [`manager-leases.tsx`](../src/components/portal/pro-leases.tsx) | Property filter + status pills |

---

## Known exceptions (do not force list-section layout)

| Section | Reason |
|---------|--------|
| Dashboard | KPI tile grid |
| Calendar | Week/month grid |
| Settings / Profile | Form sections, not data tables |
| Billing (Plan) | Pricing / subscription UI |
| Properties (listings) | Embedded sub-panel; no section tabs |

---

## Anti-patterns

- Tabs rendered as raw `Link` pills in `children` instead of `filterRow` + `TabNav`
- Nested `PORTAL_SECTION_SURFACE` wrapping filters + table (double card)
- Standalone `rounded-2xl border bg-card` blocks for entire list pages (Co-managers link form)
- Export / Add buttons only in body instead of `titleAside`
- Custom empty states inside nested boxes instead of `PortalDataTableEmpty`

---

## Audit log

The per-section pass/fail table that used to live here is an archived snapshot from
2026-07-22 — [`archive/ui-review-issue-matrix.md`](archive/ui-review-issue-matrix.md).
It records what was true then, not what is true now; read the rules above and the
component, never that table.
