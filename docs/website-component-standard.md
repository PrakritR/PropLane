# PropLane Website Component Standard

Status: Website phase, version 1.0. This document extends [`design.md`](design.md) and [`portal-ui-system.md`](portal-ui-system.md). When a rule conflicts, the more specific portal behavior in this document governs redesigned list and record-management surfaces. Capacitor-specific refinements remain phase two.

## 1. Design objective

PropLane is an operational product. Every screen should answer, in order:

1. Where am I?
2. What needs attention?
3. What is the next permitted action?
4. What records or facts support that decision?

Visual prominence follows that order. Empty space is not filled with more controls, and low-frequency commands do not receive primary-action styling.

## 2. Page archetypes

### 2.1 Queue/list page

Use for Tours, Properties, Applications, Residents, Services, Payments, Documents, Communication, and similar record collections.

Order:

1. page identity, supplied by the active persistent portal navigation or a visible page title;
2. adaptive command bar with one compact primary action and optional overflow;
3. active-filter chips, only when filters are active;
4. result summary or bulk-selection state;
5. records;
6. empty, loading, or error state in the record region.

For a top-level portal queue whose active left or mobile navigation already names
the section, do not pin a second visual title row above the records. Keep exactly
one semantic `h1` as visually hidden text and place the primary action at the end
of the command bar. Record details, deep-linked workflows, and pages without a
persistent navigation label retain a visible title.

### 2.2 Dense table page

Use when comparison across columns is the task. Navigation and commands may share one unboxed baseline, but keep the same action priority and responsive collapse rules as the default command bar.

### 2.3 Faceted queue

Use only when users repeatedly combine several persistent filters. A 240–280px local sidebar may remain visible from `lg`; below `lg`, the same fields move into the shared filter sheet. Do not add a local sidebar for a simple three-state queue.

### 2.4 Record detail

Show identity, status, and primary actions first. Expose no more than two visible navigation layers:

- portal navigation;
- one local detail navigation.

If the record needs deep anchors, integrate them into the local navigation or a section index; do not add a third full-width tab band.

### 2.5 Dashboard

Keep the always-on summary concise. Attention groups are collapsible and open by default only when they contain work. A heading or card trigger must never contain another link or button.

## 3. Layout and spacing

- Portal content follows the existing page gutter. A component cannot add a second competing outer gutter.
- Use the 4px spacing grid.
- Related controls use 8px gaps; distinct groups use 16–24px separation.
- Page title to command region: 16–24px on desktop, 8–12px on compact web.
- Command region to records: 12–16px.
- Cards use 12–16px radii. Pills are reserved for chips and compact state controls.
- Use a border or a shadow to establish a surface, not both unless an existing elevated overlay requires both.
- Dense record pages may use the available workspace width. Long prose remains within 65–75 characters.

## 4. Typography

- Page title: existing `PAGE_HEADER_TITLE_CLASS`; one `h1` per page.
- Section title: 16–18px, semibold, `-0.02em` minimum tracking.
- Body and control labels: 14–15px.
- Secondary metadata: 12–13px with AA contrast; never below 12px.
- Table headers: existing compact uppercase style, but labels must remain comprehensible without abbreviations.
- Counts and changing numeric data use tabular numerals.
- Never compress operational navigation below 12px; target 14px.

## 5. Action hierarchy

### Tier 1 — primary

- The action that advances the page's main workflow.
- At most one visibly primary action. On top-level portal queues it belongs at
  the end of the command bar; detail and standalone pages keep it in the page
  header.
- Use the primary button variant and an active verb: “Share tour”, “Add property”, “New message”.
- If no action is clearly primary, render no primary button.

### Tier 2 — secondary

- Frequent but non-advancing commands such as Filter, Export, or Edit.
- Use outline or quiet toolbar treatment.
- Limit header-visible secondary actions to two when space permits.

### Tier 3 — overflow

- Settings, download variants, import, archive, and other lower-frequency commands.
- Place in the shared Radix dropdown behind an icon button labelled “More actions”.
- Overflow priority must be deterministic and preserve the primary action.

### Destructive

- Text-danger or quiet danger treatment; never the default filled primary style.
- Separate from constructive actions in menus and action groups.
- Require confirmation when the result is difficult to recover.

### Selection actions

- Appear only after selection.
- Replace or sit directly above the ordinary list commands; do not produce a second competing toolbar.
- State the selected count unless the surrounding UI already communicates it unambiguously.

## 6. Buttons

### Geometry

- Operational buttons: 10–12px radius.
- Marketing CTAs may retain pills where established by the brand composition.
- Filter/status chips: full pill.
- Icon buttons: 10–12px radius with a 40px desktop and 44px touch target.

### Sizes

| Size | Height | Use |
| --- | ---: | --- |
| Compact | 36–40px | Desktop command bars and dense tables |
| Default | 44px | Forms, page actions, and touch-capable surfaces |
| Large | 48px | Authentication and major public CTAs only |

### States

Every button implements resting, hover, focus-visible, pressed, disabled, and loading states. Hover/press feedback should complete in approximately 100ms. Loading preserves the label, prevents double submission, exposes `aria-busy`, and does not change width.

### Copy

- Prefer verb + object.
- Avoid “Click here”, “Submit” without context, and icon-only controls without an accessible name.
- Disabled controls may remain visible when their future availability helps users understand the workflow.

## 7. Routed destinations and local tabs

### Routed destinations

- Render as semantic Next.js links with `aria-current="page"`.
- Default appearance: compact text labels, 44px touch targets, and a subtle active underline or low-chrome selected state.
- Counts may appear as small tabular badges when useful for queue comparison.
- Do not stretch two to four items across the entire page by default.

### Local tabs

- Use true tab semantics only when switching panels without navigation.
- Implement roving arrow-key navigation through the existing accessible primitives.
- Do not use `aria-current` as a substitute for `aria-selected` on a real tablist.

### Responsive behavior

- Four or fewer short destinations may scroll horizontally as text tabs.
- More than four destinations collapse into a labelled picker when the complete labels no longer fit.
- Labels never shrink to solve overflow.
- Preserve the current destination in the control label and the URL.

## 8. Adaptive command bar

The default list-page command region has three logical zones:

1. **Destinations:** current status or view links.
2. **Find and refine:** search and filter.
3. **Utilities:** sort, display, settings, and overflow.

Desktop:

- one visually contained surface or one divider-based baseline;
- destinations lead from the left;
- search is 224–320px where space permits;
- filter and utility controls follow search;
- the single primary action is last and uses the compact 40px command size;
- controls wrap only at a defined breakpoint, never one item at a time unpredictably.

Compact web:

- destination row first, horizontally scrollable or replaced by a picker;
- search and filter form the second row;
- search receives remaining width;
- utilities move to overflow before search becomes unusably narrow;
- the command area should normally occupy no more than approximately 104px before active chips.

The bar must not fetch data. It composes existing state and handlers so presentation changes do not increase Supabase egress.

## 9. Search

- `type="search"` with an explicit accessible label.
- Search icon is decorative and does not replace the label.
- Use concise placeholders: “Search tours”, “Search residents”.
- Search state that users may share or reload should move to URL search parameters during the relevant feature migration.
- Debounce remote search; local in-memory filtering may update immediately.
- Clearing search returns focus to the field and restores the unfiltered result summary.

## 10. Filters and sort

- “Filter” opens the existing anchored desktop dropdown and Vaul mobile sheet.
- Show an active-count badge or concise “N active” label only when non-default filters exist.
- Active filters render as removable chips below the command bar.
- Reset is available inside the filter surface and clears all draft/applied values consistently.
- Sort is a distinct control, not disguised as a status destination.
- Filter and sort state should be URL-addressable where returning to the exact queue state has user value.

## 11. Chips and badges

- Chips represent removable input or compact filters.
- Badges represent status, category, or a small count.
- Neither is a primary action.
- Use the existing shared status tones; do not invent per-page status colors.
- Badge text must remain legible at 200% zoom and never be color-only.

## 12. Lists and tables

### Desktop

- Tables are used when column comparison matters.
- Lists are used when identity and a short metadata stack matter more than comparison.
- Prefer one containing surface with hairline row dividers over individual nested cards.
- Column headers remain visible when the list body independently scrolls.
- Row hover may indicate clickability, but a keyboard-focusable link or button must expose the same detail action.

### Responsive web

- Convert tables to record rows/cards when columns cannot remain readable.
- Preserve identity, status, primary metadata, and next action.
- Secondary metadata may move into the detail view; it must not disappear if it is necessary to choose the right record.
- A selectable row uses sibling controls: checkbox, detail link/button, and overflow. Never put a checkbox or menu inside a row button.

### Selection

- Checkboxes have record-specific labels.
- Clicking the checkbox cannot also open the record.
- Select-all scope is explicit: visible page, current filter, or all results.

## 13. Menus, dialogs, sheets, and popovers

- Use existing Radix primitives for menus/dialogs and Vaul for mobile sheets.
- Escape closes; focus is trapped when appropriate and returns to the trigger.
- A modal is reserved for interruptive or focus-protected work, not ordinary navigation.
- Menus contain commands, not form-heavy workflows.
- Filter popovers may contain fields but must remain scrollable and viewport-bound.
- Overlays use the established overlay elevation; ordinary list surfaces remain flat.

## 14. Forms

- Every input has a programmatic label; placeholders are examples or hints, never labels.
- Use correct `type`, `inputMode`, and `autoComplete`.
- Validation is inline and specific, preserves user input, and explains recovery.
- Required state is communicated in text and semantics, not color alone.
- Save actions expose pending and success feedback. A failed save keeps the current form values.

## 15. Loading, empty, error, and success

### Loading

- Preserve title and command-bar context.
- Use row-shaped skeletons matching the final density.
- Set `aria-busy` on the affected region.
- Avoid a full blank canvas or a lone spinner for page-level data.

### Empty

Distinguish:

- **true empty:** no records exist; explain the next action;
- **filtered empty:** records may exist, but none match; offer Clear filters;
- **permission empty:** explain the missing access and who can grant it;
- **all caught up:** confirm that there is no outstanding work.

### Error

- Name what failed.
- Provide an inline recovery action.
- Preserve local inputs and existing successful data where safe.
- Log through the existing observability path; never expose raw errors.

### Success

- Update the record state in place or move to the logical next destination.
- Short operations may use a dismissible toast; consequential flows need a persistent confirmation and next step.

## 16. Accessibility contract

- WCAG 2.2 AA target.
- No critical or serious axe findings on migrated representative routes.
- One descriptive `h1` and a unique document title per page.
- Real links and buttons; no clickable `div` when a native element fits.
- Visible focus indicator with at least 3:1 contrast.
- Logical DOM and focus order match the visual order.
- 44px touch targets for primary mobile interactions; 40px minimum elsewhere.
- Body and small text meet 4.5:1 contrast; large text and meaningful graphics meet 3:1.
- Reduced motion removes nonessential motion.
- Scrollable regions are keyboard reachable and labelled where necessary.
- Status and validation are never color-only.

## 17. Motion

- Operational pages favor immediate state changes.
- Hover and press: approximately 100ms.
- Menus and popovers: 150ms.
- Dialogs and sheets: 200–250ms.
- Do not use `transition: all`.
- Do not replay list-entry animations after filtering or refetching.
- Respect `prefers-reduced-motion` with an instant fallback.

## 18. Analytics and observability

- Meaningful interactive elements receive one `data-attr="kebab-name"`.
- Do not hand-roll click events already covered by autocapture.
- Named events are reserved for established funnel/conversion actions and reuse existing event names.
- Event properties contain enums and identifiers only—never names, emails, addresses, free text, or secrets.
- A presentation-only refactor must not change agent tool behavior or bypass the existing tracing and confirmation architecture.

## 19. Responsive web versus native phase

The website phase must work at 375, 768, and 1280px and remains the code loaded by Capacitor. It includes ordinary responsive behavior and safe layout. Phase two will separately validate:

- native safe-area composition;
- virtual-keyboard and focused-field behavior;
- bottom-navigation and modal interaction inside the WebView;
- device back behavior;
- uploads, camera/photo permissions, push navigation, and deep links;
- iOS and Android device performance.

Do not fork the product UI into a separate native component tree.

## 20. Implementation governance

- New list pages use the adaptive command-bar contract rather than assembling independent tab/search/filter bands.
- Existing pages migrate by archetype, with Tours as the first reference implementation.
- A visual variant must represent a documented task difference (`compact`, `table`, `faceted`), not a page preference.
- Shared primitive changes require unit coverage and representative Playwright screenshots.
- Portal UI or route changes run platform parity tests and the mandatory ship gate.
- The implementation is complete only when loading, empty, error, success, disabled, selected, filtered, keyboard, and responsive states have been verified.
