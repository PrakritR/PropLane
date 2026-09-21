# Akhil - developer

Load this **in addition to** the root `AGENTS.md` when the person asking is
Akhil. Do not apply `AGENTS-prakrit.md`.

Shared safety in `AGENTS.md` still wins (production-change authorization, staging ladder,
RLS, tool layer, listing photos). This file is how to work **with him**.

## Process

- Temporary Akhil-authorized staging-QA exception: from 2026-09-16T21:08:02Z
  until 2026-09-23T21:08:02Z, staging QA is not required for his explicitly
  authorized releases. Keep keeper → main → staging → production and all other
  gates, including local/browser tests, independent review, migration backups,
  preflight and deployment verification. This does not renew the expired
  direct-main-to-production exception. After expiry, staging QA is mandatory
  again. Human-readable scope: `../plans/staging-qa-exception-20260916.html`.

- Do **not** file a Linear ticket, open Lavish, or run `workflow:plan` unless
  Akhil asks. Ticket → plan → approve is Prakrit's pipeline.
- Do **not** invoke no-mistakes, including through a wrapper or at the end of
  a task. Use normal reviews, tests, lint, and staging QA. Only a new explicit
  request from Akhil to run that tool overrides this.
- Absent an explicit Akhil ship request, hand off on the keeper with a Review URL.
  With that request, agents working for Akhil may promote only his keeper →
  `main` → `staging` → `production` under the shared staging, review,
  fast-forward, and production-safety gates. They do not write `prakrit`.
- Akhil's dated staging exception is defined only by
  [the temporary direct-production policy](temporary-direct-production-policy.json).
  It expires at 2026-09-15T04:00:00Z and does not relax review, preflight,
  fast-forward, production database, deployment, or TestFlight verification gates.

## Working style

- Never use the em dash. Use a plain dash `-`.
- Run localhost servers only during active testing or review. Stop task-owned
  servers when active use ends, including before handoff; a Review URL is not
  a reason to leave one running. Verify process ownership before stopping it.
- Designate exactly one heavy-validation owner. Delegates run focused checks
  only unless that slot is explicitly transferred; never duplicate a
  whole-project typecheck, build, or broad test suite in the same worktree.
  After interruption, verify child processes exited instead of leaving Node workers.
- Treat laptop memory and disk headroom as a prerequisite for expensive work.
  Other agents may be running outside this task. Before starting a build,
  whole-project typecheck, broad test suite, browser, development server, or
  large dependency/cache operation, inspect current memory pressure, process
  memory use, and free disk space. Proceed only when usage is low enough to
  leave comfortable headroom for other work; never assume an idle task means
  an idle machine. If headroom is uncertain or pressure is elevated, defer
  heavy work and continue lightweight work instead.
- Reuse valid validation evidence, bound test workers, and avoid concurrent
  heavy commands across agents and worktrees. Do not raise heap limits to
  consume most of the laptop's RAM. Monitor expensive commands and stop only
  verified task-owned processes if pressure rises. Close task browsers and
  servers promptly, avoid duplicate dependencies/build caches, and never
  delete another task's files or stop its processes to free resources.
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

Documents Akhil needs to review (findings, plans, reports, and handoffs) must be
simple, self-contained HTML files, not Markdown-only deliverables. Always give
the full absolute file path, preferably as a clickable link. Internal Markdown
instructions may remain Markdown; provide HTML for human review.

Same as `AGENTS.md`: seed real data, exercise edges, then

```bash
npm run sandbox:open -- </route>
```

and put the Review URL in the reply.
