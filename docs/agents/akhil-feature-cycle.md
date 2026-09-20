# Akhil feature cycle

Use this workflow for features, bugs, and meaningful refactors. It supplements
the repository gates in `AGENTS.md` and the relevant area pre-read. Those rules
still control safety, validation, branching, and handoff.

The cycle has three isolated agent sessions with durable handoffs. The initial
Astra session orchestrates the complete cycle automatically when collaboration
tools are available. Akhil should not need to open sessions or paste prompts.

1. **Plan - GPT-6 Astra.** Investigate the product behavior and repository,
   reproduce bugs from the user surface, identify affected contracts, and write
   an implementation-ready plan. Include scope, exclusions, decisions, files or
   systems likely to change, data and migration concerns, observability,
   acceptance criteria, edge cases, and a risk-based test matrix. Save the plan
   under `docs/plans/` with a clear task name. Record the current branch and HEAD
   so the next session can detect drift. Do not implement the plan in this
   session. Then launch the execution session automatically.

2. **Execute - GPT-5.6 Sol at medium reasoning.** Astra launches a fresh-context
   Sol subagent with the plan path, repository path, branch and HEAD, acceptance
   criteria, constraints, and instruction to complete the execution phase. Sol
   reads all repository instructions, confirms the plan still fits the current
   tree, and acts as implementation manager. Sol owns integration, architectural
   decisions, conflict resolution, verification, and the final state. Sol
   delegates the planned implementation and test work to GPT-5.6 Terra and
   GPT-5.6 Luna, then concentrates on management, integration, and verification.
   Prefer Terra for substantial implementation, debugging, and test design.
   Prefer Luna for focused inventory, mechanical changes, fixtures, and narrow
   verification. When the work cannot safely split into two write scopes, assign
   one model the implementation and the other an independent read-only review or
   test task. Give every delegate explicit file ownership and acceptance
   criteria; avoid overlapping writes. Sol must inspect and integrate every
   delegate result rather than accepting summaries, and may make integration
   fixes when needed. Sol returns its handoff artifact to the orchestrating
   Astra session. If the plan has a material flaw, Sol returns a planning blocker
   instead of improvising a different architecture.

3. **Review - GPT-6 Astra.** After Sol returns, the orchestrating Astra launches
   a fresh-context Astra reviewer with the plan path, execution handoff, branch,
   and diff scope. The reviewer independently assesses correctness, security,
   maintainability, UX, regression risk, and compliance with repository
   contracts. It verifies that acceptance criteria and the test matrix are
   satisfied with real command results and, for user-facing work, real
   seeded-data browser evidence. It records findings by severity with file and
   line references. If changes are needed, it updates or adds a correction plan
   under `docs/plans/`; the orchestrator automatically launches a new Sol-medium
   execution session for that plan and then a new Astra review. Run at most two
   automated correction cycles, then report any remaining findings to Akhil.
   If the work is sound, follow the normal keeper and Review URL handoff.

## Testing standard

Testing is part of the design, implementation, and review, not a final add-on.

- The Astra plan maps each acceptance criterion and meaningful failure mode to
  the best validation layer: unit, integration, route or contract, browser/E2E,
  typecheck, lint, build, migration probe, or staging QA.
- Sol assigns test ownership with implementation ownership and requires tests
  that exercise observable behavior, authorization boundaries, state changes,
  error paths, and regressions. Avoid tests that only mirror implementation or
  match source text when behavioral coverage is feasible.
- Run the narrowest relevant checks while developing, then the repository's
  required broader checks once the integrated change is stable. Report exact
  commands and exit codes. Do not hide failures with pipes or partial output.
- UI and end-to-end changes require seeded non-production data and browser
  exercise of the main path plus relevant empty, loading, error, permission,
  mobile, and repeat-action edges. `/demo` is not proof.
- Fix test failures and flakiness encountered in scope. Never use no-mistakes
  unless Akhil explicitly requests it.

## Handoff artifact

Each session leaves enough evidence for a new session with no chat history:

- task goal and current plan path;
- branch, starting HEAD, and current HEAD;
- decisions and assumptions;
- changed files and migrations;
- tests added or changed;
- commands run with exit codes;
- browser routes, seeded accounts or fixtures, and edges exercised;
- unresolved risks, blockers, and the exact next-session prompt.

Do not claim a phase is complete when its handoff artifact is missing. Use
fresh-context subagents rather than copying the parent conversation into them.
If collaboration tools are unavailable, fall back to ready-to-paste prompts for
manual sessions. A model being unavailable is a visible deviation: tell Akhil
and wait for direction instead of silently substituting another model.
