<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# PropLane (Axis Housing)

Shared contract for every coding agent. Deep history lives in `docs/agents/`.
Do not paste incident writeups here. Add a one-line invariant and a pointer.

# Who is asking (mandatory, first)

This repo has two developers. After reading this file, **open the matching
developer file before you do any work.** Do not apply both. Do not skip this.

| If the user is… | Read next | Do not |
| --- | --- | --- |
| **Akhil** | [`docs/agents/AGENTS-akhil.md`](docs/agents/AGENTS-akhil.md) | File Linear tickets, open Lavish, or run no-mistakes unless he asks |
| **Prakrit** (captain) | [`docs/agents/AGENTS-prakrit.md`](docs/agents/AGENTS-prakrit.md) | Use Akhil's "skip ticket / skip no-mistakes" process |

**How to tell:**

- User says they are Akhil or Prakrit, or the message is clearly from one of them.
- Home / workspace path contains `akhil` → Akhil. Path or host context that is
  Prakrit's (captain integrate, `ship:to-prakrit`, Lavish/Linear as the default
  pipeline) → Prakrit.
- They talk like the captain (ticket, plan, promote, lavish) → Prakrit.
- Still unclear → ask "Akhil or Prakrit?" and wait. Do not guess a process.

Captain default: **every message becomes a Lavish plan before code, and issues
do not get Linear tickets unless he asks** —
[`docs/agents/lavish-plan-standard.md`](docs/agents/lavish-plan-standard.md).

Shared safety in this file always wins (production lock, staging ladder, RLS,
tool layer). The developer file only adds **how to work with that person**.

## How to find things

1. `graphify query "<question>"` (or `path` / `explain`) when `.graphify/graph.json` exists
2. Else `docs/agents/<area>.md` (table below)
3. Only then raw search

Skills, plugins, and MCP servers are additive. They never override this file
or `docs/agents/*`. Do not invent a second source of truth for the same concern.

## Hard stops

- **Never write production data.** Dev/test only (`emstjswhotsnyksqhqyf`). Staging DB is the only other write target. See `.cursor/rules/no-production-data-writes.mdc`.
- **Never write the locked live listings** (5257 / 5259 Brooklyn, 4709A 8th Ave). See `.cursor/rules/no-production-live-listings.mdc`.
- **Never skip `staging` outside the dated exception.** Live ships from
  `production` only after QA by default. Until 2026-09-15T04:00:00Z, an
  explicit Akhil-authorized release may use
  `npm run ship:production -- --skip-staging` under
  [the temporary policy](docs/agents/temporary-direct-production-policy.json).
  Prakrit's
  agents never merge to protected branches. Agents working for Akhil may merge
  only his keeper → `main` → `staging` → `production`, and only after his
  explicit ship request under `docs/agents/AGENTS-akhil.md`.
- **Never fabricate a listing photo.** Empty `imageUrl` renders `NoImagePlaceholder`. Stock photos only on `/demo`.
- **User-facing copy says "service", never "work order".** Schema names stay. `tests/unit/services-vocabulary.test.ts`.
- **No agent's branch name belongs in this file.** Keeper names live in local instructions only.

# Landing rule

**Prakrit: keepers → `prakrit` (captain integrate) → `main`; agents working
for Akhil after his explicit ship request: his keeper → `main`. QA on
`staging` by default, subject only to the dated policy above. Live from
`production`.**
Commit and push your keeper (fast-forward only, never force). Open a PR only on request.
If a push is not a fast-forward, stop.

**Agent handoff:** `npm run sandbox:open -- </route>` and put the Review URL in the reply.
**Prakrit captain integration:** `npm run ship:to-prakrit -- --source <keeper>`.
Akhil's explicit release authority bypasses this integration rung only, never
staging or fast-forward rules.
Details: `docs/agents/sandbox-open-review.md`.

# Branching & deployment (Vercel)

Vercel project `proplane` builds **only** `staging` and `production`. `main` is localhost.
There is no long-lived `dev` branch.

Prakrit's path:

```
keepers  →  prakrit  →  main  →  staging  →  production
(no deploy)  integrate  localhost  QA preview  live + TestFlight
             (captain)  dev DB     staging DB  live production DB
```

| Branch | Role | Database | Vercel |
| --- | --- | --- | --- |
| keeper | messy work | local + **dev/test** (`emstjswhotsnyksqhqyf`) | no deploy |
| **`prakrit`** | captain integration | **dev/test** | no deploy; localhost :3000 |
| **`main`** | consolidation | **dev/test** | no deploy; localhost |
| **`staging`** | QA candidate (ff of `main`) | `xwszcafaontidfgznlxd` | Preview, git-branch-scoped env |
| **`production`** | live site | `qahnczmilgptcedaqype` | Production + iOS TestFlight |

`assertNonProdDatabase()` refuses the live project from local, preview, **and the
`staging` git branch**. Same Vercel project for staging; do not add a second one.
Production Branch setting stays **`production`**. Full ops: `docs/agents/deployment-workflow.md`.

```
npm run ship:staging      # ff origin/main → origin/staging
npm run ship:production   # ff origin/staging → origin/production
npm run ship:production -- --skip-staging # temporary, policy-gated origin/main → origin/production
```

Never ff `main` onto `production` except through the active dated policy
option above. Retired: `scripts/promote-main-to-production.sh` (exits 1).

## Production push also ships iOS

A `production` push deploys Vercel **and** `.github/workflows/ios-testflight.yml`.
`upload_to_testflight` is not a ship - the distribute step
(`scripts/ios-testflight-distribute.mjs`) assigns the build to the internal
tester group. Gate fails closed; allowlist, not denylist. See `docs/mobile-app.md`.

# Before you show a feature (agents)

Finished means it has been **run, with real data, including the edges**.

1. Seed real data (`npm run test:seed` or the feature's seed). Never `/demo` as proof. Never `wipe:test:all` / `ALLOW_DEV_WIPE` unless asked. Never `seed:production`.
2. Exercise the whole path in the browser. State the edges you drove.
3. Report real test/lint exit codes (no piped `| tail`).
4. Pin the port **before** starting the server (`npm run sandbox:pin -- 3000`), ports **3000-3014**, then `npm run sandbox:open -- </route>`.
5. Without an explicit Akhil ship request, stop after the Review URL. With his
   explicit ship request, agents working for him may complete the reviewed and
   QA-tested ladder without separate captain or human handoff approval.

# Mandatory ship / change gate (agents)

Follow [`docs/ship-gate.md`](docs/ship-gate.md). Run `npm run ship:preflight` before promote.

A green PR or green `main`/`staging` run is **not** full e2e. `e2e` on those
branches is a 9-case public smoke. `e2e-full` is nightly / manual only. Run the
suite locally before promoting portal UI or routes.

The `check` job aggregates `unit` + `lint` + `build` only. Add a new hermetic
job to its `needs` or it gates nothing. `integration` and `e2e` stay out of that list.

# Database environments

Local / tests / `main` share **dev/test**. Staging is a separate project.
Production credentials live only in Vercel. Schema parity: `npm run db:push`,
not the SQL Editor. Full model: [`docs/database-environments.md`](docs/database-environments.md).

# Working in a git worktree

Worktrees do not carry gitignored `.env*`. Seed once:

```
npm run seed:env            # copy missing (never overwrites)
npm run seed:env -- --force
```

Never seed `.env.production*` unless `--include-production`. Next loads that
file for any production build and will silently target the live project.

# Monitoring & Observability

Instrument both when changing relevant code. Full model: [`docs/observability.md`](docs/observability.md).
It is **Langfuse**, not LangGraph.

**PostHog** - autocapture + `data-attr="kebab-name"` + named `object_action` events
for funnels only. Reuse existing names (`src/lib/analytics`). Never send PII.
Autocapture is a PostHog **project** setting, not a code setting.

**Langfuse** - every agent turn/tool call is traced (`traceAgentTurn` /
`traceAgentAction`). Stamp `landlordId`, session, and prompt meta. A new
surface must thread `onTraceId` / `proposalTraceId` or it cannot be scored.
A trace id is never authorization. Never init Langfuse under `NODE_ENV=test`.

# Performance & egress

Supabase free-plan egress is a constraint. Prefer cache. Public reads get CDN
`Cache-Control`. Client syncs use the shared TTL + in-flight guard.

`{ force: true }` bypasses both guards - go through `createCoalescedRefresher`
(`src/lib/coalesced-refresh.ts`). Key refreshers on whatever makes two runs
non-interchangeable (viewer id, window, portal role). Tag server-sync store
events (`serverSyncOriginatedEvent`) so listeners do not refetch the snapshot
they just wrote. Calendar polling plan: `docs/realtime-schedule-invalidation.md`.

# AI Agent & Tool Layer

Read [`docs/ai-assistant.md`](docs/ai-assistant.md) before touching `src/lib/tools/`
or `src/lib/agent/`.

- The agent acts **only** through typed tools. Same functions as the UI. Never raw SQL.
- `landlordId` comes from authenticated context, never model input.
- Numbers and statuses come from tool results, never model arithmetic.
- Writes use `defineWriteTool` (preview + handler). The loop stores a pending
  action; the client confirms with **only** the action id. One framework - do
  not add a second confirm route or catalog.
- `agent_pending_actions` is claimed on `user_id`, status `proposed`. Additive
  migrations only.
- A write is model-callable only when the **surface** allow-lists it. SMS
  surfaces also pass `readOnly: true`.
- One registry + resolver + route per role. Never cross them. Mounting
  `AxisAssistant` without a role-scoped `endpoint` 401s (how resident/vendor
  assistants broke).
- Manager SMS = portal catalog minus every `destructive` tool (derived from the
  flag). Leasing SMS inline-allows only `escalate_to_manager` and `request_tour`.
- Approving an application and creating/editing a listing are **not** agent
  tools until charge generation and listing normalization move server-side.
- Default manager surface is the **popup**. Dock is a per-device localStorage
  preference (`assistant-display-preferences.ts`). One store, three entry points.

| Role | Resolver | Registry | Route |
| --- | --- | --- | --- |
| Manager | `resolveAgentContext` | `agentRegistry` | `/api/agent/chat` |
| Resident | `resolveResidentAgentContext` | `residentAgentRegistry` | `/api/agent/resident-chat` |
| Vendor | `resolveVendorAgentContext` | `vendorAgentRegistry` | `/api/agent/vendor-chat` |
| Vendor SMS | `buildVendorAgentContext` | `vendorWorkOrderAgentRegistry` | inbound webhook |
| Prospect SMS | `buildLeasingSmsAgentContext` | `leasingSmsAgentRegistry` | inbound webhook |
| Manager SMS | `resolveManagerSmsAgentContext` | `buildManagerSmsRegistry` | inbound webhook |

Resident row scoping is not uniform: charges/leases have `resident_user_id` +
`resident_email`; work orders/service requests have email only. Use the two
loaders in `src/lib/tools/domains/resident/load-resident-rows.ts`.

# Web + native (Capacitor)

One codebase. Native shells load the deployed Next.js site. Do not duplicate
portal UI. When changing nav, routes, push, or uploads: update `src/lib/portals/*`,
`render-portal-section.tsx`, and `src/lib/platform/parity.ts`.
See `docs/web-and-native-parity.md`.

# Admin borrows; it does not invent

Admin list tabs use `PortalRecordListSurface` like every other portal.
`tests/unit/admin-list-surface-adoption.test.ts` fails a tab that re-grows its
own top-level `<table>`. Admin Settings is `PortalProfileClient variant="admin"`.
Tables stay for detail views and the admin inbox record table.

# Listing images: never fabricate a photo

Empty `PropertyBrowseCard.imageUrl` means no real photo. Render
`NoImagePlaceholder`. The only stock fallback is
`demoOnlyBrowseCardPlaceholderImage`, gated on `isDemoModeActive()`.

# Portal UI system

**Start at [`docs/agents/ui-change-checklist.md`](docs/agents/ui-change-checklist.md).**
Every list tab copies Properties via `PortalRecordListSurface`: header card,
flat rows (`RowSelectCheckbox`, never a bare `<input>`), dashed ADD footer with
unique `ariaLabel`, floating bulk bar. Mobile is the same surface.
Chevrons inline after the label. Header actions reach a phone **exactly once**
(band-only or split - never both). Details: `docs/portal-ui-system.md`,
`docs/portal-list-section-layout.md`.

Dashboard sections go in `MANAGER_DASHBOARD_SECTIONS` and gate on `visibility.<id>`.

# Brand assets (PropLane)

User-visible name is **PropLane**. Mark is the paper-plane glyph, never "AX".
Keep `src/app/icon.svg` and `src/app/favicon.ico` in sync. Lockup:
`src/components/brand/axis-logo.tsx`. iOS assets: `scripts/generate-ios-brand-assets.mjs`.

# Deleting an account must leave the email reusable

Classify every new `public` table in `account-purge-manifest.ts` (or
`ACCOUNT_PURGE_RETAINED`). Deleting the last portal deletes the login
(legacy `profiles.role` included). On success only, clear localStorage via
`clearPortalBrowserCache()`. Coverage: `tests/unit/account-purge-coverage.test.ts`.

# The PostgREST surface is public — RLS row predicates are not a column gate

`anon` / `authenticated` privileges are reachable with the public anon key.
RLS constrains **which row**, never which column.

For trust-signal tables (`profiles`, `profile_roles`, `vendor_invites`):

- Grant client roles **SELECT only**. Never `FOR ALL`.
- Self-service writes go through a route + service-role client pinned to `user.id`
  (`PATCH /api/profile` is the reference).
- Ids in a request body are not authorization. Re-derive ownership at every write.
- Write migrations idempotently (`drop policy if exists` before `create`).

`tests/unit/role-grant-surface.test.ts` + `scripts/verify-role-escalation-closed.mjs`
(dev/test only, needs `ALLOW_PROBE_TARGET`).

# Portal routing precedence (a section can be silently unreachable)

1. `next.config.ts` `redirects()` outrank the app router. Grep before adding a section; delete the redirect when you delete the section.
2. Legacy rewrites in `renderPortalSection` fire for every portal unless gated on the destination actually existing.
3. Resident stage guard runs **after** those rewrites, and the client guard must agree (`RESIDENT_LEGACY_SECTION_ALIASES`). `applications` is a live section, not an alias.

After adding or renaming a section, load the URL. A passing build is not evidence.
Link builders must assert the path **resolves** against `src/app`
(`tests/unit/claw-resident-links.test.ts`).

## Portal nav locks: a lock is not a dead click

`portalNavLockKind` is the one decision. `upsell` / `notice` stay live `<Link>`s.
`inert` is a no-op. Never link to a path the server then redirects home.

### Resident stage unlocks: one stage, two tables that must agree

`STAGE_UNLOCKED_SECTIONS` and `RESIDENT_BOTTOM_NAV_PRIMARY` must agree.
Approved application unlocks Lease + Payments + Documents. Signed lease unlocks
Services. My home stays locked until signed but the row is visible. Native
bottom-nav constants are **derived**, not copied. `applicationApproved` reads
the `resident_email` **column**, not `row_data.email`.

## `profiles.role` is legacy and singular — authorize off `profile_roles`

`profiles.role` is the role the account was **created as**. Multi-role accounts
(how the team dogfoods) keep that value forever. Guards and UI must use
`hasRole` / `getPortalAccessContext`. API routes use
`src/lib/auth/resident-role-access.ts` only
(`authorizeResidentRole` / `resolveResidentScopedActorRole`).
`tests/unit/resident-role-authorization-surface.test.ts` fails a new route that
branches on `"resident"` without consulting `profile_roles`.

# Inbox panels

Authoritative copy: [`docs/agents/communication-inbox.md`](docs/agents/communication-inbox.md).

- One conversation list. No folder tabs. Standalone inbox page shell is `/demo` only.
- Scheduled sends render **inline** in the recipient thread (admin table is the exception).
- A message enters the store **after** the send is authorized. Copy the resident panel, not the manager/vendor ones.
- Stamp `time` with `formatInboxStamp` (Pacific). It is both label and sort key.
- SMS **UI** is gated by `SMS_COMM_UI_ENABLED` (default off). Transport and agents stay live. Keep inbound SMS visible when the UI is hidden.
- Residents cannot schedule a compose (deliberate).

## Inbox attachments

Serve route **never** answers `inline`. On native, intercept the click
(`isNativeRuntimeSync()` only) and share the blob. Read the file name from
`?path=`, never the URL's last segment. `.pdf` is a suffix test.

# Emailed auth links are `token_hash`, never a PKCE `code`

Emailed links use `verifyOtp` (`/auth/confirm?token_hash=…`). Never
`supabase.auth.resetPasswordForEmail`. `/auth/confirm` derives destination from
`type` alone. The reset route is not an account-existence oracle.
`RESEND_API_KEY` is load-bearing.

## "Does this account have a password?" — `identities` is NOT the answer

Read `current_user_has_password()`. `identities` / provider lists are not the
answer. Fail closed to `true`.

# Feature architecture notes (mandatory pre-reads)

**Before changing code in an area, read its file.**

| Area | Read first | Never violate |
| --- | --- | --- |
| Resident My home | `docs/agents/resident-my-home.md` | Peer details redacted server-side; missing prefs disclose nothing |
| Vendor portal | `docs/agents/vendor-portal.md` | Scope by `vendor_user_id = auth.uid()`; accepted bid `amount_cents` is immutable |
| Financials | `docs/agents/financials.md` | Ledger is write-through (`syncLedger*`); `security_deposit` is liability |
| Vendor invoicing | `docs/agents/vendor-invoicing.md` | Totals recomputed server-side; vendor tools stay on `vendorAgentRegistry` |
| Lease generation | `docs/agents/lease-generation.md` | `resolveStayPricing` is the one price decision; never author a statute citation |
| Lease execution | `docs/agents/lease-generation.md` | Per-signature SHA-256 of the document that party saw; signed body is immutable |
| Uploaded leases | `docs/agents/lease-generation.md` | Parse is derived, never a guess; one send gate (`leaseSendGateBlocker`) |
| Resident payments | `docs/agents/resident-payments.md` | `resolveServiceFeePayerFor` is the only fee-payer resolver |
| Documents | `docs/agents/documents-module.md` | Private bucket; bytes only via server-minted signed URLs |
| Public listing payload | `docs/agents/lease-generation.md` | Explicit allowlist (`publicListingProjection`) for both anonymous readers |
| Demo / sandbox | `docs/agents/demo-sandbox.md` | `/demo` never writes real rows; snapshot ships empty |
| Co-manager access | `docs/agents/co-manager-access.md` | Empty permissions = no access; assigning a property is not a grant |
| SMS / phone | `docs/agents/sms-system.md` | Outbound from the work number only; conversation id is not the phone pair |
| Communication credit | `docs/agents/comms-billing.md` | Reserve credit before provider/model work; a saved card never authorizes a charge |
| Vendor dispatch agent | `docs/agents/vendor-dispatch-agent.md` | Answer-only + `escalate_to_manager`; `row_data.dispatch` is server-owned |
| Manager account creation | `docs/agents/manager-account-creation.md` | `/auth/create-account` never auto-redirects into a portal |
| Inbound support email | `docs/agents/inbound-email-inbox.md` | Receive-only into admin inbox; fail closed on Vercel |
| MCP / public API | `docs/agents/mcp-api.md` | API key is a credential, not standing authorization |
| Communication | `docs/agents/communication-inbox.md` | One inbox; authorize then append; `formatInboxStamp`; never `inline` |
| Plan entitlements | `docs/agents/plan-entitlements.md` | `resolveEffectiveManagerSkuTier` is the only plan a quota may read |
| Property ownership | `docs/agents/property-ownership.md` | `POST /api/property-records` never moves an owned row from the body |
| Property drafts | `docs/agents/property-drafts.md` | Draft is `status: "draft"` on the same record; closing the wizard saves |
| Tours | `docs/agents/tours-scheduling.md` | `slotKey` is Pacific wall time; `listOpenTourSlots` is the one "what's open" |
| Inspections | `docs/agents/inspections.md` | Residency-scoped; a completed report is permanently locked |
| Shared-room capacity | `docs/agents/shared-room-capacity.md` | One bed unless set; last bed is arbitrated in the database (409) |
| Group applications | `docs/agents/group-applications.md` | Several independent apps + shared `AXISGRP-…` id; a group never blocks |
| Rent basis | `docs/agents/rent-basis.md` | `rentBasis` alone; daily never wins unless the manager set it |
| Send listing modal | `docs/agents/send-listing-modal.md` | Server re-authorizes every id; reject the whole send if any fails |
| Marketing mocks | `docs/agents/marketing-mocks.md` | Depict a real screen; derive counts from the rows drawn |

## There are no "work orders" in the product — only services

Copy says "service". Schema keeps `work_order` names. Two models share the
Services nav: add-on requests (`portal_service_request_records`) and
maintenance (`portal_work_order_records`). Do not merge tables, tabs, or counts.
Two stored-title matchers must keep saying "Work order" (legacy row titles).

# Property ownership / plans / drafts / groups

Do not re-copy these. Read the files in the table. When Properties shows
`0 / 0 / 0` but other tabs still list houses, the owner moved - diff the two
sources before touching either.

# Financials UI cleanup (Blue Steel consolidation)

One `Button`: `src/components/ui/button.tsx`. No `size` prop. `danger` is
text-only red. The Button owns loading - return the promise from `onClick`
(`() => save()`, never `() => void save()`). Resident Payments is Charges-only
at `/resident/payments`. `/demo` has its own prop list - forward `tabId` /
`basePath` or the demo ignores the tab.

# Multi-agent collaboration (every host)

This file wins over host-specific files (`CLAUDE.md`, `.cursor/rules/*`,
skills, plugins). Prefer repo-visible artifacts over one host's chat history.
After meaningful code edits, refresh `.graphify/` (`npx graphify hook-rebuild`).

## graphify

This project has a graphify knowledge graph at .graphify/.

Rules:
- For codebase or architecture questions, when `.graphify/graph.json` exists, first run `graphify query "<question>"` (or `graphify path "<A>" "<B>"` / `graphify explain "<concept>"`); these return a scoped subgraph, usually much smaller than `GRAPH_REPORT.md` or raw grep output
- If .graphify/wiki/index.md exists, navigate it instead of reading raw files
- In Codex, the reliable explicit skill invocation is `$graphify ...`; do not rely on `/graphify ...`
- `$graphify ...` is a Codex skill trigger, not a Bash subcommand like `graphify .`
- A successful TypeScript-backed Codex build should leave `.graphify/.graphify_runtime.json` with `runtime: typescript`
- If .graphify/graph.json is missing but graphify-out/graph.json exists, run `graphify migrate-state --dry-run` first; if tracked legacy artifacts are reported, ask before using the recommended `git mv -f graphify-out .graphify` and commit message
- If .graphify/needs_update exists or .graphify/branch.json has stale=true, warn before relying on semantic results and run the graphify skill with --update when appropriate
- If the user asks to build, update, query, path, or explain the graph, use the installed `graphify` skill instead of ad-hoc file traversal
- Before proposing or committing .graphify artifacts, run `graphify portable-check .graphify`; commit-safe graph artifacts must use repo-relative paths, and never commit .graphify/branch.json, .graphify/worktree.json, .graphify/needs_update, or .graphify/cache/. If a repo already tracks any of them, first add them to .gitignore, then propose `git rm --cached .graphify/branch.json .graphify/worktree.json .graphify/needs_update` and `git rm -r --cached .graphify/cache`; never mutate git state without asking
- Before deep graph traversal, prefer `graphify summary --graph .graphify/graph.json` for compact first-hop orientation
- For review impact on changed files, use `graphify review-delta --graph .graphify/graph.json` instead of generic traversal
- Read `.graphify/GRAPH_REPORT.md` only for broad architecture review or when `query` / `path` / `explain` do not surface enough context
- After modifying code files in this session, run `npx graphify hook-rebuild` to keep the graph current

Host wiring (optional, once per machine): `graphify cursor|claude|codex|hook install`.
Do not re-run `graphify agents install` just to refresh this file.

## Maintaining this file

Keep this file for knowledge useful to almost every session. Point at the
authoritative file instead of repeating it. Prefer rewriting or pruning over
appending. Developer-specific process goes in `AGENTS-prakrit.md` or
`AGENTS-akhil.md`, not here.
