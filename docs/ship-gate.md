# Ship gate — web + iOS + reviews + feature testing

Use this checklist whenever promoting `main` → `production`, or when finishing a
substantial feature. Agents must follow it (see `AGENTS.md` and
`.cursor/rules/ship-and-review-gate.mdc`).

> **The ladder is `main` → `production`.** `prakrit` was retired when the
> Production Branch flipped on Jul 25, 2026; do not merge new work into it. Any
> `bin/fm-proplane-promote-prakrit-*` script is kept only for historical
> reference.

## Why

- **Web (live)** deploys from Vercel on every push to **`production`** only.
- **`main`** builds **Preview** deployments (staging). Non-`main` / non-`production`
  pushes are skipped via the Vercel Ignored Build Step plus `vercel.json`.
- **iOS** builds, uploads **and distributes** to the internal TestFlight tester
  group from GitHub Actions on push to **`production`**
  (`.github/workflows/ios-testflight.yml`), keeping the Capacitor shell aligned
  with the repo while the WebView loads the live site. An upload alone is not a
  ship — see [`docs/mobile-app.md`](mobile-app.md#the-distribute-step-is-what-makes-a-build-installable).
- Reviews and full feature testing catch auth, cache, and edge regressions that
  unit tests miss.

## Preflight

```bash
npm run ship:preflight
```

Checks:

- On a clean promote path (or warns about dirty tree)
- `ios-testflight.yml` present and triggers on `production`
- Capacitor prod URL guard script present
- Reminds about App Store Connect secrets

## Reviews

Run before merge/promote (parallel OK):

1. **Security review** — `security-review` subagent, branch changes
2. **Bugbot** — `bugbot` subagent, branch changes
3. **Cache / rendering / performance** — Next.js caching, RSC vs client,
   bundle size, list rendering, images/fonts; fix obvious regressions
4. **Web ↔ native parity** — nav, deep links, push, safe area (see
   `docs/web-and-native-parity.md`)

## Feature testing template

Copy into the PR or chat handoff:

```text
Feature under test: <name>
Happy path: [ ] exercised on localhost as <role>
Edge cases:
  [ ] empty / invalid input
  [ ] unauthorized / wrong role
  [ ] expired or missing token/link (if applicable)
  [ ] duplicate submit / idempotency
  [ ] mobile viewport
  [ ] failure path (email/sync/API error) shows correct UI
Connected surfaces checked: <list>
Automated tests: <commands + result>
```

Do **not** use `/demo` as the only proof for production-like flows.

For interactive debugging in Cursor (screenshots, console logs, live DOM), connect
**Chrome DevTools MCP** — see
[`docs/agents/cursor-chrome-devtools-mcp.md`](agents/cursor-chrome-devtools-mcp.md).

## Run e2e locally before you promote

The `e2e` job in `.github/workflows/test.yml` is a bounded smoke gate that runs
on pushes to `main`; it is **skipped on pull requests**. It runs the ladder,
landing-page, and public-tour flows with zero retries. Playwright's global setup
still signs in once as admin, manager, and resident, so missing or drifted
credentials fail quickly even though the smoke command skips the slower
storage-state setup project. The sandbox-backed public application spec stays in
the full suite because a production-mode server correctly hides test listings.

The complete 158-case suite runs as `e2e-full` on the nightly schedule or a
manual workflow dispatch. It uses one worker and zero retries. Keeping it off the
per-push critical path prevents known 60-second failures from consuming three
attempts each and cancelling every `main` run before later specs execute.

Pin the dev/test Supabase project first (a plain production build silently uses
the **production** project — see
[`docs/database-environments.md`](database-environments.md#a-local-production-build-can-silently-target-production)),
then:

```bash
npm run test:seed
PLAYWRIGHT_SKIP_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:<port> \
  E2E_TESTS_ENABLED=1 node --env-file=.env.test node_modules/.bin/playwright test
```

Both local runs and the two CI E2E jobs use zero retries so a flaky failure stays
visible and does not multiply the suite's memory/time cost. `retries: 0` in
`playwright.config.ts` is the single source of that — no npm script or CI step
passes `--retries`, and `tests/unit/ci-test-workflow.test.ts` fails if one starts
to. Prefer a targeted
spec list locally; use `npm run test:e2e:smoke` for the same bounded slice as
`main`. Avoid `next dev` for broad E2E runs: cold Turbopack route compilation can
exceed assertion timeouts on a constrained machine. Let Playwright build and
start the production server, or build once and set `PLAYWRIGHT_SKIP_WEBSERVER=1`
for repeated targeted runs. Note `npm run test:seed` currently
aborts partway with a `profiles_manager_id_key` duplicate on a workflow
resident — the core role accounts are already provisioned by then, so the suite
still runs, but the later fixtures it would have created are missing.

### Known-failing specs — expect these, don't re-triage them

As of `main` @`94cfc09f` (run `30778729243`) 18 of the 20 failures are
**long-standing**, and they are not a long tail of unrelated bugs — they are
**three root causes**. Evidence: each one also fails in the four earlier `main`
runs that got as far as executing `e2e` (`30766248350`, `30741321358`,
`30739338457`, `30736186602`), while the two dark-mode cases fail only in this
run. So none of the causes is CI infrastructure, and none came from the
Communication/portal work. Tracked externally as
`axis-ci-e2e-persistent-failure`, which has no in-repo counterpart.

The other two — `dark-mode.spec.ts` on `/portal/calendar/all` and `/admin/events`
— were the one genuine regression in that run and are **fixed**, so expect 18,
not 20. Cause and guard live with the code: the comment on the sticky calendar
toolbar rule in `src/app/globals.css` and
`tests/unit/stylesheet-root-selectors.test.ts`.

Causes 1 and 2 share a *symptom* — a Playwright strict-mode violation reading
"resolved to 2 elements" — but not a cause, and a fix for one does nothing for
the other. Read the locator in the failure, not just the message.

**Cause 1 — one `data-attr` is in the DOM twice, so Playwright strict mode
throws (10 cases).** A portal section renders the *same* action node twice and
lets CSS hide one per breakpoint — the "split" header shape: a `hidden md:flex`
`titleAside` paired with an `md:hidden` mobile actions row (see
[`portal-list-section-layout.md`](portal-list-section-layout.md) rule 3).
`locator('[data-attr="…"]')` therefore resolves to 2 elements and the call
throws before asserting anything.

```text
promotion-new-modal.spec.ts:54/66/99/144   [data-attr=promotion-new] ×2      (desktop+mobile = 8 cases)
manual-payment-verification.spec.ts:9      [data-attr=payments-setup] ×2
new-manager-full-journey.spec.ts:46        [data-attr=manager-properties-create] ×2
```

⚠️ **Those three sections have since moved to the band-only shape** — Promotion,
Payments and Properties now render their header actions once, from
`PortalPageTitleBand`, so re-run these cases before treating them as
known-failing. The split shape survives only on Finances and the documents /
lease / resident-payments panels, where the mobile row is a phone's only control.

To fix a case that still reproduces: scope the spec to the rendered twin with
`:visible` — the pattern `promotion-new-modal.spec.ts:36` already uses for
`demo-nav-promotion`. Do NOT "fix" it by deleting one of the twins on a
split-shape section; that leaves the section with zero controls on a phone
(`tests/unit/portal-inline-title-band-duplicate-controls.test.tsx` fails
closed on both halves). Note the duplicate is *also* an analytics defect: a
`data-attr` is meant to name one element for PostHog autocapture (see
`AGENTS.md`), and two nodes double-count the Action.

**Cause 2 — the spec's own locator asks for a union of two present elements
(2 cases).** No `data-attr` and no duplicated markup is involved, so neither
Cause 1 remedy applies here.

```text
manager-portal.spec.ts:35     getByRole('heading').first().or(page.locator('main'))   (spec line 41)
resident-portal.spec.ts:33    same                                                   (spec line 37)
```

`.or()` matches **both** sides, not "the first one that exists" — the trailing
`.first()` binds to `getByRole("heading")`, not to the union. Every portal page
renders a heading *and* a `<main>`, so the union is 2 elements and strict mode
throws before the visibility assertion runs. To fix, put the `.first()` outside
the union so it selects one of the two matches:
`page.getByRole("heading").first().or(page.locator("main")).first()`. That is
not a weakened assertion — the specs already assert "a heading **or** a main
landmark is visible", and this is the locator that expresses it.

**Cause 3 — the e2e web server is a production runtime, which deliberately hides
the seeded fixtures (6 cases).** `playwright.config.ts` starts
`npm run build && npm run start`, so `NODE_ENV=production` and `VERCEL_ENV` is
unset, making `isProductionRuntime()` true. Every seeded property is owned by a
`@test.proplane.local` manager, which `isPortalSandboxEmail()` classifies as
sandbox, so `/api/public/property-lead` returns **404 "Property not found."**
(`src/app/api/public/property-lead/route.ts`, the `isSandboxPublicListing`
branch) and every public prospect page renders `ManagerLinkGate` — "This
property link is invalid or no longer active."

```text
tour-scheduling.spec.ts:10/:17             /rent/tours-contact?propertyId=mgr-test-fir
public-apply.spec.ts:13                    /rent/apply?propertyId=mgr-test-fir
resident-login-and-application.spec.ts:10/:19
bundle-group-manual-chrome.spec.ts:53
```

This is why the specs fail even though the row is present and `status = 'live'`
— confirm with a direct query before assuming the seed is at fault. The guard
itself is correct and must not be relaxed: it is what keeps test listings off
the real rent catalog.

The two candidate fixes are **not** equivalent, and the cheaper-looking one is
the broad one:

- **Seed the public-facing fixtures under a non-sandbox manager domain** —
  narrow. Changes only which listings `isPortalSandboxEmail()` classifies, which
  is exactly the thing these 6 cases trip over.
- **Set `VERCEL_ENV: preview` on the `e2e` job** — one line, but it flips
  `isProductionRuntime()` for the whole suite, and 11 modules read it: not just
  `public/property-lead`, but `src/lib/auth/portal-access.ts`
  (`adminBlockedFromManagerPortal` stops blocking admin→manager portal crossing),
  `src/lib/public-listings.server.ts`, `src/lib/listing-cta-phone.server.ts`
  (listing CTA falls back to the shared dev line), `src/lib/server-env.ts`
  (the admin-register key and the `FREE100` payment waiver gain dev fallbacks,
  and `assertNonProdDatabase` starts enforcing), and six `/api/cron/*` routes
  (which begin accepting unauthenticated calls when `CRON_SECRET` is unset).
  Several of those are the behaviours other specs assert, so this can mask or
  alter failures well outside the 6 cases it targets. Don't apply it as a
  one-liner without re-reading the whole suite's result set.

`admin-portal.spec.ts:68` and `mobile-portal-layout.spec.ts:22` are **flaky**,
not failing — they pass on CI retry and pass locally. Do not file them as
failures.

## Land work on `main` (Vercel Preview)

Work goes straight to `main`, fast-forward only, never force. `main` builds a
Preview deployment — verify there and on localhost before promoting.

Before pushing:

1. `bin/fm-proplane-security-review.sh` — blocks Critical/High (report under `state/`)
2. `no-mistakes axi run --skip=push,pr,ci` (review, test, document, lint)
3. `npm run test:unit`

Never open a GitHub PR unless the captain explicitly asks. Never push `fm/*`
branches.

Scripts restart dev servers and open the browser via `bin/fm-proplane-open-localhost.sh`.

If no-mistakes parks at a gate, drive `no-mistakes axi respond` then re-run with `--validate-only`.

## Promote main → production (live)

```bash
git checkout main
git pull
# verify main's Preview deploy (and localhost) first
bash scripts/promote-main-to-production.sh
```

Or manually:

```bash
git checkout production
git pull
git merge --ff-only main
git push origin production
git checkout main
```

Then verify:

1. Vercel **Production** deployment succeeded (from `production` branch)
2. GitHub Action **iOS TestFlight** succeeded, including its "Distribute build to
   internal TestFlight group" step — that step, not the upload, is what proves the
   build is installable (or secrets missing — report it)
3. Spot-check the live site for the shipped feature

## Native-shell-only changes

If you changed `ios/`, `capacitor.config.ts`, native plugins, icons, or
permissions: TestFlight upload is required; App Store review may be required
for permission/string changes. Run `npm run cap:prod` locally before archiving
if building from Xcode by hand (`scripts/verify-cap-prod-config.sh` guards
Release builds).
