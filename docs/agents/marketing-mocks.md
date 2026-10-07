# Marketing mocks & guide art

Moved out of the root `AGENTS.md` to keep it loadable; this is the
authoritative copy. Read it before changing code in this area.

## The home page's product rows reuse REAL portal components, statically

Captain 2026-09-26: "remove live demo no need" — `src/components/marketing/
site/lifecycle-rows.tsx` ("From first tour to fixed faucet.") and the
"Switching" import section (`switch-steps.tsx`) no longer embed a live
`<iframe src="/demo">`. Each row's product panel now renders the REAL portal
presentational components (the record-list surface, its rows, the sidebar
shell, the import review card) fed static "Seattle Homes" fixture props —
never a hand-drawn lookalike, and never a network request or auth dependency.
This file's copy-accuracy discipline applies here same as everywhere else:
when you add or change a row, open the real component you're reusing and
match its labels, tab names, and row anatomy exactly (see the table below and
each component's own doc comment for its fixture source).

A row's panel is interactive but never persists: tabs switch between
different fixture row sets, search filters the fixture rows client-side,
`⋯` menus open, and a primary action opens the real modal/sheet with default
values — but Save/Send/Approve only closes it and shows the real toast, since
there is no server to write to. If a panel's real component fetches internally
(session, workspace, or data hooks), build a thin static wrapper around its
purely presentational pieces instead of trying to mount the whole page tree.

## The home page demo: four beats, one phone, three portals

Captain 2026-10-06, reshaped 2026-10-07: the top of `/` is Akhil's hero plus a
demo window (`resident-lifecycle-prototypes.tsx`; it replaced `SiteHero`). There
is no stage UI: no portal pill bar, stage tabs, "Sample demo" line or Activity
row. The visitor changes portal from the window's own account menu (the real
menu's "Switch to ... portal" rows, `portalSwitchTargets`), every portal draws
"Ask PropLane" and no bell, and every sidebar item opens the real panel for
that tab.

- **Four beats, no more.** `resident-lifecycle-script.ts` holds `STORIES`: a
  prospect asks and books a tour, applies, signs the lease, pays rent and gets a
  repair booked (manager and resident); offer, quote, visit, paid (vendor).
  Each beat is one or two phone messages and the matching real panel.
- **One number drives the screen**: how many phone messages have arrived. The
  clock types a message (typing indicator), lands it, holds, types the next, and
  starts over, so a message is always typing. The window follows the beat; a
  sidebar click pins that tab (the window stops autoplaying, the phone does
  not). Hover or focus inside the window and an open account menu pause the
  clock; `prefers-reduced-motion` runs no clock and shows the first beat still.
- **One phone, sticky.** `ResidentLifecyclePrototypes` takes the replaces strip
  and the lifecycle rows as `children`, so the phone beside the window stays on
  screen (sticky from `lg`, inline under the window below it) through the hero,
  the demo and every row; rows draw no phone of their own. Captions are roles:
  "Resident's phone" (manager portal), "Manager's phone" (resident portal, the
  thread mirrored), "Vendor's phone".
- **People are shown by role**: "Manager", "Resident", "Vendor" in the window
  chrome, phone headers and account cards (company "Pacific Plumbing" stays); a
  manager's list rows keep a plain first name (`RESIDENT_NAME`), the resident's
  own account is `RESIDENT_SELF`.
- **Every window is one fixed size** (hero and rows): the screen scrolls inside
  it and never grows it. The focus ring on a sidebar item sits inside the sidebar.
- **Panels come through one contract**, `site/product-mock/demo-panels.tsx`:
  `DEMO_TABS`, `DemoPanel({ portal, tab })`. Only the manager Communication
  thread is drawn by the demo itself (Akhil's, tied to the phone).
- **Nothing writes.** No network request, nothing saved; a vendor is never shown
  the street address before a quote is accepted (offers say the general area).

## The /app page's phones follow `app-store/screenshots`

Captain 2026-10-07: the `/app` page shows the iPhone app as four equal phones side
by side (no QR-code card, no staggered pair), and they must never go stale. The
phones are NOT hand-drawn and NOT a separate copy: `site/app-page.tsx` imports four
files from `app-store/screenshots/iphone-6.9` through one manifest
(`APP_PAGE_SHOTS`). `npm run app-store:shots` (see `app-store/README.md`) re-shoots
those files from the live portal, so a portal redesign plus a re-shoot updates the
page with no edit here, and the same commit that ships the new store screenshots
ships the new page. To show a different screen, edit the manifest (file name + alt
text); the file names come from `GALLERY` in `scripts/ios-app-store-screenshots.mjs`.
The facts line under the badge (iOS version from `IOS_APP_MINIMUM_OS`, same account,
free) is checked against `docs/mobile-app.md`; change them together.

## Marketing mocks must use portal-accurate copy

Every OTHER hand-drawn product mock on the marketing site — the homepage
Applications panel (`landing-applications-pipeline.tsx`), the ops task rows in
`landing-home-sections.tsx`, the guide art under `public/marketing/` — depicts
a screen a manager can actually open. Marketing-only slang that no portal
surface ships ("lease packet", "lease draft") reads as a fake product and has
been rejected in review twice.

Before writing mock copy, open the real component and copy its labels:

| Mock | Source of truth |
| --- | --- |
| Applications panel | `manager-applications.tsx` — tabs Pending / Approved / Rejected, badges from `applicationStatusPill` (New / Screening / Screened / Flagged / In progress), row actions Approve / Reject / Send reminder / Delete |
| Lease task rows | `manager-leases.tsx` — Manager review / Resident signature pending / Manager signature pending / Signed |
| Section names in task rows | `src/lib/portals/pro.ts` (Leases, Payments, Services → Work orders / Vendors, Communication) |

Rows in a mock must also be internally consistent: a table filtered to Pending
cannot show an `Approved` badge, because that row lives on another tab.

**Guide art** (`public/marketing/guide-*.webp`) is authored at **1800×920**
(≈1.96:1) to match the `.lp-chapter .lp-art` box (`min-height: 200px`,
`object-fit: cover`, `object-position: top left`), so the whole screenshot
lands in the card instead of a tight crop that reads as texture. Regenerate with
`node scripts/generate-marketing-guide-art.mjs`, which renders each board at
900×460 and captures at 2× — a portrait crop of a live portal screenshot does not
fit this box.

That script does **not** import from `src/`. It hand-authors a standalone HTML
replica whose colours are literal hexes and whose labels are copied strings, so a
portal rename or a token retune leaves the art silently stale. Re-verify the copy
against its source component every time you regenerate:

| Board | Copied from |
| --- | --- |
| `guide-tours.webp` | `portal-calendar-panels.tsx` — the availability week: `Copy previous week` / `Create block` / `Clear week` / `Update to houses`, the `Time` + weekday header cells, the `Open` slot, the `N open` week badge |
| `guide-messages.webp` | `manager-inbox-schedule-panel.tsx` — columns `Send date & time` / `Source` / `Recipient` / `Topic` / `Subject` / `Status`, the `Automated` source chip; tab names and order from `INBOX_TAB_DEFS` in `portal-inbox-ui.tsx` |

Every count a board prints (the calendar's per-day "N open" headers and week
total, the inbox tab badges) is **derived in that script from the rows and cells
the board actually draws**, never typed in beside them. Hand-authored totals
drift from the art the moment a row is added, which is the same
internal-inconsistency failure as a Pending tab showing an `Approved` badge.

## App Store screenshots: a showcase account, a fixed frame, and live routes

`app-store/screenshots/**` are real captures of the real portal (Apple guideline 2.3.7), framed by `scripts/ios-app-store-screenshots.mjs`, never drawn. They are shot as a dedicated **showcase manager** created by `npm run app-store:seed` (`scripts/app-store-seed.mjs`: dev/test project only, idempotent, rewrites only that manager's rows, never `manager2@` or the e2e seed; `SHOT_EMAIL` / `SHOT_PASSWORD` land in the gitignored `.env.local`). The books are small-landlord realistic (6 houses, 15 rooms, 87% let, rent ~96% collected, 0 overdue, applicants, tours, leases in four stages, a work number on file) and money is rent only: a listing that configures an application fee, deposit, move-in fee or utilities makes the app bill each of them itself the moment it loads a signed lease, which is how 92 overdue charges appeared on the first dashboard shot. No photo is invented; a room with no upload keeps the house glyph. Frame rules: brand blue and deep navy alternating by slot (the install sheet reads blue, navy, blue), the product's own mark from `src/app/icon.svg`, a two-line white headline with **no subtext** (shrunk to fit, never three lines; the unit test fails a third line or "work order"), the device bleeding off the bottom edge, and the app captured without `.portal-mobile-nav-bar` and `.axis-assistant-fab`. Slots 02 and 05 are a zoomed crop card of the one element that sells them. The generator fails the run, rather than shooting a wrong page, when a route redirects elsewhere, an expected element is missing, or the page text contains a fixture string (`FORBIDDEN_TEXT`). Lesson: two slots were silently broken for months. `/portal/move-in/inspections/*` now redirects to the Residents list (slot 08 is a resident's **Move in** section, `/portal/residents/current/<id>/move-in`), and on a phone the listing editor has no side rail (slot 10 reaches Rooms through the Steps picker, `phone-strip-picker-toggle` then `workspace-step-rooms-picker`). Re-run the generator after any change to a gallery screen and look at all twenty PNGs. `npm run test:seed` prunes the showcase account, so re-run `app-store:seed` after a full reseed.
