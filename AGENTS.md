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
| **Akhil** | [`docs/agents/AGENTS-akhil.md`](docs/agents/AGENTS-akhil.md) | File Linear tickets, open a studio plan, or run no-mistakes unless he asks |
| **Prakrit** (captain) | [`docs/agents/AGENTS-prakrit.md`](docs/agents/AGENTS-prakrit.md) | Use Akhil's "skip ticket / skip no-mistakes" process |

**How to tell:**

- User says they are Akhil or Prakrit, or the message is clearly from one of them.
- Home / workspace path contains `akhil` → Akhil. Path or host context that is
  Prakrit's (lane worktree, captain integration through `/promote`, the studio
  plan as the default pipeline) → Prakrit.
- They talk like the captain (ticket, plan, promote, studio) → Prakrit.
- Still unclear → ask "Akhil or Prakrit?" and wait. Do not guess a process.

Captain default: **every message becomes a studio lane plan before code, and
issues do not get Linear tickets unless he asks** —
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

- **Production changes require explicit user authorization.** Default routine work to
  dev/test (`emstjswhotsnyksqhqyf`) and use staging for release QA. Before any
  production schema or data change, resolve the exact target, preserve a backup,
  use a reviewed fail-closed apply path, and verify the result. Authorization for
  one bounded change does not authorize unrelated production mutations.
- **Never write the locked live listings** (5257 / 5259 Brooklyn, 4709A 8th Ave). See `.cursor/rules/no-production-live-listings.mdc`.
- **Never skip `staging` except under Akhil's standing exception.** Live ships
  from `production` only after staging QA by default. Since 2026-09-26, with no
  end date, an explicit Akhil-authorized release may skip staging entirely with
  `npm run ship:production -- --skip-staging` under
  [the standing policy](docs/agents/temporary-direct-production-policy.json)
  (delete that file to revoke). Every other gate still applies. Prakrit's
  agents merge to protected branches only through `/promote`, typed by the
  captain himself, never on an agent's own initiative. Agents working for
  Akhil may merge only his keeper → `main` → `staging` → `production` (or
  keeper → `main` → `production` under the policy), and only after his
  explicit ship request under `docs/agents/AGENTS-akhil.md`.
- **Never fabricate a listing photo.** Empty `imageUrl` renders `NoImagePlaceholder`. Stock photos only on `/demo`.
- **User-facing copy says "service", never "work order".** Schema names stay. `tests/unit/services-vocabulary.test.ts`.
- **No agent's branch name belongs in this file.** Keeper names live in local instructions only.

# Landing rule

**Prakrit: standing keeper → `prakrit` (captain integrate) → `main`; agents working
for Akhil after his explicit ship request: his prompt branch → `main`. QA on
`staging` by default; Akhil's releases skip it under the standing policy above. Live from
`production`.**
Prakrit keeps a fixed set of standing agent lanes plus the captain integration
worktree open. The lane count, the roster and integration authorization live in
[`docs/agents/AGENTS-prakrit.md`](docs/agents/AGENTS-prakrit.md) § Standing
branches, lanes, and the promote ladder.
Do not create a branch per prompt or delete a standing keeper after integration.
Commit and push the assigned keeper (fast-forward only, never force). Open a PR only on request.
If a push is not a fast-forward, stop.

**Agent handoff:** `npm run sandbox:open -- </route>` and put the Review URL in the reply.
**Prakrit captain integration:** the captain types `/promote prakrit` in the
lane's own pane. Akhil's explicit release authority bypasses this integration
rung only, never staging or fast-forward rules.
Details: `docs/agents/AGENTS-prakrit.md`, `docs/agents/sandbox-open-review.md`.

# Branching & deployment (Vercel)

Vercel project `proplane` builds **only** `staging` and `production`. `main` is localhost.
There is no long-lived `dev` branch.

Prakrit's path:

```
standing keeper → prakrit  →  main  →  staging  →  production
(no deploy)       integrate  localhost  QA preview  live + TestFlight
                  (captain)  dev DB     staging DB  live production DB
```

| Branch | Role | Database | Vercel |
| --- | --- | --- | --- |
| standing keeper | agent work across prompts | local + **dev/test** (`emstjswhotsnyksqhqyf`) | no deploy |
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
npm run ship:production -- --skip-staging # Akhil only, policy-gated origin/main → origin/production
```

Never ff `main` onto `production` except through the standing Akhil policy
option above. Retired: `scripts/promote-main-to-production.sh` (exits 1).

## Production push also ships iOS — TestFlight and the App Store

A `production` push deploys Vercel **and** `.github/workflows/ios-testflight.yml`.
`upload_to_testflight` is not a ship - the distribute step
(`scripts/ios-testflight-distribute.mjs`) assigns the build to the internal
tester group, then `scripts/ios-app-store-release.mjs` submits the build to
App Store review (release after approval; holds while Apple is reviewing).
The store page is the committed `app-store/` folder - never a hand-dragged
screenshot. Version numbers come from App Store Connect, not a Xcode edit.
Gate fails closed; allowlist, not denylist. See `docs/mobile-app.md`.

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
branches is a 14-case public smoke. `e2e-full` is nightly / manual only. Run the
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

A plain portal GET several components each read goes through `sharedGet`
(`src/lib/shared-get-cache.ts`): one request per URL per page load, keyed on the
full URL so scopes never share an answer, invalidated by `invalidateSharedGets`
after a write. Never add a second bare `fetch` for a route another component
already reads.

A PUBLIC read whose answer is identical for everyone (the catalog, the room-occupancy
snapshot) also keeps one in-process snapshot per instance, for a TTL at or under the
response's own `s-maxage`: `createTtlCache` (`src/lib/server-ttl-cache.ts`), which shares
one in-flight computation and never caches a failure. Never for anything scoped to a
viewer, a workspace or a `fresh=1` read.

Never re-upload the local portfolio on page load: the sync replaces the local
copy with the server's. Local-first property writes go through the outbox
(`src/lib/property-record-outbox.ts`), which the sync flushes first; an empty
outbox sends nothing.

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
  assistants broke). The **resident portal mounts the assistant on its own
  `/api/agent/resident-chat` endpoint** (captain, Oct 7; the same route and registry
  also serve resident SMS and the inbox agents).
- Manager SMS = portal catalog minus every `destructive` tool (derived from the
  flag). Leasing SMS inline-allows only `escalate_to_manager` and `request_tour`.
- Approving an application and creating/editing a listing are **not** agent
  tools until charge generation and listing normalization move server-side.
- One assistant surface: the side panel (desktop) / full-screen sheet (phone),
  opened from the top bar; no floating button or pop-up. Every portal layout
  mounts `PortalAssistantRail` on its own role endpoint.

| Role | Resolver | Registry | Route |
| --- | --- | --- | --- |
| Manager | `resolveAgentContext` | `agentRegistry` | `/api/agent/chat` |
| Resident | `resolveResidentAgentContext` | `residentAgentRegistry` | `/api/agent/resident-chat` |
| Vendor | `resolveVendorAgentContext` | `vendorAgentRegistry` | `/api/agent/vendor-chat` |
| Admin | `resolveAdminAgentContext` | `adminAgentRegistry` | `/api/agent/admin-chat` |
| Vendor SMS | `buildVendorAgentContext` | `vendorWorkOrderAgentRegistry` | inbound webhook |
| Prospect SMS | `buildLeasingSmsAgentContext` | `leasingSmsAgentRegistry` | inbound webhook |
| Resident personal agent | `buildResidentPersonalAgentContext` | `residentPersonalAgentRegistry` | inbound webhook (owner's number) |
| Manager SMS | `resolveManagerSmsAgentContext` | `buildManagerSmsRegistry` | inbound webhook |
| Vendor number AI | `buildVendorNumberAiContext` | `vendorNumberAiRegistry` | inbound webhook |
| Vendor on the PropLane line | `buildVendorLineContext` | `vendorLineRegistry` | inbound webhook (shared line) |

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
Tables stay for detail views. Admin Communication is the manager's
`ManagerUnifiedInbox` over an admin data adapter - no table, no inbox of its own.

The admin ROLE is not the all-owners read. A manager-portal route serves it only
when the request asks (`?oversight=admin`, from `adminOversightUrl`) and
`resolveAdminOversight` confirms the role; otherwise a platform admin reads and
writes as the manager they are. Never branch a new manager route on `isAdminUser`
yourself - `docs/agents/communication-inbox.md` § Workspace isolation.

# Listing images: never fabricate a photo

Empty `PropertyBrowseCard.imageUrl` means no real photo. Render
`NoImagePlaceholder`. The only stock fallback is
`demoOnlyBrowseCardPlaceholderImage`, gated on `isDemoModeActive()`.

# Portal UI system

**Copy the reference screens:** lists match the property **Pricing** tab, pop-ups and create/edit
flows match **Add property** — `docs/agents/ui-page-structure.md` § Reference implementations.
**Start at [`docs/agents/ui-page-structure.md`](docs/agents/ui-page-structure.md)** (the generic
anatomy every page follows), then [`docs/agents/ui-change-checklist.md`](docs/agents/ui-change-checklist.md).
Every list tab copies Properties via `PortalRecordListSurface`: header card
with tabs, search, icon actions and the round blue + (the only create action;
filters open from the top-right Filter popover), flat shared record rows,
per-record ⋯ menus with contextual actions. Mobile is the same surface.
**No pills on rows**: a row is tile · title · place line · glyph facts · figure · ⋯,
never a `Badge` or status chip — the tab says the bucket, anything else is a
plain fact with a glyph (`tests/unit/portal-list-rows-no-pills.test.ts`).
Chevrons inline after the label. Header actions reach a phone **exactly once**
(band-only or split - never both). Details: `docs/portal-ui-system.md`,
`docs/portal-list-section-layout.md`.

Dashboard sections go in `MANAGER_DASHBOARD_SECTIONS` and gate on `visibility.<id>`.

**Never generate subtext.** A heading, a row or a field carries a label and its
control — never a muted sentence under it explaining it, anywhere in the
product. Counts are steppers, picks are dropdowns (multi-select with an Other
entry when several apply), never pills. Detail and the source guard:
`docs/agents/ui-change-checklist.md` § No subtext. The settings kit
(`portal-settings-ui.tsx`) has no `description` / `meta` props by design;
reminder timings, channels and type pickers are `CheckboxMultiSelect` /
`FieldSingleSelect`, never chips. Guard:
`tests/unit/portal-settings-no-subtext.test.ts`.

**Utility chrome is icon-heavy.** Share, Copy, Filter, Settings, Download, Edit,
and Delete in a title or card header are `PortalIconAction` in the top right —
never a labeled pill. The word is the tooltip and `aria-label` only. Labeled
text is reserved for a data-commit (Save) or a destructive confirm. See
`docs/agents/ui-change-checklist.md` § Icon chrome.

# Brand assets (PropLane)

User-visible name is **PropLane**. Mark is the house mark (rounded house/chevron outline with an X — `public/brand/proplane-mark.svg`), never a paper plane and never "AX".
Keep `src/app/icon.svg` and `src/app/favicon.ico` in sync. Lockup:
`src/components/brand/axis-logo.tsx`. iOS assets: `scripts/generate-brand-assets.mjs`.

# Deleting an account must leave the email reusable

Classify every new `public` table in `account-purge-manifest.ts` (or
`ACCOUNT_PURGE_RETAINED`). Deleting the last portal deletes the login
(legacy `profiles.role` included). On success only, clear localStorage via
`clearPortalBrowserCache()`. Coverage: `tests/unit/account-purge-coverage.test.ts`.

A manager's **Delete resident** may take a resident-only login with it, through
that same purge — never a login with a life outside the workspace. Every
condition is re-derived server-side and owned by
`src/lib/auth/resident-account-deletion.ts` (+
`tests/unit/resident-account-deletion.test.ts`); a read that fails keeps the
account. Do not restate the conditions elsewhere.

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
Approved application unlocks Lease + Payments + Documents + **Forms** (its own
resident section, never a My home tab). Before approval, a sent form opens by
its OWN `/resident/forms/<id>` link only — the list stays shut and the nav row
inert (stage `application_submitted_forms`). My home stays locked until the
lease is signed, with the row visible. Native bottom-nav constants are
**derived**, not copied. `applicationApproved` reads the `resident_email`
**column**, not `row_data.email`.

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

- **One conversation list.** Standalone inbox page shell is `/demo` only.
  Manager, resident, vendor and admin Communication all have Active | Archived
  tabs under the work identity boxes, switching instantly with no remount; Unread
  stays in Filter, which never lists Archived.
- Scheduled sends render **inline** in the recipient thread on every portal, admin
  included. The one list of them is the manager Filter's phone-only "Scheduled N".
- A message enters the store **after** the send is authorized. Copy the resident panel, not the manager/vendor ones.
- Stamp `time` with `formatInboxStamp` (Pacific). It is both label and sort key.
- SMS **UI** is gated by `SMS_COMM_UI_ENABLED` (default off) on the manager-side portals (manager / resident / vendor); admin Communication operates the PropLane line and stays on in both states. Transport and agents stay live. Keep inbound SMS visible when the UI is hidden.
- Residents schedule from the thread composer only — New message hides the schedule fields for them (deliberate).
- A thread's `row_data` may carry a `recordRef: {kind,id,label}`; a record page's
  Communication section (`record-communication-section.tsx`) merges the same
  inbox into one timeline of every conversation with that record's contact(s),
  archived included — see `docs/agents/communication-inbox.md` § recordRef.

## Inbox attachments

Serve route **never** answers `inline`. On native, intercept the click
(`isNativeRuntimeSync()` only) and share the blob. Read the file name from
`?path=`, never the URL's last segment. `.pdf` is a suffix test.

# Out-of-band auth links are `token_hash`, never a PKCE `code`

Every link sent out of band — emailed, or texted (the guest short-stay sign-in
link) — uses `verifyOtp` (`/auth/confirm?token_hash=…`): a PKCE `code` is bound to
the browser that asked for it, and such a link is opened somewhere else. Never
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
| Check-in (codes) | `docs/agents/resident-my-home.md` § Check-in | `checkInReveal` is the one reveal decision (24 h before check-in/move-in; signed lease / confirmed stay); codes are `null` in the data until then, never hidden in markup; `houseInfo.internal` (pantry/lockbox/mailbox) is staff-only and removed from every non-staff reader's data (`houseInfoWithoutInternal`); one guide for residents and guests; "I'm in" is session-derived and idempotent |
| Services system | `docs/agents/services-system.md` | One vocabulary: Open · Assigned · Scheduled · Completed (`service-lifecycle.ts`); only a submitted bid is approvable; offered vendors see the general area only |
| Vendor portal | `docs/agents/vendor-portal.md` | Scope by `vendor_user_id = auth.uid()`; accepted bid `amount_cents` is immutable |
| Financials | `docs/agents/financials.md` | Ledger is write-through (`syncLedger*`); `security_deposit` is liability |
| Vendor invoicing | `docs/agents/vendor-invoicing.md` | Totals recomputed server-side; vendor tools stay on `vendorAgentRegistry` |
| Lease generation | `docs/agents/lease-generation.md` | `resolveStayPricing` is the one price decision; never author a statute citation |
| Lease execution | `docs/agents/lease-generation.md` | Per-signature SHA-256 of the document that party saw; signed body is immutable |
| Uploaded leases | `docs/agents/lease-generation.md` | Parse is derived, never a guess; one send gate (`leaseSendGateBlocker`) |
| Resident payments | `docs/agents/resident-payments.md` | `resolveServiceFeePayerFor` is the only fee-payer resolver |
| Rent reporting | `docs/agents/rent-reporting.md` | Consent gates every export; late derives from the ledger; a stopped row skips the next cycle; PropLane is a reseller behind one partner interface |
| Documents | `docs/agents/documents-module.md` | Private bucket; bytes only via server-minted signed URLs |
| Public listing payload | `docs/agents/lease-generation.md` | Explicit allowlist (`publicListingProjection`) for both anonymous readers |
| Demo / sandbox | `docs/agents/demo-sandbox.md` | `/demo` never writes real rows; snapshot ships empty |
| Service mode | `docs/agents/admin-service.md` § Service mode | The Property portal is only for managers who bought the software; PropLane-managed (`is_service`) workspaces open in the admin-style shell under `/portal` (rail: PropLane logo, the service workspaces, +) for staff only; `GET /api/workspaces` omits a staff service workspace; the client owner stays view-only in the Property portal |
| Admin Accounts | `docs/agents/admin-accounts.md` | Disabling or enabling an account goes through `setAdminAccountActive` only, refuses without a reason before the flag moves, and writes one `admin_account_active` audit row; the insert is best-effort, so `auditRecorded: false` is reported, never hidden |
| View as | `docs/agents/view-as.md` | Read-only, 30 minutes, reason required, allowlisted operators only; audit row BEFORE the cookie; the cookie is signed and bound to the signed-in operator; the middleware refuses every non-read request; a GET that heals on read checks `isViewAsSessionOpen()` |
| Studio Live mode | `docs/agents/studio-live.md` | Frame-ancestors relaxation and `/api/dev/studio-sign-in` are dev-only (`NODE_ENV==="development"` + localhost + dev/test project); production/preview headers stay byte-identical |
| Co-manager access | `docs/agents/co-manager-access.md` | Empty permissions = no access; assigning a property is not a grant |
| Property owner | `docs/agents/co-manager-access.md` § Property owner | A team role, not a portal: four owner keys, no module key; owner rows are filtered out of every teammate-style reader (`withoutOwnerLinks`); the numbers are an allowlist projection of the manager's own reports, never names; the house and manager come from the membership, never the request |
| Owner management | `docs/agents/owner-management.md` | A PropLane-managed workspace's money sits in PropLane's platform Stripe balance and is allocated in the append-only party ledger (owner payable, PropLane fee, vendor payable, deposits) - never a manager hold; fee rounds down, owner gets the remainder; every journal is idempotent on its Stripe/source id and balanced; withdrawals reserve under a per-party lock then Transfer to the person's own Express account; vendor bills on a managed workspace charge the owner; a self-serve workspace keeps its own Connect flow; holding owner rent needs counsel (RCW 18.85, WAC 308-124E) |
| SMS / phone | `docs/agents/sms-system.md` | Outbound from the work number of the workspace the message is about, never another workspace's; one work number and one work email per workspace; conversation id is not the phone pair |
| PropLane line (one number) | `docs/agents/one-number.md` § W29 | A workspace texts the shared PropLane line unless it holds BOTH a live `manager_sms_numbers` row and a paid personal-number entitlement (`managerPersonalNumberEntitlement` is the one answer; a trial, a FREE100 waiver and an admin comp do not count, pre-2026-10-29 numbers are grandfathered); an unreadable number table or entitlement fails closed to `per_workspace`; a dedicated workspace is never answered on, nor sends from, the shared line; a PropLane-managed (`is_service`) workspace always texts on the PropLane line in BOTH modes even with a live number of its own (`resolveServiceLine` in `service-line.server.ts` is the one decision; an unresolvable line refuses the send, never the old number). The 206 line serves homes PropLane manages (`is_service`): a verified-unique platform admin (or the Service-settings phone) gets every service workspace, a seat holder only their seats (a Viewer seat has no write tool), an unclear first text gets exactly one question back (the role question in `per_workspace`; in `shared` "Which home are you texting about?" first, and the role question only on a second unclear text), and in `per_workspace` mode a self-serve home or person is pointed at its manager's PAID number or the pricing page with nothing about the home disclosed; in `shared` mode (the captain's switch, never code's) the 206 fully serves every workspace without a personal number; in BOTH modes a verified sender who owns an entitled resident number or a routable vendor number is told to text it (lapsed or unreadable = served normally); any unreadable or ambiguous read means LESS access |
| Admin team | `docs/agents/admin-service.md` § Admin team | Overall admin = `profile_roles` `admin`, granted only by redeeming an email-bound `kind = admin` invite link whose inviter is re-checked as an Overall admin at redeem (a workspace admin invites only into their own workspaces, never above their own role); every grant/revoke writes its `admin_team_*` audit row first; the last Overall admin is never removed or demoted; a PropLane-issued seat of any role opens the service shell and only its own workspaces, every PropLane-wide `/api/admin/*` route keeps `requireAdminRoute()` |
| Admin › Service | `docs/agents/admin-service.md` | PropLane Service is the `portal_workspaces.is_service` flag plus memberships, never ownership: attach writes its audit row first, never moves `owner_user_id`, and every `/api/admin/service-*` verb starts with `requireAdminRoute()` — a body id is a name, never a grant |
| Number subscription | `docs/agents/comms-billing.md` § PropLane Number, `docs/agents/vendor-portal.md` | The vendor/resident owns the $5/month PropLane Number; gate a number feature on `numberServiceEntitled` (active\|past_due), never your own status check; reserve the number credit BEFORE any provider or model call and hand it back when nothing went out; a lapsed number is paused and released after 30 days; deleting the account cancels the Stripe subscription before its rows are purged |
| Communication credit | `docs/agents/comms-billing.md` | Reserve credit before provider/model work; a saved card never authorizes a charge |
| Vendor dispatch agent | `docs/agents/vendor-dispatch-agent.md` | Answer-only + `escalate_to_manager`; `row_data.dispatch` is server-owned |
| Manager account creation | `docs/agents/manager-account-creation.md` | `/auth/create-account` never auto-redirects into a portal |
| Inbound support email | `docs/agents/inbound-email-inbox.md` | Receive-only into admin inbox; fail closed on Vercel |
| MCP / public API | `docs/agents/mcp-api.md` | API key is a credential, not standing authorization |
| Google integrations | `docs/agents/google-integrations.md` | Minimal scopes per product; writes go to the dedicated "PropLane" calendar, never the user's own events; a Google-side edit/delete of a PropLane event is an attention item, never a silent reschedule |
| Communication | `docs/agents/communication-inbox.md` | One inbox; one conversation per person per workspace (conversation key, created only by `resolve_or_create_conversation`); authorize then append; `formatInboxStamp`; never `inline`; one Assistant per person per workspace and one Team chat per workspace (`team-thread:<owner>:ws:<workspace>`, relayed by text): people type there, and PropLane adds ONE line per routine team notice (`buildTeamNoticeLine`, idempotent on `action-event:<key>:team`); a teammate's Assistant is noticed only when the event is urgent, the owner always is, and a notice never opens a per-teammate conversation; one in-app House chat per house per workspace (`house-thread:<owner>:ws:<ws>:prop:<id>`, created only through the conversation key) whose members are re-derived from occupancy on every read and write, shown to housemates by first name and room only, and a resident whose residency ends has their one-on-one conversations auto-archived unless another residency remains |
| Record pages | docs/agents/record-page.md | Residents standard; header icons per section; no footer or toolbar; picker on phone |
| Send compose | `docs/agents/send-message-compose.md` | New message is the one send UI; body auto-formatted from every collected fact |
| Plan entitlements | `docs/agents/plan-entitlements.md` | `resolveEffectiveManagerSkuTier` is the only plan a quota may read |
| Property ownership | `docs/agents/property-ownership.md` | `POST /api/property-records` never moves an owned row from the body |
| Property drafts | `docs/agents/property-drafts.md` | Draft is `status: "draft"` on the same record; closing the wizard saves |
| Tours | `docs/agents/tours-scheduling.md` | `slotKey` is Pacific wall time; `listOpenTourSlots` is the one "what's open" |
| Inspections | `docs/agents/inspections.md` | Residency-scoped; a completed report is permanently locked |
| Shared-room capacity | `docs/agents/shared-room-capacity.md` | One bed unless set; last bed is arbitrated in the database (409) |
| Bookings surface | `docs/agents/bookings.md` | One `PropertyBookingEntry` shape for every source; residents are drawn from the occupancy snapshot and the slower applications/lease reads only enrich the same stay; five reads at a 12s cap and a failed one never blanks the calendar; status is derived from the dates (a guest's own Checked in is the one stored input); every `room_date_block` is a named booking or a room Closed with a reason (`roomDateBlockNameError`), every booking emails the workspace owner; dates are authoritative and times ride beside them through `bookings/stay-times.ts` alone (overlap compares wall times, a stay's `residentUserId` and paid add-ons are server-owned) |
| Guest portal stays | `docs/agents/bookings.md` § Guest portal stays | A web request for a short stay needs a resident account and lives in the resident portal (`/resident/applications/stay`, a booking application: always a 24h hold, instant confirm OFF unless the host ticked it); `stayDetails.source` records the channel on the row and every outcome notice follows it through `noticeChannelFor` (portal = email + inbox with /resident links, never SMS or a /l/ pay link; sms = the work-number text); one core writes every stay row (`createShortStayRows`); the guest is the session, never the body; a confirmed stay raises one `stay_total` charge, idempotent on the block id; there is NO Stays tab (captain, Oct 27): a stay is a row of the Application page's Sent | Approved | Denied (`guest-stay-application.ts` is the one section decision), `applications` is reachable at every stage for any resident (stage 0 included), and `/resident/stays*` redirect there (`next.config.ts`); applications and tours record the same channel (`noticeChannel`, server-owned) and a portal row's resident notices (received, approved, declined, tour confirmed/rescheduled/cancelled, lease, charges) are email + resident inbox with /resident links, never SMS - the resident portal never links to Messages |
| Group applications | `docs/agents/group-applications.md` | Several independent apps + shared `AXISGRP-…` id; a group never blocks |
| Rent basis | `docs/agents/rent-basis.md` | `rentBasis` alone; daily never wins unless the manager set it |
| Send listing modal | `docs/agents/send-listing-modal.md` | Server re-authorizes every id; reject the whole send if any fails |
| Marketing mocks | `docs/agents/marketing-mocks.md` | Depict a real screen; derive counts from the rows drawn |
| Public blog | `docs/agents/blog.md` | A figure is quoted as its source states it, one source per claim; posts are prerendered and a stat tile always links its source |
| AI search visibility | `docs/agents/ai-search-visibility.md` | `/llms.txt`, `/llms-full.txt`, robots' named AI crawlers, the sitemap's listing URLs and the pages' JSON-LD are all derived from the module that owns each fact (rate card, blog posts, `publicListingProjection`) — never a hand-typed copy; one hourly public-catalog read feeds both, and a listing fact absent from the blob is never published |
| Public journey pages | `docs/agents/public-journey.md` | Browse, listing, tour, apply and the phone-bound doors wear the homepage look through `.ps` (`public-site.css`) only — never a forked shared component; `/rent` is the WEB channel and its own `(rent)` route group, so no page under it ships a phone number, a "Text us" button or an `sms:`/`tel:` link (the homepage keeps the number, from config, never a literal) and every listing action goes through a resident account into the resident portal; real photos or `NoImagePlaceholder` |
| House printables | `docs/agents/house-printables.md` | The public page and both public printables render only `HOUSE_PUBLIC_SECTIONS`; a code or password never becomes a URL |
| Listing wizard defaults | `docs/agents/listing-wizard-defaults.md` | A record follows the Default card per field; the card is saved on the submission, never resolved downstream; counts make the cards |
| Property import | `docs/agents/portfolio-import.md` | The drafts are the import; the model answers only through the tool and cites rows; rent is what the tenant pays, never market rent |
| Address prefill | `docs/agents/listing-prefill.md` | Facts from RentCast only; never fetch a listing page — ad text arrives by paste; default-only fill with marks and undo; nothing sets the rent |
| Automated communication | `docs/agents/automated-communication.md` | One spine: action events + reminder rules; inbox is the record; a manager's own copy is an Assistant notice for the owner; routine notices on the ACTION-EVENT bus reach the team as one PropLane line in the Team chat; a teammate's Assistant gets a notice only when the event is urgent; the owner always gets theirs; never a per-teammate conversation (a bus notice names a teammate through `resolveWorkspaceNoticeRecipients` only when urgent — an inbound forward still reads it for every event; text from the owner's work number, billed to the owner; email from the work email); a reminder-rule `team` row is still that teammate's own Assistant notice, scoped to their houses and modules; the Team line's text relay answers to the same grant and topic gates; cross-party copies send as the manager; nothing automates a regulated notice |
| Listing syndication | `docs/agents/listing-syndication.md` | Official APIs and feeds only, never scraping or headless posting; every post is one builder over `publicListingProjection` facts plus the workspace work number and work email (no work number = nothing posts); a listing missing a street address or a real photo is held with a reason, never given a placeholder; Facebook Page/Instagram stay "Coming soon" until `META_APP_LIVE=1` |
| Vendor services | `docs/agents/vendor-marketplaces.md` | Outside marketplaces are plain public links the manager opens, never scraped or API-called; every URL curl-verified; an account row is a label plus an https link, never a credential, and only the service-role route reads it |
| Integrations page | `docs/agents/integrations.md` | One page (Messages · Bookings · Posting · Google), a new channel is a row on it; linking/unlinking/syncing a channel calendar needs Calendar at `edit`; the export feed URL is built on the canonical server origin (request origin only for localhost outside production); Facebook Marketplace stays Copy post only (the post now carries the work number and email), Facebook Page auto-post connects once per workspace in Posting and stays Coming soon until the Meta app is approved |
| Move-in forms | `docs/agents/move-in-forms.md` | A sent form snapshots its questions (only its manager edits a pending one); a submitted form is locked; a pending form's Blocks (move-in details, lease signing, approval) are enforced on the server; files only through signed URLs |
| Application questions | `docs/agents/application-questions.md` | Everything is editable, nothing is locked — with name/email removed a signed-in applicant's come from their account and a guest is always asked; a share link is stored only as its SHA-256 hash and covers one request; a linked application charges its own fee to whoever fills it |

## There are no "work orders" in the product — only services

Copy says "service". Schema keeps `work_order` names. Two models share the
Services nav: add-on requests (`portal_service_request_records`) and
maintenance (`portal_work_order_records`). Do not merge tables, tabs, or counts.
Two stored-title matchers must keep saying "Work order" (legacy row titles).

**One stage vocabulary, everywhere.** Every service-request list and Tasks say
**Open · Assigned · Scheduled · Completed** from `src/lib/service-lifecycle.ts` —
never a bucket of your own, and the retired words fail
`tests/unit/service-vocabulary.test.ts`. A vendor's answer, the manager's
actions and the service record's rail are in
[`docs/agents/services-system.md`](docs/agents/services-system.md) § One vocabulary.

# Property ownership / plans / drafts / groups

Do not re-copy these. Read the files in the table. When Properties shows
`0 / 0 / 0` but other tabs still list houses, the owner moved - diff the two
sources before touching either.

# Financials UI cleanup (Blue Steel consolidation)

One `Button`: `src/components/ui/button.tsx`. No `size` prop. `danger` is
text-only red. The Button owns loading - return the promise from `onClick`
(`() => save()`, never `() => void save()`). Resident Payments is Charges-only;
its bucket rides in the path and the panel's props, not a sub-tab -
[`resident-payments.md`](docs/agents/resident-payments.md) § Resident Payments
section owns that routing. `/demo` has its own prop list - forward `tabId` /
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
