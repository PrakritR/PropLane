# UI mock kit (captain's plans)

For any plan that shows UI, start from the **whole-product mock kit**, not a hand-drawn mock.
It is a clickable copy of the manager, resident and vendor portals, the public site and every
settings page, with mock data, a scenario bar (who is looking, workspace, Before/After,
desktop/phone), fake Stripe test cards, and a review panel per page.

- Location: `~/proplane-mock-kit/` (outside every worktree, so lane resets can't remove it).
  `README.md` there explains how to load it into a Lavish plan. `proto/SPEC.md` is the
  contract and holds the captain's accuracy rules.
- Before = today's screen, copied from the real-app screenshots in `real/`. After = the
  proposal, with the **same features** and nothing invented; other ideas go in the review
  panel as questions.
- Check it with `node proto/check.mjs` (0 errors, real tab parity) before showing it.
- When the real UI changes, refresh `real/` with `tools/` and update the affected
  `before()` renders.

Origin: PLAN-0924-1802 (Sep 2026). Plan rules: [`lavish-plan-standard.md`](lavish-plan-standard.md).
