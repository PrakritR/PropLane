@AGENTS.md

# Claude / agent operating notes (Axis)

`CLAUDE.md` loads `AGENTS.md` as the source of truth for **every** agent host.
Claude-specific extras live here. Skills, plugins, and MCP servers are additive
only - they never override `AGENTS.md` (see **Multi-agent collaboration** there).

## Always open plans visually (Lavish)

Whenever you write a plan (plan mode or any multi-step proposal), do **not** leave
it as a bare markdown file the user can't see. Render it as a viewable **Lavish**
artifact (`lavish-axi <html>`) so the user can read it in a good UI - and when the
plan involves UI/design work, show the actual mockups/options in that Lavish board
so the user can review and choose. Open the Lavish view before asking for approval.
(Plan mode blocks non-read-only tools, so if you must stay in plan mode, say so and
open the Lavish view immediately after exiting.)

## Ship gate (mandatory)

Before finishing features or promoting to production, follow
[`docs/ship-gate.md`](docs/ship-gate.md) and `.cursor/rules/ship-and-review-gate.mdc`:

1. **Reviews** - security-review + bugbot (+ cache/rendering/perf for UI/routes)
2. **In-depth feature test** - full happy path + edge cases every time (not `/demo` alone)
3. **Promote** - ff-only `main` → `production` push (`production` is the production branch; `main` is dev)
4. **Confirm** - Vercel production deploy **and** GitHub **iOS TestFlight** workflow

Run `npm run ship:preflight` before promote.

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
