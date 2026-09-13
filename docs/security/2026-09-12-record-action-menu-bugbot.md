# Per-record action menu bugbot review — September 12, 2026

Reviewed `1164c1d47e1d5d3a0f2a901570006683dba833d4` plus the working diff. The approved revision replaces Select mode and floating bulk bars with each record’s trailing action menu. Review covers the context/menu primitives, checkbox adapter, DataList, shared surface, adaptive actions, existing consumer tests, and retained editor identity. Vendor and server authorization have separate reviews.

## Findings

- **High — opening the real lease editor causes competing focus traps.** The menu’s child button opens `PropertyLeaseFormModal` before Radix closes the menu. The isolated real lease-template UI test repeatedly raises `RangeError: Maximum call stack size exceeded` through focus events and does not complete. This also reproduced in the combined consumer run. The integration owner now synchronously closes the menu before invoking the existing action handler and suppresses competing close autofocus. A shared-Modal regression replaces the earlier plain-div editor test, which could not expose this problem. Both the real-Modal regression and the lease-template add/edit/delete evidence flow pass after the fix.
- **Medium — opening a menu also activates custom clickable rows.** The hidden adapter input’s programmatic click bubbled outside the menu wrapper; the adapter also dropped its input callback/ref contracts. The integration owner restored propagation stopping and forwarding. Behavioral regression passed after that fix.
- **Medium — actions inside custom wrappers were omitted from keyboard menu navigation.** `RecordActionItems` cannot introspect rendered function components. `PortalSectionActionRow` (used by inspections) and the local `LeasingDocumentsBulkBar` (application/lease documents) now render their buttons through `RecordActionItems` inside menu context. The section wrapper regression verifies arrow navigation, disabled-item skipping, Escape, and focus restoration. Adaptive actions retain all existing action nodes without a nested overflow menu.

Menu opening clears previous internal selection before activating one record. Opening another record dispatches only that record’s IDs. Workspace changes close menus and clear internal selection; filtering out a keyed record unmounts its menu. Closing a menu preserves the record required by its editor. Independent form checkboxes remain visible; grouped selection controls are absent from record lists.

## Validation

- Final combined targeted run: **11 suites, 74 tests passed, exit 0** (`/tmp/proplane-record-menu-final-targeted.log`). Suites: `portal-record-selection-mode`, `evidence-lease-template-ui`, `manager-property-lease-panel`, `manager-property-application-questions-panel`, `manager-property-room-move-in-panel`, `manager-task-list`, `manager-payments-ledger-panel`, `communication-segment-parity`, `unified-conversation-inbox`, `adaptive-action-row-measures-available-width`, and `manager-portal-primitives`.
- Menu suite now has 10 cases, covering one-record targeting, successive actions, filtering/workspace resets, separate form checkboxes, custom-row propagation/ref forwarding, ArrowDown/disabled items/Escape/trigger focus, real-Modal editor handoff, adaptive actions, and DataList desktop/mobile structure.
- Existing template editor tests retain visible checkbox selection inside editor forms. Real lease evidence drives template add, menu-based edit/delete, and re-sync without resurrecting the deleted template. Task tests assert the exact task ID passed to the update handler. Payment tests preserve actions across same-record reordering.
- Inbox tests cover initial source settling, combined email/SMS, read/unread/archived filtering, and no unintended mobile thread opening.
- Targeted ESLint: exit 0, zero errors, two pre-existing unused-variable warnings in `portal-section-action-row.tsx` (`/tmp/proplane-menu-review-lint.log`). Diff whitespace check passed.
- Initial consumer tests and the isolated real editor test exposed the focus loop; runaway workers were terminated. Those runs were failures, superseded by the successful final run after the fix.

No known unresolved High/Critical finding remains within this targeted menu review. Full compile/build/lint, full unit/E2E, and real-data browser release checks remain owned by the integration agent.

Pixel placement, mobile bottom-sheet behavior, and the production DOM’s focus transitions require the parent’s browser run. Class/DOM assertions are not a substitute for those checks. No database writes, seeding, role mutations, commits, or pushes were performed in this review.
