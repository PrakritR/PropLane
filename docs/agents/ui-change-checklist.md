# UI change checklist (agents)

Use this **before** editing portal UI. On Prakrit work, that is after Lavish plan approval (no ticket unless requested). On Akhil work, start here when the change is UI.

## The UI docs, in two tiers (PRP-183)

**Only tier 1 is a rule.** Everything else is a snapshot of what someone found on
a particular day — true then, silently stale now. Before this split, a finished
July audit sat next to the standards looking exactly like a live defect list,
and an agent told to "read the area doc first" could spend its context
re-reading solved work or "fixing" something fixed months ago.

### Tier 1 — standing rules (read these)

| Order | Doc | Why |
| --- | --- | --- |
| 1 | `docs/portal-ui-system.md` | Expand chevrons, tables, list surfaces, overflow |
| 2 | `docs/portal-list-section-layout.md` | Title band vs split mobile actions |
| 3 | `docs/design.md` | The visual system — colour, type, spacing, Blue Steel |
| 4 | `docs/website-component-standard.md` | Marketing-site counterpart to `design.md` |
| 5 | `AGENTS.md` → Portal UI system | `PortalRecordListSurface` — every list tab copies Properties |
| 6 | `docs/agents/send-message-compose.md` | Any send copies New message; body is auto-formatted from every collected fact |

### Tier 2 — point-in-time, never a rule

| Doc | What it is |
| --- | --- |
| `docs/website-ui-audit-2026-08.md` | **Open findings**, tracked as PRP-184 — a work list, not the current state |
| `docs/archive/ui-review-issue-matrix.md` | Finished 2026-07-22 audit; its one live row became PRP-185 |
| `docs/archive/website-redesign-prototypes.md` | Exploration that was never adopted |

**Adding a doc?** It goes in tier 1 only if it states a rule that holds
indefinitely. An audit, a review, or anything with a date in its name is tier 2
and belongs under `docs/archive/` once its open rows are ticketed — archiving
must never be how a live finding disappears.

## Every manager / resident / vendor list tab

Compose with **`PortalRecordListSurface`** — not hand-rolled wrappers.

1. **Header card** — status pills left, actions right (`PortalSectionActionRow variant="header"`)
2. **Flat rows** — `PortalPropertyRecordRow` / `PortalPersonRecordRow` / `PortalServiceRecordRow` (not top-level tables)
3. **ADD footer** — `PortalListAddRow` with unique `ariaLabel`
4. **Per-record ⋯ menus** — use the shared `PortalRecordListSurface` action context. No Select strip, list checkboxes, or floating bulk bar.
5. **No pills on rows.** A row is tile · title · place line · glyph facts ·
   figure · ⋯. Never a `Badge` or status chip on it: the tab already says the
   bucket (Approved, Pending, Signed, Paid), and anything else the row must say
   — a Draft inside the Manager-review bucket, a flagged screening, an existing
   resident — is plain grey fact text with a glyph (`PortalRowFact`). "Added by
   you", "Approved · Active", "Needs photos" are the kind of thing that never
   comes back. Guard: `tests/unit/portal-list-rows-no-pills.test.ts`.
6. **Search box in the command bar.** Every list tab passes `search` to
   `PortalListControlStack` ("Search leases"), filters the current bucket's
   rows through `matchesPortalListSearch` (`src/lib/portal-list-search.ts`),
   and shows `portalEmptyNoMatchTitle` with a Clear search action on no match.
   Tab counts stay the bucket totals.

Reference: manager **Properties** tab.

## Record action rules

- Opening a menu targets one record and clears any previous target. Keep `onBulkClear` and existing actions wired while their selection adapter is internal.
- Actions remain stage- and permission-aware. Destructive confirmations and server authorization stay authoritative.
- Wrap action buttons in `RecordActionItems`; custom action components must honor `RecordActionItemsContext` for keyboard navigation.
- Desktop menus and mobile sheets use the shared glass surface and 44px targets.
- Form/permission checkboxes outside record lists remain ordinary checkboxes.
- Closing an action menu must not discard the target needed by an open editor. Clear targets on route/workspace changes and before opening a different record menu.

## Tables (detail / admin only)

- Chevron **inline after label** — `PortalTableInlineExpand`, never trailing expand column
- Collapsed → `ChevronRight`; expanded → `ChevronDown`
- Admin tabs: sort/filter pills above divider, table below (`ManagerPortalPageShell` + `portal-data-table.tsx`)

## No subtext

Site-wide, not wizard-only. The captain's standing rule (PLAN-0914-1615): a
screen is labels and controls. Never generate a muted sentence under a heading,
row, field, or choice.

- **Do not add** step subtitles, section descriptions, field hints, "optional"
  markers, explanatory sentences under a row or in a footer, or descriptions
  under choice tiles and radio cards.
- **Do**: label + control; a red asterisk for required; a placeholder that
  shows the shape of the answer (`140 sq ft`, `1,100`); an error line only
  after a failed action. If a field needs a paragraph, redesign the field.
- **Counts** (bedrooms, bathrooms in halves, floors, residents, beds, months)
  are `CountStepper`s. **Picks** are dropdowns; **pick-several** is
  `MultiPick` (`CheckboxMultiSelect` at cell size with an Other entry row).
  No chips or pills as controls.
- **Records** (rooms, bathrooms, shared spaces, fees, bundles) are
  `RecordCard`s of `FactRow`s at every width — nothing scrolls sideways on a
  phone; the website gets the same cards in its wider workspace.
- Guard: `tests/unit/no-subtext-listing-wizard.test.ts` reads the wizard
  source and fails on `hint=`, `subtitle=`, `description=`, `optional`, or a
  sentence of grey text. Billing: `tests/unit/pro-plan-no-subtext.test.ts`.
  Do not site-sweep existing copy unless the surface is in scope.

## Icon chrome

Secondary utilities in a title or card header — Share, Copy, Filter, Settings,
Download, Edit, Delete — are `PortalIconAction` in the top right. The word is
the tooltip and `aria-label` only; never a labeled pill or outline button in
that chrome.

Labeled text is reserved for a data-commit (**Save**) or a destructive confirm
(**Delete** after confirm). Apply this on the surface you are changing; do not
site-sweep every utility in the app.

**Settings property scope:** one property control in module chrome (the title
row next to Services, Tours, …). Never repeat it on each section header.
Account / Billing / API / Feedback stay unscoped.

## Mobile

- Same design as desktop — reflow, not a separate layout
- Header actions appear **once** on phone (`useInlineTitleBand` vs split — see portal-list-section-layout)
- Row actions open in a bottom sheet above the native safe area. Trigger hit targets are at least 44 × 44 CSS pixels.

## Buttons & loading

- Single **`Button`** from `@/components/ui/button.tsx` — no filled-red destructive
- Async `onClick={() => save()}` — **do not** `void save()` (drops loading guard)

## Analytics (meaningful interactions)

- Prefer `data-attr="kebab-name"` on interactive elements (PostHog autocapture)
- Named funnel events only when needed — grep `src/lib/analytics` first

## Test before handoff

- Happy path on **this pane's sandbox port** (3010 / 3011 / 3012 — not `/demo` alone)
- **`npm run sandbox:open -- </route>`** — opens the captain's browser on the fixed feature (`docs/agents/sandbox-open-review.md`)
- Mobile width (~390px) for any portal chrome or list change
- `npm run test:unit` for touched area

## Lavish plan must include (for UI work)

- [ ] Before / after sketch or screenshot reference
- [ ] Which portal + route (`/portal/…`, `/resident/…`)
- [ ] Row component choice (property / person / service)
- [ ] Mobile behavior called out explicitly
