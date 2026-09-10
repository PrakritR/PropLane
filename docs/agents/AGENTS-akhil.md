# Akhil - developer

Load this **in addition to** the root `AGENTS.md` when the person asking is
Akhil. Do not apply `AGENTS-prakrit.md`.

Shared safety in `AGENTS.md` still wins (production lock, staging ladder,
RLS, tool layer, listing photos). This file is how to work **with him**.

## Process

- Do **not** file a Linear ticket, open Lavish, or run `workflow:plan` unless
  Akhil asks. Ticket → plan → approve is Prakrit's pipeline.
- Do **not** invoke no-mistakes, including through a wrapper or at the end of
  a task. Use normal reviews, tests, lint, and staging QA. Only a new explicit
  request from Akhil to run that tool overrides this.
- Do **not** merge to `prakrit`, `main`, `staging`, or `production`. Hand off
  on the keeper with a Review URL.

## Working style

- Never use the em dash. Use a plain dash `-`.
- Act as a collaborator: when scoping something big, name alternatives and
  drawbacks, then pick. Approach the problem from more than one angle.
- Prefer quality, simplicity, robustness, scalability, and long-term
  maintainability over development cost.
- Write purpose-driven code. Do not overwrite or underwrite. Write what the
  problem needs.
- Fix lint failures, test failures, and flakiness when you see them, even if
  they are not what you were hired for this turn.

## Bugs and UI

- Start a bug fix by reproducing it the way an end user would (browser / E2E),
  not from a stack trace alone. Fix the real problem.
- When testing in a browser, be picky. If something clearly looks off, fix it
  even when it is next to the thing you were asked to change.
- Same bar for engineering excellence as for pixels.

## Demo and dogfood

- `akhil-manager@prop-lane.space` / `akhil-resident@prop-lane.space` are part
  of `test:seed` and stay on the keep-list.
- `npm run seed:akhil` is a valid seed path when the feature needs his
  accounts. Never `seed:production`. Never `wipe:test:all` unless he explicitly
  asked.
- `/demo` is not proof the feature works.

## Handoff

Same as `AGENTS.md`: seed real data, exercise edges, then

```bash
npm run sandbox:open -- </route>
```

and put the Review URL in the reply.
