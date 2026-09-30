@AGENTS.md

# Claude / agent operating notes (Axis)

`CLAUDE.md` loads `AGENTS.md` as the source of truth for **every** agent host.
Developer-specific process:

- Prakrit: [`docs/agents/AGENTS-prakrit.md`](docs/agents/AGENTS-prakrit.md)
- Akhil: [`docs/agents/AGENTS-akhil.md`](docs/agents/AGENTS-akhil.md)

Claude-specific extras live here. Skills, plugins, and MCP servers are additive
only - they never override `AGENTS.md` (see **Multi-agent collaboration** there).

## Every prompt becomes a studio lane plan (mandatory for Prakrit)

**Captain's standing order: plan first, in the studio, every time.** When
Prakrit describes work — a bug, an idea, a screenshot, one line in chat — sync
the lane with `prakrit`, then write or update that lane's plan in the PropLane
studio (`~/proplane-mock-kit`) **before** writing product code. No Linear
ticket is filed for it; the plan is the artifact. He iterates on it there, then
approves it in the studio or types **`build`** in the lane's own pane.

```bash
node ~/proplane-mock-kit/tools/studio-plan.mjs new --lane <lane> --id <id> --title "<title>"  # scaffold
node ~/proplane-mock-kit/tools/studio-inbox.mjs --lane <lane> --wait                            # FIRST thing every later turn
node ~/proplane-mock-kit/tools/studio-plan.mjs status --lane <lane>                              # exits 0 once buildable
```

The bar, in full: [`docs/agents/lavish-plan-standard.md`](docs/agents/lavish-plan-standard.md).
Short version:

- **Show the UI, do not describe it** — mock the screen in PropLane's own tokens,
  before/after, desktop/mobile, plus empty / loading / error states.
- **Semi-interactive** — tabs, toggles, editable sections, and decision forms
  that queue his answer back through the studio.
- **Exact** — the Build tab's file list is what the implementation touches.
  Departing from the plan means updating the plan, not quietly building
  something else.
- **Never end a turn with a plan open and no watcher running**, or his
  annotations are lost.

Skip only on an explicit **`skip plan`** (hotfix). For Akhil, skip unless he asks.

For Prakrit this is the whole pipeline, not a formatting preference: the plan is
the spec, it renders real semi-interactive UI in this app's design system, he
iterates on it over several rounds in the studio, and code is written only after
it is approved or he says build. Once built, `npm run gate:prompt` runs and the
lane's port stays up for review; code reaches `prakrit` only through the
captain typing `/promote prakrit`. The watcher must stay live the entire time
his plan is open or his chat and annotations never arrive. Full contract -
including that Linear ticket filing is off by default - is
[`docs/agents/AGENTS-prakrit.md`](docs/agents/AGENTS-prakrit.md) § Default
pipeline and § Studio watch.

## Ship gate (mandatory)

Before finishing features or promoting to production, follow
[`docs/ship-gate.md`](docs/ship-gate.md) and `.cursor/rules/ship-and-review-gate.mdc`:

1. **Reviews** - security-review + bugbot (+ cache/rendering/perf for UI/routes)
2. **In-depth feature test** - full happy path + edge cases every time (not `/demo` alone)
3. **Promote** - ff-only `main` → `staging` (developers already verified `main`), then after QA sign-off ff-only `staging` → `production`. Never promote `main` straight to `production`.
4. **Confirm** - Vercel production deploy **and** GitHub **iOS TestFlight** workflow

```
npm run ship:staging      # main → staging (QA)
npm run ship:production   # staging → production (live + TestFlight)
```

Run `npm run ship:preflight` before the production promote. The ladder, databases,
and CI map live in `AGENTS.md` § Branching & deployment.

For step 1, the Trail of Bits plugins (`trailofbits` marketplace, user scope) add
`/diff-review` (adversarial security review of the branch diff) and `/audit`
(insecure-defaults: parallel hunt for fail-open defaults, one refuting verifier per
file). They are additive options alongside the existing reviews, never a replacement -
`AGENTS.md` § Multi-agent collaboration still wins.

## Production = web + mobile

Pushing `production` deploys the site on Vercel **and** runs
`.github/workflows/ios-testflight.yml`. An upload is not a ship - that workflow's
distribute step is what proves the build is installable
([`docs/mobile-app.md`](docs/mobile-app.md#the-distribute-step-is-what-makes-a-build-installable)).
Do not treat a web-only deploy as complete.

## graphify

This project has a graphify knowledge graph at .graphify/.

Rules:
- For codebase or architecture questions, when `.graphify/graph.json` exists, first run `graphify query "<question>"` (or `graphify path "<A>" "<B>"` / `graphify explain "<concept>"`); these return a scoped subgraph, usually much smaller than `GRAPH_REPORT.md` or raw grep output
- If .graphify/wiki/index.md exists, navigate it instead of reading raw files
- If .graphify/graph.json is missing but graphify-out/graph.json exists, run `graphify migrate-state --dry-run` first; if tracked legacy artifacts are reported, ask before using the recommended `git mv -f graphify-out .graphify` and commit message
- If .graphify/needs_update exists or .graphify/branch.json has stale=true, warn before relying on semantic results and run /graphify . --update when appropriate
- Before proposing or committing .graphify artifacts, run `graphify portable-check .graphify`; commit-safe graph artifacts must use repo-relative paths, and never commit .graphify/branch.json, .graphify/worktree.json, .graphify/needs_update, or .graphify/cache/. If a repo already tracks any of them, first add them to .gitignore, then propose `git rm --cached .graphify/branch.json .graphify/worktree.json .graphify/needs_update` and `git rm -r --cached .graphify/cache`; never mutate git state without asking
- Before deep graph traversal, prefer `graphify summary --graph .graphify/graph.json` for compact first-hop orientation
- For review impact on changed files, use `graphify review-delta --graph .graphify/graph.json` instead of generic traversal
- Read `.graphify/GRAPH_REPORT.md` only for broad architecture review or when `query` / `path` / `explain` do not surface enough context
- After modifying code files in this session, run `npx graphify hook-rebuild` to keep the graph current
