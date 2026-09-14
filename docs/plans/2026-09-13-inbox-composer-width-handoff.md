# Inbox composer narrow-phone correction handoff

## Goal and plan

- Goal: restore a readable direct-pane reply textarea at a 375px viewport while preserving every composer action and the existing `> 140px` E2E requirement.
- Plan: `docs/plans/2026-09-13-inbox-composer-width-plan.md`.
- Keeper: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2` on `akhil/prp-472-inbox-unread`.
- Starting and current Git HEAD were not queried because this execution phase was explicitly prohibited from Git actions. The frozen implementation file SHA-256 is recorded below after the final root-authorized breakpoint correction.

## Decisions and implementation

- Changed only `src/components/portal/portal-inbox-ui.tsx`.
- On widths below `sm`, the trailing-controls composer row now uses a 4px gap instead of 6px. Three outer gaps recover 6px.
- On widths below `sm`, the three-tool group now uses a 0px gap instead of 4px. Two inner gaps recover 8px.
- The measured 129px textarea therefore recovers exactly 14px to an expected 143px.
- The `sm` through 767px layout retains the prior 6px outer and 4px tool gaps. `md` and larger retain the prior 8px outer gap and 6px tool gap.
- Composer structure, control dimensions, no-wrap behavior, safe-area padding, phone emoji hiding, send behavior, analytics attributes, authorization, and props are unchanged.
- No unit test was added. The existing E2E exercises real geometry and behavior; a class-string assertion would only mirror implementation.

## Delegate review

- Terra independently verified the width arithmetic and recommended the `max-sm` refinement so 640px and wider layouts keep their prior spacing.
- Luna independently confirmed that `tests/e2e/communication-reply-composer.spec.ts` is the meaningful regression layer. It already checks textarea width, attachment and Send sizes, focus, emoji behavior, scheduling, and target viewports.

## Validation performed here

- Frozen `src/components/portal/portal-inbox-ui.tsx` SHA-256: `3f6304856dfd80e00f51598b5c27960182ef4a58d88e6c3e153e21f39f68f356`.

- `PATH="/opt/homebrew/Cellar/node@22/22.23.0/bin:$PATH" npx eslint src/components/portal/portal-inbox-ui.tsx`
  - Exit code 0.
  - 0 errors and 12 existing warnings outside the changed lines.
- No browser, server, database, provider, unit-suite, build, or Git action was run in this execution phase, per the root-owner boundary.

## Root-owned validation still required

- Run the existing `communication-reply-composer.spec.ts` against seeded dev/test data at 375px, 768px, and 1280px.
- At 375px, verify textarea width is greater than 140px, attachment is at least 36px, Send is at least 40px, all three tools remain distinct and clickable, emoji is hidden, and the row does not overflow.
- At 768px and 1280px, verify spacing and emoji behavior remain unchanged.
- Complete the root-owned 12-case portal/composer/mobile suite, screenshots, unit suite, lint, and build.
- Existing unrelated portal-vendors integration mock failures reported by the root owner are outside this source change.

## Unresolved risk

- Zero space between adjacent phone tool hit boxes increases visual density. The controls retain their full size and individual styling, so the root browser screenshot and click sweep are the final evidence that their boundaries remain clear.

## Exact next-session prompt

Review `docs/plans/2026-09-13-inbox-composer-width-plan.md`, this handoff, and the exact diff limited to `src/components/portal/portal-inbox-ui.tsx` plus this handoff. Verify the frozen source SHA-256, assess correctness and UX against repository contracts, and use the root-owned unit, build, and real seeded-data browser evidence. Record findings by severity with file and line references. Do not weaken the `> 140px` assertion or modify unrelated pending E2E/docs.
