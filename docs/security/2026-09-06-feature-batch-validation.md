# Feature batch validation — 2026-09-06

Base: main `8e0893359f0daa33acf3e416e50fe391e245d942`.
Release destination: main, then staging. Production promotion is outside this batch.
Account-deletion implementation and its migration files are unchanged.

## Scope

- Shared native assistant in dialogs; listing editor starts with assistant closed,
  reserves a spaced left workspace when opened, and restores on close.
- Open co-manager invite links with scoped redemption, paid-owner enforcement,
  inherited-plan reconciliation, and analytics URL token redaction.
- Manual expense edit/delete, scoped refresh caching, Pacific date grounding,
  and shared assistant confirmation refresh. Expense menus release modal locks.
- Browser locators updated to the current accessible UI contracts.

## Completed validation

- Unit: 1,197 suites / 8,044 tests passed before the final menu handoff fix;
  the additional real-Radix menu regression passed after that fix.
- Integration: 50 suites / 257 tests passed.
- Lint: zero errors (681 existing warnings).
- Production build, including TypeScript and page generation, passed with Node22
  and an 8GB heap. Final menu change also passed the production build.
- Production-mode smoke: 9/9; promotion desktop/mobile: 8/8.
- Authenticated listing wizard: assistant initially closed; measured no horizontal
  overflow at 1588, 1024, 768 and 390px. Desktop/tablet gap at least16px; phone
  assistant uses one pane and closing restores the editor. Existing listing used
  because test managers were at their property plan caps; no plan changes made.
- Authenticated expense creation and edit succeeded; manual browser testing found
  the menu/dialog lock bug and the subsequent regression covers its resolution.
- Separate security and assistant Bugbot reports accompany this record.

The local graph hook could not run because its graphify executable is unavailable.
No no-mistakes pipeline was used. Main/staging CI and deployment evidence is
recorded in the release handoff after pushing.

Final authenticated browser checks: expense edit/save releases the body pointer
lock and Delete can be opened immediately. Open invite mint, preview and cancel
returned200; preview after cancellation returned404. The new invite migration is
applied to dev and staging; the existing expiry prerequisite was missing in dev
and is now applied there. No production database changes were made.
