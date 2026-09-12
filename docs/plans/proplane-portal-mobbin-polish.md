# Property Studio round 2 — Mobbin-referenced polish (approved build)

Prakrit approved this plan in Lavish session `309c90b084e3a186` on 2026-09-11
("Approved — build the accepted sections as slices 8+ on claude-3", then
"build and approved"). No section was individually declined, so every section
below is built **as proposed** (the recommended option). The rendered plan with
the current-build screenshots, the Mobbin reference screens, and the mocks is at
`.lavish/mobbin-redesign/plan.html` in the `proplane-claude-2` worktree
(gitignored; ask claude-2 to reopen it if a visual is needed).

This is a **delta on the approved Property Studio build**
(`docs/plans/proplane-portal-redesign-build.md`), landed as slices 8+ on the
same keeper after the open checklist items there. Same rules: one slice = one
commit + push + ticked item + board note; land into `prakrit` in slices,
ff-only, green tsc + unit on the merged tip; real dev/test browser verification
across Manager / Resident / Vendor at 1440 and 390. No schema changes. Nothing
here touches authorization, purge manifests, or the tool layer.

Design system: PropLane tokens as they exist (`--pl-blue` accent, Schibsted
Grotesk, `--pl-line` borders, 12px radii). Reuse `PortalRecordListSurface`,
`ManagerPortalPageShell`, `PortalPageTitleBand`, `PortalSidebar`; do not fork them.

## Completion checklist

- [x] **8 · Shell.** — `ef8b3a5c`. One workspace switcher block at the top-left of the sidebar
  (avatar + workspace name + role/property count + chevron) replaces the
  PropLane logo block, the "PROPERTY" badge and the separate "My workspace" box.
  Menu order: switchable workspaces (current checked) → Workspace settings →
  Invite a manager → New workspace with the cap shown inline ("2 of 3"). Nav
  items carry counts (Properties, Tours, Applications, Payments, Tasks, Inbox)
  read from the same sources the list tabs use, cached through the existing
  coalesced refreshers. The full-width red "Set up messaging" banner becomes a
  dismissible one-line notice with a blue left rail (red rail reserved for
  errors) and a row in the dashboard attention list (§9). "Communication" is
  renamed **Inbox** in nav, page head, and mobile tab (schema and routes stay).
  Files: `portal-sidebar.tsx`, `workspace-switcher.tsx`,
  `workspace-provider.tsx`, portal layout, messaging-setup banner,
  `src/lib/portals/*` nav labels.
- [x] **9 · Dashboard.** — `6966d8d2`. Four KPI cards with a direction: Occupancy % (with
  n / N), Rent collected this period vs due, Open requests (with oldest age),
  Applications ready — each with a delta vs the previous period and a small
  8-bar sparkline; a period selector ("This month ▾") sets the baseline.
  The single next-step banner becomes a **Needs attention** panel (4–6 rows,
  each with one action: Review / Approve / Remind / Set up) and an **Upcoming**
  panel (tours, inspections, lease ends in the next 14 days, from the Calendar
  rows). Property cards: photo band shrinks, an occupancy bar (filled / vacant
  spaces) replaces "N spaces", "No photo" becomes an "add" prompt. Numbers come
  from tool results (previous-period reads through existing tools), never
  model arithmetic. Files: dashboard section components from slice 3,
  `MANAGER_DASHBOARD_SECTIONS`.
- [x] **10 · Record lists.** — `468f45ff`. `PortalRecordListSurface` renders **one toolbar**:
  tabs (with counts) · search · active filter chips (removable, e.g. "Seattle ✕")
  · view controls · nothing else. The second icon-only bar is removed. Rows
  carry a status chip (e.g. "1 / 2 occupied", ok/warn tones) and money
  right-aligned in bold. Selecting rows raises a floating dark **bulk bar**
  ("2 selected · Unlist · Share · Export · Delete · ✕"). The dashed ADD footer
  is removed from populated lists (kept only for the empty state, §15). Mobile:
  Add in the page head, tabs + chips as a horizontally scrolling sticky row,
  two-line rows with chip and chevron. Applies to every tab that already uses
  the surface (Properties, Residents, Tours, Leases, Payments, Applications,
  Inspections, admin lists). `tests/unit/admin-list-surface-adoption.test.ts`
  stays green. Files: `PortalRecordListSurface`,
  `portal-section-action-row.tsx`, tab count sources.
- [x] **11 · Tasks.** — `55bafc5a`. Table with columns: status dot · task (title + one-line
  context) · property · assignee (avatar + name) · due (chip when today/overdue)
  · priority (High / Normal / Low chip). Tabs Open / Overdue / Done. Filter chips
  Assignee / Property / Priority and a **Group by** control (Property default;
  Assignee, Due) persisted in the URL. Mobile: two-line rows with the due chip;
  assignee avatar only when not the viewer. Files: `pro-task-list.tsx`, shared
  task row.
- [x] **12 · Team.** — `eba7f2ff`. Three blocks on `/portal/teams`: (a) members table —
  member (avatar, name, email) · role pill (Owner / Manager / Co-manager) ·
  properties · last active · Access button; Managers / Vendors tabs; (b)
  **Pending invites** with Resend / Revoke and the invite link with Copy and
  Reset; (c) per-member **access**: one row per module (Properties, Leasing,
  Payments, Services & tasks, Inbox) with a 4-state segmented control
  No access · View · Edit · Manage, over the existing co-manager permissions.
  Vendors tab reuses the table with the property-scoped link column. Files:
  teams pages, `workspace-settings.tsx`, invite-link card.
- [ ] **13 · Inbox.** — in progress on `wip/claude-3-inbox-composer` (another session's work, parked unverified: 9 inbox unit tests red on it). Composer channel is a visible segmented control
  (In-app · SMS · Email) with the sending identity inline ("Sending as
  (206) 555-0100"); every message shows its channel and time ("Email · 3:42 PM",
  "You · SMS"). Conversation rows: unread dot, channel chip, context chip
  (property / Payments / Vendor / Assistant); tabs All / Unread / Archived.
  Thread header is a compact contact card (role · property · room · phone ·
  email, Call and Open resident actions). Mobile: composer directly above the
  tab bar, full width, segment on top. `SMS_COMM_UI_ENABLED` still gates the SMS
  UI; `formatInboxStamp` and authorize-then-append unchanged; residents still
  cannot schedule. Files: manager/vendor inbox panels (copied from the resident
  panel per `docs/agents/communication-inbox.md`), composer, thread header.
- [x] **14 · Mobile shell.** — `27defcd0`. Bottom tab bar is five tabs, Home first:
  Home · Properties · Inbox (unread badge) · Tasks · More, filled glyph for the
  active tab (no underline). Resident bottom-nav constants stay **derived**.
  Page heads carry the primary Add; the floating ✦ remains the assistant only;
  no second FAB. List tabs render as scrolling chips on phones. Record action
  popups (resident tour: Reschedule · Message host · Cancel tour, cancel last in
  red) render as bottom sheets with a grab handle. Workspace pill in the mobile
  header. Update `src/lib/platform/parity.ts` and `render-portal-section.tsx`
  per `docs/web-and-native-parity.md`. Files: `portal-mobile-nav-bar.tsx`,
  `RESIDENT_BOTTOM_NAV_PRIMARY` derivation, page-head band, tour dialog.
- [x] **15 · Empty states.** — `51b4fa0f`. The empty-state slot of `PortalRecordListSurface`
  renders a titled card: what appears on this tab, a cross-link to a sibling
  tab that has content ("5 upcoming — next today 4:42 PM"), and the one or two
  real actions. No bare dashed "Add" box anywhere.
- [ ] **Verification.** Real dev/test data (`npm run test:seed`); Manager,
  Resident, Vendor; 1440 and 390. Edges: 0 / 1 / 20 properties; a workspace at
  the 3-cap; a member with every module at No access; an SMS thread with the UI
  flag off; overdue + recurring tasks; composer open above the tab bar on a
  phone. Unit: admin-list-surface-adoption, services-vocabulary,
  resident-role-authorization, bottom-nav derivation stay green; new tests for
  nav counts and the 4-state access control. Reviews per `docs/ship-gate.md`,
  graph refresh, no-mistakes, ff into `prakrit`, review URL on `:3003`.

## Deliberately out of scope

- Public marketing site (`/`, `/pricing`, `/rent`) — separate plan.
- Bookings calendar and lease-type / proration UI — still open on the round-1
  checklist; polish them once that slice exists.
- Any change to authorization, purge manifests, or the agent tool layer.

## Risks

- §8 and §10 touch shared components: sequence them after the round-1 items to
  avoid a fold; every portal re-verifies afterwards.
- Nav counts add reads on every layout render — go through the coalesced
  refreshers or they become Supabase egress.

## Validation evidence

Built on `claude-3` on the night of 2026-09-11 and landed on `prakrit` slice
by slice (ff-only). Each slice: tsc 0 errors, the full unit suite green on
the tip (1392 files / 9658 tests at `51b4fa0f`), and a dev/test browser
pass at 1440 and 390 as the manager (`manager@test.proplane.local`) on
`:3003`:

- §8 — dashboard with the workspace block, menu open, collapsed rail.
- §9 — dashboard KPIs (This month), Needs attention (3 rows), Upcoming (6
  rows), property cards with occupancy bars.
- §10 — Properties: one toolbar, chips + money on rows, two-row selection
  pill with Share / Unlist / ✕; phone rows two-line.
- §11 — Tasks: Open (Group by Property), `?group=due`, Overdue on a phone.
- §12 — Settings → Team: members table with the owner row, invite-by-link.
- §14 — phone bottom bar Home · Properties · Communication · Tasks · More.
- §15 — Properties → Drafts empty card with "20 listed · open Listed".

Also landed ahead of this list: the listing editor's Mobbin polish
(`7fcfb491` — summary rail, cover tile, status block, edit-mode footer).

Not yet driven: Resident and Vendor portals after §8/§10 (the shared
sidebar and surface changed under them — a resident-side pass is owed);
the 0 / 1 / 20 property edges beyond the seeded 20; a workspace at the
3-cap; no-mistakes on the combined tip.
