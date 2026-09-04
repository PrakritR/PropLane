> **OPEN FINDINGS — not archived, not yet fixed.** Tracked as PRP-184.
> None of the items below are marked done, and several are real accessibility
> defects (19 colour-contrast failures across home + sign-in, nested interactive
> controls, an admin route that soft-404s with HTTP 200). This is a work list,
> not a description of the current UI. Standing UI rules live in
> [`agents/ui-change-checklist.md`](agents/ui-change-checklist.md).

# Website UI Audit — August 2026

Status: Complete discovery baseline for the website redesign. Capacitor/native-shell optimization is intentionally deferred to phase two.

## Executive summary

PropLane has a coherent Blue Steel identity and a substantial shared portal component layer, but the current list-page composition repeatedly gives navigation, filters, search, settings, and primary actions equal visual weight. The result is a stack of large rounded bands before users reach the records they came to manage.

This is a system-level hierarchy problem rather than a one-page styling problem. The main sources are `DestinationNav`, `PortalListControlStack`, full-width segmented layouts, and the global pill-shaped `Button` default. Correcting those primitives and defining explicit action priority will improve manager, resident, vendor, and admin surfaces together.

The audit covered public, authentication, manager, resident, vendor, and admin routes at desktop and representative responsive widths. Evidence is stored under [`output/design-audit`](../output/design-audit/).

## Audit scope

- Manager: 20 primary destinations; workflow status tabs; finance and document destinations; property, application, and resident detail sections.
- Resident: dashboard, tours, applications, lease, services, payments, communication, move-in, documents, and profile.
- Vendor: all registered primary sections and their tab states.
- Admin: account, property, event, feedback, profile, and communication states.
- Public and authentication: marketing, renter, legal, support, sign-in, registration, onboarding, and OAuth transition pages.
- Responsive: representative manager, resident, vendor, admin, public, and authentication views at 390 × 844 CSS pixels.
- Automated checks: representative axe-core scans, browser console review, production build, and Impeccable deterministic frontend detection.

## Health score

| Dimension | Score | Evidence |
| --- | ---: | --- |
| Accessibility | 2 / 4 | Serious nested-interactive, unnamed command, contrast, and unfocusable scroll-region failures on representative pages. |
| Responsive behavior | 2 / 4 | No document-level horizontal overflow in sampled routes, but navigation labels shrink excessively and stacked chrome consumes much of the first viewport. |
| Theming and consistency | 3 / 4 | Strong token and brand foundation; inconsistent composition and action priority produce repeated visual drift. |
| Performance | 3 / 4 | Production build succeeds and portal surfaces are generally stable; loading presentation and unused CSS preload warnings need attention. |
| Implementation integrity | 3 / 4 | Shared primitives exist and are widely reused; a few primitives encode the wrong behavior at system scale. |
| **Total** | **13 / 20** | **Acceptable foundation with significant cross-cutting redesign work required.** |

## Priority findings

### P1 — accessibility and task completion

1. **Nested interactive controls occur on high-frequency pages.** Tours and resident dashboards contain clickable parents with interactive descendants. Property detail shows the same pattern in room/bathroom controls. This creates invalid focus and activation behavior for keyboard and assistive-technology users.

2. **Public and authentication contrast is below the target.** The sampled public home page produced 14 color-contrast failures; sign-in produced five. Decorative Blue Steel layers cannot substitute for the required legibility wash at the final rendered state.

3. **Responsive navigation becomes too small to scan.** `DestinationNav` can reduce labels to approximately 8px in dense equal-row mode. The document fits the viewport, but avoiding overflow by shrinking operational labels transfers the failure to readability and tap confidence.

4. **Some scrollable regions are not keyboard-focusable.** Representative public and detail pages expose scroll regions without an accessible keyboard entry point.

### P2 — systemic hierarchy and information architecture

5. **List-page chrome dominates the records.** The recurring sequence—page title actions, full-width destination band, search band, filter band, then records—makes every control look primary and delays the content.

6. **Header actions lack priority.** The Applications header exposes Filter, Edit, Send, Settings, Screening, and Add as peers. Similar patterns appear on Tours and Properties. One primary action, a small number of contextual secondary actions, and an overflow menu should replace equal-weight action rows.

7. **Routed status navigation is visually oversized.** Pending/Upcoming/Past and Drafts/Listed/Unlisted are information destinations, but they render like three large call-to-action zones. Routed navigation should use compact text tabs or an adaptive picker, not giant filled-width buttons.

8. **Detail pages accumulate navigation layers.** Property detail can show primary portal navigation, property detail tabs, and an anchor navigation at the same time. On mobile, those layers can occupy roughly the first 220px before content begins.

9. **Long detail records need progressive disclosure.** The resident detail view is a long uninterrupted data stream with many groups and a separate action area. It needs a stable section model, concise summaries, and disclosure of secondary detail without hiding core facts.

10. **Loading states do not preserve useful structure.** Finance and other data-heavy destinations can render a visually blank waiting area. Skeletons should preserve the title, controls, column rhythm, and expected row density.

11. **Admin communication routing can soft-404.** `/admin/communication/schedule` used to render a not-found experience with HTTP 200 while `/admin/communication/inbox/schedule` is canonical. Fixed 2026-09-04: flat inbox tab segments redirect to `/admin/communication/inbox/{tab}`; admin sidebar prefetch hrefs use the inbox prefix.

### P3 — polish and motion

12. **Pill geometry is overused.** Pill buttons are appropriate for compact filters, status chips, and a small number of friendly calls to action; they are not the default geometry for every operational command.

13. **Assistant thinking indicators use bounce motion.** This is low severity but should be verified against reduced-motion behavior and the calmer operational motion standard.

## Representative automated evidence

| Surface | Findings |
| --- | --- |
| Manager Tours | `nested-interactive` — serious, 6 nodes |
| Property detail | `aria-command-name` — serious, 1 node; `nested-interactive` — serious, 3 nodes |
| Resident detail | `heading-order` — moderate, 1 node; `scrollable-region-focusable` — serious, 1 node |
| Resident dashboard | `nested-interactive` — serious, 7 nodes |
| Admin inbox | No axe violations in the representative scan |
| Public home | `aria-prohibited-attr` — serious, 4; `color-contrast` — serious, 14; two additional region/landmark findings; `scrollable-region-focusable` — serious, 2 |
| Sign-in | `color-contrast` — serious, 5; missing H1 and region findings |

Automated findings are leads, not substitutes for manual review. Each should be reproduced against the implementing component before a fix is merged.

## What is already working

- The Blue Steel token system gives the redesign a strong identity foundation.
- Portal page, table, badge, empty-state, and collapsible-section primitives already exist.
- Representative responsive pages had `scrollWidth === clientWidth`; the redesign should preserve this no-overflow baseline.
- Existing controls generally preserve a 44px minimum interaction target.
- Admin inbox is a strong shared-table reference and passed the representative axe scan.
- The production build succeeds on Next.js 16.2.9.
- Existing Radix, Lucide, and Vaul dependencies cover the required accessible menus, dialogs, and mobile filter sheets.

## Shared-component diagnosis

| Component or pattern | Current behavior | Redesign responsibility |
| --- | --- | --- |
| `DestinationNav` | Equal-width stretching for small sets; dense labels can shrink excessively | Provide compact routed tabs, count treatment, overflow/picker behavior, and a readable mobile representation |
| `PortalListControlStack` | Stacks destination, find, and chip bands vertically | Compose a single adaptive command area with explicit slots and wrapping rules |
| `Button` | `rounded-full` is the global default | Define geometry by intent; primary and secondary operational buttons use controlled radii while chips remain pills |
| Page title actions | Multiple peer buttons | Enforce primary, secondary, overflow, and selection-action tiers |
| List records | Repeated rounded containers and nested surfaces | Prefer one containing surface, hairline rows, clear columns, and responsive record cards only where tables no longer fit |
| Detail navigation | Multiple simultaneous destination systems | Limit visible navigation layers and convert deep anchors to a local section control |

## Dependency research and decision

No new UI framework is required for the first redesign wave.

- Radix already provides accessible focus and keyboard behavior for menus and dialogs, so its existing `DropdownMenu` can support adaptive action overflow. [Radix accessibility overview](https://www.radix-ui.com/primitives/docs/overview/accessibility)
- Routed page destinations should remain links. Where true in-page tab semantics are used, the implementation should follow the WAI-ARIA Tabs pattern and keyboard model. [WAI-ARIA Tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)
- Action collections can borrow the WAI-ARIA toolbar grouping model, but the visual design should still expose one primary action and move low-frequency commands into overflow. [WAI-ARIA Toolbar example](https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/examples/toolbar/)
- React Spectrum's responsive Tabs behavior—collapsing overflow into a picker—is a useful interaction reference. It does not justify adding React Aria alongside Radix for this project. [React Spectrum Tabs](https://react-spectrum.adobe.com/Tabs)
- TanStack Table could help future server/client filtering state and faceting, but it is headless and would create a large migration without correcting the current visual hierarchy by itself. Defer it until a specific data-grid requirement appears. [TanStack global filtering guide](https://tanstack.com/table/latest/docs/guide/global-filtering)

## Redesign waves

1. **Foundations:** action priority, button geometry, focus and contrast fixes, compact routed navigation, adaptive command bar, and loading/empty/error contracts.
2. **High-frequency list archetypes:** Tours, Properties, Applications, Residents, Services, Payments, Documents, and Communication.
3. **Detail and dashboard archetypes:** property and resident details, manager/resident dashboards, and progressive disclosure.
4. **Role rollout:** resident, vendor, and admin conformance using the same primitives with role-appropriate density.
5. **Public and authentication polish:** contrast, landmarks, headings, and form hierarchy while retaining marquee brand expression.
6. **Capacitor phase:** WebView-safe responsive refinement, safe areas, virtual-keyboard behavior, native navigation ergonomics, upload/camera flows, and device verification.

## Acceptance criteria for the website phase

- One visually dominant action at most in a page header.
- No operational routed navigation label below 12px; target 14px for normal labels.
- No nested interactive violations in portal list, dashboard, or detail archetypes.
- Representative redesigned routes pass axe with no critical or serious violations.
- Keyboard focus order matches visual order and every scroll region is reachable.
- Text and essential controls meet WCAG 2.2 AA contrast.
- 390px layouts show content context within the first viewport and have no document-level horizontal overflow.
- Loading, empty, error, disabled, selected, filtered, and bulk-action states are documented and tested.
- No new data fetches are introduced solely for presentation.
- Existing analytics, tool-layer behavior, role scoping, and web/native route parity remain intact.

## Implementation progress

The first shared-component rollout is complete for manager Tours, Properties,
Applications, and Residents:

- routed status destinations use the compact command appearance with readable
  labels and queue counts;
- search, filter, and utility actions share one adaptive command surface;
- page headers expose one primary action instead of a row of peer actions;
- top-level queue pages no longer pin a redundant visual title when the active
  portal navigation already names the section; their semantic `h1` remains in
  the document and their compact primary action moves into the command strip;
- repeated bottom-of-list Add controls were removed from Applications and
  Residents;
- compact empty states preserve context without adding another oversized action;
- selectable and actionable mobile list rows now use sibling controls instead of
  nesting checkboxes, menus, or actions inside a row button.

Playwright evidence is stored in
[`output/design-audit/redesign-wave-1`](../output/design-audit/redesign-wave-1/).
At 390px, the sampled command strips have no document-level horizontal overflow.
The redesigned Tours sample has no axe violations. The redesigned Residents
sample has one remaining WCAG 2.2 target-size finding on the portal-wide native
bottom-navigation pull handle; it is outside the queue command surface and should
be fixed in the later role-shell accessibility pass.
