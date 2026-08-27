# Portal UI system

Canonical patterns for expandable rows, section cards, and data tables across manager, resident, vendor, and admin portals. **Read this before editing portal UI.**

Reference implementation: **resident detail in the property portal** (`manager-residents.tsx` → `ResidentDetailSection` + nested tables).

## Expand chevron direction

| State | Icon | Component |
|-------|------|-----------|
| Collapsed | `ChevronRight` (→) | `PortalTableExpandChevron` |
| Expanded | `ChevronDown` (↓) | `PortalTableExpandChevron` |

Never rotate a single chevron — swap icons. Shared primitive: `PortalTableExpandChevron` in `portal-data-table.tsx`.

## Expandable table rows

**Rule:** Chevron sits **inline immediately after the primary label** in the first (or designated primary) data column. No trailing expand column.

```tsx
import {
  PORTAL_DATA_TABLE,
  PORTAL_DATA_TABLE_WRAP,
  PORTAL_DATA_TABLE_SCROLL,
  PORTAL_TABLE_HEAD_ROW,
  PORTAL_TABLE_TR_EXPANDABLE,
  PORTAL_TABLE_TD,
  PORTAL_TABLE_DETAIL_ROW,
  PORTAL_TABLE_DETAIL_CELL,
  PortalTableInlineExpand,
  createPortalRowExpandClick,
} from "@/components/portal/portal-data-table";
import { MANAGER_TABLE_TH } from "@/components/portal/portal-metrics";

<tr
  className={PORTAL_TABLE_TR_EXPANDABLE}
  onClick={createPortalRowExpandClick(() => toggle(row.id))}
  aria-expanded={expanded}
>
  <td className={`${PORTAL_TABLE_TD} font-medium text-foreground`}>
    <PortalTableInlineExpand expanded={expanded}>{row.name}</PortalTableInlineExpand>
    <p className="mt-0.5 text-xs text-muted">{row.email}</p>
  </td>
  <td className={PORTAL_TABLE_TD}>{row.property}</td>
</tr>
{expanded ? (
  <tr className={PORTAL_TABLE_DETAIL_ROW}>
    <td colSpan={COLUMN_COUNT} className={PORTAL_TABLE_DETAIL_CELL}>
      {detailContent}
    </td>
  </tr>
) : null}
```

### Do NOT use (deprecated)

- `PORTAL_TABLE_EXPAND_TH` — zero-width trailing header column
- `PortalTableExpandCell` — trailing chevron cell at far right
- `justify-between` + chevron on mobile card headers (creates huge gap)

### Table layout tokens

| Token | Purpose |
|-------|---------|
| `PORTAL_DATA_TABLE_WRAP` | Outer card frame for tables |
| `PORTAL_DATA_TABLE_SCROLL` | Overflow wrapper |
| `PORTAL_DATA_TABLE` | `table-fixed w-full` base |
| `MANAGER_TABLE_TH` | Header cell (`w-0` for fluid columns) |
| `PORTAL_TABLE_TD` | Data cell (`max-w-0 break-words px-4 py-4`) |
| `PortalDataTableColGroup` | Optional weighted column widths |

Good examples: `portal-inbox-ui.tsx`, `resident-applications-panel.tsx` (desktop), `manager-residents.tsx` (main residents table).

## Dashboard / section cards

For collapsible property-portal sections (APPLICATION, LEASE, PAYMENTS):

```tsx
import { PortalCollapsibleSection } from "@/components/portal/portal-collapsible-section";

<PortalCollapsibleSection
  title="Payments"
  titleVariant="resident"   // uppercase muted label + inline chevron
  subtitle="2 pending · 1 overdue"
  expanded={expanded}
  onExpandedChange={setExpanded}
  headerActions={<Button>Add</Button>}
>
  {sectionContent}
</PortalCollapsibleSection>
```

- Title + chevron: `inline-flex items-center gap-1.5` (no `justify-between` on title row)
- Subtitle: `mt-1 text-sm text-muted` on the line below
- Chevron: right when collapsed, down when expanded (built into component)

`ResidentDetailSection` in `manager-residents.tsx` wraps `PortalCollapsibleSection` with `titleVariant="resident"`.

### `PortalCollapsibleSection` vs table inline expand

| Use | When |
|-----|------|
| `PortalCollapsibleSection` | Standalone section cards with header + body (property detail panels, promotion blocks, settings groups) |
| `PortalTableInlineExpand` | Rows inside a `<table>` or mobile list cards that expand to show detail |

## Mobile card expand pattern

Use `PortalMobileSummaryCard` when you need title + subtitle + optional badge/trailing actions:

```tsx
<PortalMobileSummaryCard
  title={row.name}
  subtitle={row.email}
  expanded={expanded}
  onClick={() => toggle(row.id)}
>
  {expanded ? detail : null}
</PortalMobileSummaryCard>
```

For custom mobile cards, put the chevron inline with the title:

```tsx
<button type="button" className="w-full text-left" onClick={toggle}>
  <PortalTableInlineExpand expanded={expanded} className="font-semibold text-foreground">
    <span className="truncate">{title}</span>
  </PortalTableInlineExpand>
  <p className="mt-0.5 truncate text-xs text-muted">{subtitle}</p>
</button>
```

`PortalResponsiveDataView` pairs mobile card stack (`lg:hidden`) with desktop table (`hidden lg:block`).

## Expanded detail actions

```tsx
import { PortalTableDetailActions, PORTAL_DETAIL_BTN } from "@/components/portal/portal-data-table";

<PortalTableDetailActions>
  <Button variant="outline" className={PORTAL_DETAIL_BTN}>Schedule</Button>
</PortalTableDetailActions>
```

## Page shell & filters

Admin/manager tab tables use `ManagerPortalPageShell` with `filterRow` above the divider — see `admin-inbox-client.tsx` and `AGENTS.md` → Admin portal table tabs.

### A portal page's scroller is `.portal-list-page-scroll`, not the window

`ManagerPortalPageShell` defaults to `stickyPageChrome`, which sets
`html[data-portal-sticky-chrome]`. That flips `#portal-main-content` to
`overflow: hidden` and moves the scroll into the `.portal-list-page-scroll` box
that `renderPortalStickyBody` wraps the page body in
(`src/lib/portal-page-chrome-layout.tsx`). Communication surfaces do the same via
`html[data-communication-surface]`. Everything between those two elements must
therefore stay a `flex min-h-0 flex-1 flex-col` chain, or the scroller sizes to
its content inside a clipped parent and the page silently stops scrolling below
the first viewport — no error, no failing build, and pages whose content happens
to fit look fine.

Watch for **unlayered rules in `globals.css` beating Tailwind utilities**: they
win over anything in `@layer utilities` regardless of specificity, so a rule like
`.portal-main-inner > * { flex: 0 0 auto }` overrides the shell's `flex-1`. That
one shipped and clipped Settings, Payments and Residents on every phone. Scope
new `.portal-main-inner` / `#portal-main-content` layout rules to the surfaces
they mean (`html:not([data-portal-sticky-chrome]):not([data-communication-surface])`
for page-scrolls surfaces). Coverage: `tests/unit/portal-mobile-shell.test.ts`.

The same split governs **bottom clearance**. On a page-scrolls surface
`#portal-main-content` is the scroller, so its `padding-bottom` becomes trailing
scroll room; on a sticky-chrome surface it is clipped, so padding there can only
shrink the scroll viewport into a dead band. Phone-width sticky-chrome rules
therefore reserve only what is genuinely fixed over the page — the bottom-nav
inset, plus the bulk-action bar when one is open. Never reserve additional
clearance on a clipped element; the rationale and the disjoint bulk-bar selector
are commented at the rules in `globals.css`.

Verify a phone change by measuring, not by eyeballing the first screenful:
`scroller.scrollHeight - scroller.clientHeight` must be > 0 and
`inner.scrollHeight - inner.clientHeight` must be 0 on a page taller than the
viewport.

#### A fill-height panel needs an unbroken chain, or the page chrome is lost

The clip is not only about scrolling. Content that overflows
`#portal-main-content` / `.portal-main-inner` is *unreachable*, so it pushes the
page's own header off-screen instead of extending the page. Any panel that asks
to fill the viewport therefore needs `flex-1` + `min-h-0` on EVERY ancestor up to
`.portal-main-inner`; one `display: block` link sizes it to content and breaks
the whole chain. `PortalRecordDetailPage`'s body wrapper is a block by default
and takes an opt-in `fillBody` for exactly this — resident detail →
Communication is the only caller, and the ~10 other detail pages flow and must
stay block.

`useCommunicationSurfaceChrome({ threadReading: true })` is a separate, stronger
claim: it also hides the mobile nav bar and the page header, justified by "thread
view uses the inbox back header". Only pass it on a surface that actually renders
one — `ManagerInbox` sets `onBack={undefined}` whenever `filterResidentEmail` is
set, so the resident-detail Communication tab does not qualify and passes
`threadReading: false`. Coverage:
`tests/unit/resident-detail-communication-chrome.test.ts`.

## Filter dropdowns: one portaled-overlay pattern

Every portal filter field (property / resident / status / sort / scope) is ONE
pattern: a single-line trigger showing a summary (placeholder when empty) + a
chevron, and an option list that opens as a PORTALED OVERLAY anchored to the
trigger — never inline in flow. Opening a field must not push the fields below it
or resize the panel.

- **Shared machinery:** `src/components/ui/field-select-menu.tsx`
  (`useFieldSelectMenu`, `resolveFieldSelectMenuPortal`, rect math, the 5-row
  constants, `FieldSelectMenuSearch`). It portals into the open modal / Vaul
  sheet shell when there is one, else `document.body` — so it works inside the
  `PortalFilterSortSheet` modal, the mobile bottom sheet, and the desktop
  dropdown popover alike. Do NOT fork a second positioning implementation.
- **The filter panel itself is portaled too.** `PortalFilterSortSheet`'s desktop
  dropdown anchors through the same `useFieldSelectMenu`, so it escapes the
  page's scroll/overflow instead of being absolutely positioned inside the
  toolbar. Its height comes from `portalFilterPanelSizeClass(filterFieldCount)`
  — pass `filterFieldCount` (the number of filter rows you render, default 1) or
  a multi-field panel opens at single-field height.
- **Picks are handled NATIVELY on the listbox, never by a React handler on the row.**
  `useFieldSelectListboxPointerPick` (`src/components/ui/field-select-listbox-pick.ts`)
  binds `pointerdown`/`pointerup` to the list element and reads the picked row's
  `FIELD_SELECT_OPTION_VALUE_ATTR` (`data-field-select-option-value`); every option list —
  `FilterCheckboxList`, `FilterSingleSelectList`, `CheckboxMultiSelect`, `FieldSingleSelect` —
  goes through that one hook. A synthetic `onClick` / `onPointerDown` fails twice over: the
  menu portals under `document.body`, outside the root React attaches its delegated listeners
  to, so the handler never runs in production while jsdom tests still pass; and acting on
  pointerdown turns the first frame of a scroll drag into a selection, which is why the hook
  waits for a pointerup within `FIELD_SELECT_LISTBOX_PICK_SLOP_PX` of the press. The
  pointerdown helpers in `field-select-portal-interaction.ts` are the superseded shape and
  have no callers left. Coverage: `tests/unit/field-select-listbox-pick.test.tsx`.
- **Every portal filter stays inside the page canvas automatically.**
  `PortalFilterSortSheet` constrains its desktop dropdown to the nearest
  `data-slot="portal-page-title-band"`, then the enclosing
  `data-slot="portal-page-shell"`, by default. A wide panel therefore opens inward
  instead of painting over the portal sidebar or assistant rail, including filters
  rendered in a shell's separate filter row. A filter outside a portal page falls
  back to normal viewport bounds; callers do not opt in tab by tab.
- **Filter fields:** `src/components/portal/filter-field-lists.tsx`
  (`FilterCollapsibleSection` + `FilterCheckboxList` multi / `FilterSingleSelectList`
  single, inside a `FilterFieldsAccordion` for one-open-at-a-time). `CheckboxMultiSelect`
  / `FieldSingleSelect` (`checkbox-multi-select.tsx`) are the same pattern for
  form/toolbar/scope pickers — prefer them over a bare `<select>`.
  `menuOptionCount` is REQUIRED on `FilterCollapsibleSection`: it sizes the portaled
  menu until the child list reports the rows it actually renders (see the row-count
  bullet below).
- **5 rows, then scroll:** the cap lives on the portaled SHELL — its `maxHeight`
  is `fieldSelectMenuContentPx(<the field's OWN option count>, …)`, which clamps
  that count to 1..5, and `FIELD_SELECT_MENU_VISIBLE_ITEMS` (aliased as
  `FILTER_LIST_VISIBLE_ROWS`) stays the single source of the "5". So 5+ options
  give exactly 5 rows and scroll, and 3 options end the box after the third row
  instead of padding two empty ones. The option list is a shrinkable flex child
  (`FIELD_SELECT_MENU_LISTBOX_SCROLL_CLASS`, which also carries the touch-scroll
  affordances) that scrolls under that cap, and the shell itself is `height: auto`
  — so a short or filtered list leaves no empty space below it. Never give the
  listbox a fixed height or `flex-1`, and never size the shell from
  `FIELD_SELECT_MENU_VISIBLE_ITEMS` regardless of the field: both reintroduce the
  empty padding. A search box appears on portal filter menus
  (`FILTER_FIELD_MENU_ALWAYS_SHOW_SEARCH`) and never drops an already-selected
  option; the shared `CheckboxMultiSelect` / `FieldSingleSelect` still show one
  only above 5 options.
- **The mobile filter sheet is bottom-anchored and FILLS the viewport.**
  `PortalFilterSortSheet` passes `fillViewport` to `VaulBottomSheet`, which opens the
  sheet at its own max height and seats it on
  `--portal-native-bottom-nav-inset`, so the card background reaches the tab bar
  instead of hugging its fields and leaving a lit gap below. That is the default
  (`mobileSheetFillsViewport`, default true); browse-homes still passes it
  explicitly, where it is now documentary.
- **`mobileSheetRaised` is the legacy raised placement** — opt-in, currently used by
  nothing, and the only path that still reads
  `PORTAL_FILTER_RAISED_SHEET_MIN_HEIGHT_PX`. It sets `autoElevate` on
  `VaulBottomSheet`: a fixed `bottom: max(32vh, …)` plus a max-height derived from
  that same offset. It is a PROP, never a measurement — it used to be gated on a
  `height < viewport * 0.52` measurement, so a sheet whose content changed while
  open flipped placement and visibly JUMPED, and a measured placement can always
  jump. Three consequences if you re-enable it:
  a raised sheet must suppress Vaul's `::after` overscroll fill (`globals.css`,
  keyed on `data-elevated`) or that fill paints across the gap below it; the
  sheet body must NOT impose its own smaller max-height, or the lower fields get
  pushed past the sheet's bottom edge; and the raised content must publish
  `--initial-transform: calc(100% + var(--portal-raised-sheet-offset))`
  (`RAISED_SHEET_STYLE`), because Vaul's `slideToBottom` exit keyframe translates
  only 100% of the drawer's OWN height — a raised sheet left on the default ends
  the close animation still on screen and then unmounts abruptly. That `style`
  prop looks unused; it is load-bearing.
- **`preferOpenDown` is a preference, not a lock** (`resolveOpenUp`), and it never
  costs a row. Four ordered rules: fits below → down; else fits fully above → UP
  regardless of the preference (rules 1–2 are the always-5-rows guarantee); else
  no preference → the roomier side; else hysteresis — flipping up must buy a full
  `FIELD_SELECT_MENU_ITEM_HEIGHT_PX` row, so a 1px difference cannot throw the menu
  over the fields it was opened from. The hysteresis only arbitrates the leftover
  case where NEITHER side can show 5 rows. Forcing down unconditionally rendered a
  one-row menu for a trigger low in the viewport.
- **Containment beats anchoring; the viewport bound is a last resort.** A menu that
  escapes its sheet onto the dimmed page reads as broken, so whenever the HOST can
  hold the whole menu BELOW ITS OWN CHROME it is slid back inside that box — even when
  neither side of the trigger alone has room, which can overlap the trigger by the
  shortfall. Only a host too short to seat the menu at all (a one-field sheet) falls
  back to `bottomBoundPx` and overhangs, because showing five rows outranks staying
  inside a box that cannot fit them. Both hosts are `overflow-visible` so that fallback
  can render at all.
- **TAG YOUR HOST'S FIXED CHROME OR A MENU WILL COVER YOUR CLOSE CONTROL.** Put
  `FIELD_SELECT_HOST_CHROME_ATTR` (`data-field-select-host-chrome`) on the host's drag
  handle + title/close row, and `fieldSelectHostTopInsetPx` measures it at RUNTIME (a
  stale constant would silently start hiding the control again). EVERY placement —
  contained and spilled, up and down, in a sheet (`computeFieldSelectMenuRectInHost`)
  and in a modal/dialog (`computeFieldSelectMenuRect`) — then starts at
  `topInset + gap`. There is no "except in a modal" carve-out: a host that is tall
  enough today is a coincidence, not a guarantee. Untagged, the clamp treats chrome as
  free space; that shipped a 1-field mobile sheet whose close ✕, title, handle and
  trigger were ALL 100% covered, and `FilterCheckboxList` does not close on pick and a
  phone has no Escape key, so it could strand the user. Tagged today:
  `VaulBottomSheet`, `FilterDropdownHeader` (`portal-filter-sort-sheet.tsx`), and the
  `Modal` header row.
- **Two chrome reservations, both MEASURED — do not recompute them from the utility
  classes.** `PORTAL_FILTER_PANEL_CHROME_PX` = **58** (desktop Filter/Reset/✕ row;
  arithmetic once said 37, and the 22rem panel that produced left 286px against a
  292px menu, so menus quietly went back to spilling).
  `PORTAL_FILTER_SHEET_CHROME_PX` = **88** against a measured **75** — deliberately
  over-reserved, because under-reserving is what hides the dismiss control.
  `PORTAL_FILTER_RAISED_SHEET_MIN_HEIGHT_PX` is DERIVED
  (`FILTER_MENU_CONTENT_PX + PORTAL_FILTER_SHEET_CHROME_PX + 12`), never typed in, so a
  raised sheet (`mobileSheetRaised`) is always tall enough to contain its widest menu
  below its chrome; the viewport-filling default clears that bar on its own.
  Re-measure and re-pin whenever the chrome changes.
- **The menu does NOT repeat the field name.** The trigger row already renders the
  label (`FILTER_FIELD_LABEL_CLASS`) and the portaled menu no longer covers it, so an
  in-menu header just printed "PROPERTY" twice on Residents and every other sheet.
  `fieldSelectMenuContentPx` therefore budgets only the search row —
  `FILTER_MENU_CONTENT_PX` is 5×40 + 12 + 52 = **264px**, and everything derived from
  it (`PORTAL_FILTER_RAISED_SHEET_MIN_HEIGHT_PX`, the containment math) follows.
  `FieldSelectMenuHeader` / `FIELD_SELECT_MENU_HEADER_PX` are still declared in
  `field-select-menu.tsx` with no callers; anything that re-adds a header must budget
  it in `fieldSelectMenuContentPx` — never pay for it with an option row — and re-check
  the tightest host, the 3-field panel (23rem/368px, 58px chrome, 8px containment gap).
- **The menu's row count is reported by the list that renders it**, via
  `useRegisterFilterMenuOptionCount` in a layout effect, so it overrides
  `FilterCollapsibleSection`'s `menuOptionCount` prop before paint. The count feeds
  `menuContentPx` → `resolveOpenUp`, so a hand-synced number drifting from the array
  changed a menu's height AND its open direction with no test failure — and two callers
  inject their own leading "All …" row, so a caller's raw options array is not the
  rendered row count either.
- **One open field per SHEET, not per group.** `PortalFilterSortSheet` wraps its
  children in `FilterFieldsAccordionScope`, and `FilterFieldsAccordion` defers to an
  enclosing scope rather than opening a second one — Finances composes its sheet from
  two sibling groups (`ReportFilterBar` + `FinancesRowFilters`) and used to hold one
  open menu per group, stacking two over the panel. `sectionId` must therefore be
  unique across the whole sheet, not merely within a group.
  Regression coverage: `tests/unit/filter-field-lists.test.tsx`.

## Modals scroll in ONE place

The `Modal` body (`src/components/ui/modal.tsx`) is the modal's single scroll
container in both variants (with and without `footer`). Do not wrap modal
children in another `overflow-y-auto` — nested scrollers trap touch scrolling
in the native WebView — and never reintroduce `overflow-hidden` on the body:
that clipped every below-the-fold field on phones for footer modals whose
children didn't hand-roll a scroller (`tests/unit/modal-scroll-container.test.tsx`
pins this). A child may still pin an inner scroll region (`min-h-0 flex-1
overflow-y-auto`, e.g. a message body) — the footer variant keeps the flex
column chain for that. Field-level scrolling (a `max-h` textarea) is fine.

Native shell: the panel caps at `100dvh` minus the safe-area insets and the
backdrop wrapper pads by the same insets (see `MODAL_PANEL_CLASS`), so the
header/Close never sits under the notch.

A hand-rolled panel does NOT inherit that cap. `.modal-panel` sets no height of
its own, and a panel inside a `fixed inset-0` overlay can never be scrolled by
the page, so its own `max-h-…` + `overflow-y-auto` is the only thing keeping its
action row reachable on a short phone — dropping them put Approve/Delete on the
calendar detail popover out of reach at 667px. Coverage:
`tests/unit/portal-modal-reachable-actions.test.ts`.

File saves must go through `downloadOrShareFile`
(`src/lib/native/download-or-share.ts`) — a synthetic `<a download>` on a blob
URL is silently ignored in iOS WKWebView; the helper web-downloads on web and
presents the native share sheet in the app shell. That covers client-generated
files (flyers, exports) and, in the native shell only, fetched bytes a tap is
meant to save (inbox attachments — see AGENTS.md → Inbox attachments, whose
`Content-Disposition: attachment` WKWebView also ignores).
Fixed-width document previews (the flyer iframe) scale to fit the container
width instead of relying on iframe-internal scrolling, which is unreliable in
WKWebView — see `computeFlyerFit` + `useFlyerFit` in
`promotion-flyer-preview.tsx`. WKWebView also does not render a PDF embedded in
an iframe/object at all, so `UploadedLeasePdfPreview`
(`uploaded-lease-pdf-preview.tsx`) deliberately keeps TWO render paths: the
browser's native viewer on desktop, and in-page rasterization with the pdf.js
build that already ships inside `unpdf` (dynamically imported, so its chunk stays
out of the initial bundle) on iOS / native. Rasterizing belongs in the client —
the bytes are already there, so it costs no round trip. Coverage:
`tests/unit/uploaded-lease-pdf-preview.test.tsx`.

## Checklist for new expandable UI

1. Chevron inline after primary label (`PortalTableInlineExpand` or `PortalCollapsibleSection`)
2. Collapsed → `ChevronRight`, expanded → `ChevronDown`
3. No trailing expand column
4. `createPortalRowExpandClick` on expandable `<tr>` rows
5. `aria-expanded` on toggle targets
6. Mobile + desktop both follow inline chevron pattern
7. `colSpan` on detail row = data column count only (no expand column)

## Reference files

| Pattern | File |
|---------|------|
| Section cards (resident detail) | `manager-residents.tsx` → `ResidentDetailSection` |
| Table inline expand (inbox) | `portal-inbox-ui.tsx` |
| Resident applications table | `resident-applications-panel.tsx` |
| Collapsible section primitive | `portal-collapsible-section.tsx` |
| Table primitives | `portal-data-table.tsx` |
| Mobile summary card | `PortalMobileSummaryCard` in `portal-data-table.tsx` |
| In-modal assistant side panel | `modal-assistant-strip.tsx` + `modal.tsx` / `manager-add-listing-form.tsx` |

## In-modal PropLane Assistant: side panel, not a bottom band

`ModalAssistantStrip` (embedded via the shared `Modal` component, and directly
in the listing wizard `manager-add-listing-form.tsx` — the only two embed
points) opens beside the modal's content once the modal is wide enough,
instead of always stacking below it. The switch is a CSS container query, not
a viewport breakpoint: modal widths vary hugely across embed points (`max-w-md`
at 448px up to the listing wizard's `max-w-6xl` at 1152px), so a single
viewport breakpoint would force many already-narrow modals into an unusable
side-by-side squeeze. The row layout engages at the Tailwind `@2xl` container
breakpoint (42rem / 672px of available panel width) — below that (every phone
viewport, and any modal capped at `max-w-lg`/`max-w-md` or narrower even on a
wide screen) it stays the original stacked layout. The strip owns its own
open/closed state and reports it via `onExpandedChange` so the ancestor can
flip `flex-col` → `@2xl:flex-row`; the row layout itself is gated on that JS
"open" state too, so a *collapsed* strip is always the original thin bottom
bar regardless of width.

**Which side, and open by default.** Two opt-in props tune this per surface,
both defaulting to the shared-`Modal` behavior so only the listing wizard
changes: `side` (`"right"` default) picks whether the expanded chat docks left
or right (it swaps the `@2xl` divider between `border-l`/`border-r` and the inner
padding), and `defaultExpanded` (`false` default) is the initial + per-open state.
The listing wizard passes `side="left"` and `defaultExpanded={prefersAssistantOpenBeside()}`
(true only at ≥1024px viewport) so managers see the assistant to the *left* of the
form on desktop, collapsed on phones/tablets. Because content stays first in the
DOM (so the collapsed strip and the whole narrow-screen stack sit *below* the
fields), the wizard floats the expanded chat left with `@2xl:order-first`, applied
only while open. `prefersAssistantOpenBeside()` guards `window.matchMedia` for SSR
and jsdom.

**Gotcha:** a CSS container cannot query its own size for its own layout —
`@container` must sit on an ancestor (the modal panel / wizard panel `<div>`) of the
element whose `@2xl:flex-row` reacts to it, one level up. Putting `@container`
and `@2xl:flex-row` on the same element silently no-ops (it stays column no
matter how wide the container gets). Cost real debugging time once; verify any
new container-query layout with a computed-style check
(`getComputedStyle(el).flexDirection`), not just a class-list read.
