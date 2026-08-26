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

Shared query-first rules, wiki navigation, and multi-host install commands live in
`AGENTS.md` (**graphify** + **Multi-agent collaboration**). Follow those - do not
duplicate policy here when skills/plugins add their own instructions.

Claude Code also gets local PreToolUse hooks under `.claude/` (gitignored) from
`graphify claude install` (nudges toward the graph before search/read). Re-run that
install on a new machine. When the user types `/graphify`, use the installed
graphify skill before anything else.
