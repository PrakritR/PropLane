@AGENTS.md

# Claude / agent operating notes (Axis)

`CLAUDE.md` loads `AGENTS.md` as the source of truth for **every** agent host.
Developer-specific process:

- Prakrit: [`docs/agents/AGENTS-prakrit.md`](docs/agents/AGENTS-prakrit.md)
- Akhil: [`docs/agents/AGENTS-akhil.md`](docs/agents/AGENTS-akhil.md)

Claude-specific extras live here. Skills, plugins, and MCP servers are additive
only - they never override `AGENTS.md` (see **Multi-agent collaboration** there).

## Prakrit workflow

Follow [AGENTS-prakrit.md](docs/agents/AGENTS-prakrit.md): implement and validate
on the assigned standing lane, push that lane, and hand off the real Review URL.
Only the captain's own `/promote` keyword advances protected branches, in order:
`prakrit` → `main` → `staging` → `production`. No separate visual plan or watcher
is required; Linear tickets remain explicit-request only.

## Ship gate (mandatory)

Before finishing features or promoting to production, follow
[`docs/ship-gate.md`](docs/ship-gate.md) and `.cursor/rules/ship-and-review-gate.mdc`:

1. **Reviews** - security-review + bugbot (+ cache/rendering/perf for UI/routes)
2. **In-depth feature test** - full happy path + edge cases every time (not `/demo` alone)
3. **Promote** - ff-only `main` → `staging` (developers already verified `main`), then after QA sign-off ff-only `staging` → `production`. Only Akhil's explicitly authorized [standing exception](docs/agents/temporary-direct-production-policy.json) may skip staging; Prakrit uses the captain-only ladder.
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

## Optional code navigation

Read the relevant feature contract, then use `rg` or a current Graphify index
when useful. A stale index is not source evidence. Do not auto-rebuild or commit
local graph caches as part of ordinary work.
