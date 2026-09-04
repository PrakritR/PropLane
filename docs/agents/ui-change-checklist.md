# UI change checklist (agents)

Use this **after** Linear ticket + Lavish plan approval, **before** editing portal UI.

## Mandatory reads

| Order | Doc | Why |
| --- | --- | --- |
| 1 | `docs/portal-ui-system.md` | Expand chevrons, tables, list surfaces, overflow |
| 2 | `docs/portal-list-section-layout.md` | Title band vs split mobile actions |
| 3 | `AGENTS.md` → Portal UI system | `PortalRecordListSurface` — every list tab copies Properties |

## Every manager / resident / vendor list tab

Compose with **`PortalRecordListSurface`** — not hand-rolled wrappers.

1. **Header card** — status pills left, actions right (`PortalSectionActionRow variant="header"`)
2. **Flat rows** — `PortalPropertyRecordRow` / `PortalPersonRecordRow` / `PortalServiceRecordRow` (not top-level tables)
3. **ADD footer** — `PortalListAddRow` with unique `ariaLabel`
4. **Bulk bar** — `BulkActionBar` while selection active

Reference: manager **Properties** tab.

## Tables (detail / admin only)

- Chevron **inline after label** — `PortalTableInlineExpand`, never trailing expand column
- Collapsed → `ChevronRight`; expanded → `ChevronDown`
- Admin tabs: sort/filter pills above divider, table below (`ManagerPortalPageShell` + `portal-data-table.tsx`)

## Mobile

- Same design as desktop — reflow, not a separate layout
- Header actions appear **once** on phone (`useInlineTitleBand` vs split — see portal-list-section-layout)
- Floating bulk bar clears tab bar via `--portal-floating-bottom-gap`

## Buttons & loading

- Single **`Button`** from `@/components/ui/button.tsx` — no filled-red destructive
- Async `onClick={() => save()}` — **do not** `void save()` (drops loading guard)

## Analytics (meaningful interactions)

- Prefer `data-attr="kebab-name"` on interactive elements (PostHog autocapture)
- Named funnel events only when needed — grep `src/lib/analytics` first

## Test before handoff

- Happy path on **this pane's sandbox port** (3010 / 3011 / 3012 — not `/demo` alone)
- Mobile width (~390px) for any portal chrome or list change
- `npm run test:unit` for touched area

## Lavish plan must include (for UI work)

- [ ] Before / after sketch or screenshot reference
- [ ] Which portal + route (`/portal/…`, `/resident/…`)
- [ ] Row component choice (property / person / service)
- [ ] Mobile behavior called out explicitly
