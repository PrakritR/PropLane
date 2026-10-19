## One Software section (captain feedback 10-14, October 18)

The homepage mounts `HomeSoftwareDemo` once at `#dashboard`, headed with the shared `HomeSectionHeader`
("Software"). It is ONE continuous journey (captain round #18, October 19) through the REAL resident, manager and
vendor portals: Jordan books a tour by text (resident Tour + manager Tours), applies (resident Application, manager
approves), pays (resident Payments, manager Incoming payments), signs the lease (manager Leases, resident Lease; the
resident sidebar unlocks by stage for real), then a service goes to the vendor (vendor Services, manager Services
Assigned). It is an iframe of `/demo/home-embed` at a fixed 1280x800 logical size, scaled to fit, with the phone of
whoever is acting beside it and a Resident · Property · Vendor switcher top right (no "Sample …" captions anywhere on
the homepage: captain #24/#25). The
phone is drawn from what the iframe reports (`HomeIphonePhone`, plus listing cards and photos from
`home-demo-phone-items.tsx`), so the two never disagree. A visible cursor, labelled with the acting portal, clicks
the real controls; inbound events (a text, a YES, a payment) are store writes, applied at the press that opens the
tab they fill so no tab is ever shown empty. There is no chapter bar and no pause button: hover, focus, a press
inside the portal, leaving the screen or a hidden tab hold it; it loops. Reduced motion draws the journey's end
frame (no cursor, no autoplay). Photos are drawn sample SVGs, never stock or listing photos.
Architecture and rules: `docs/agents/demo-sandbox.md`. There is no redrawn portal copy on the homepage, and no
second dashboard/demo section.

`public-footer-band.css` owns the shared footer’s opaque ink-blue surface. Do
not restore transparent footer rules in the wave styles or a separate gradient
in `site-display.css`. Verify actual painted links and text contrast in addition
to geometry on both the homepage and public journey pages.

The public secondary pages (`SitePage` / `MarketingPageShell`: blog, docs, partner, legal, about, app, vendors)
wear the homepage's tokens through `site-display.css` alone: Inter Tight (`--font-public-site`, headings at 600 with
tight tracking), ink `#0c0d10`, the one blue `#2f5fd0`, hairline `#d6d7d2`. The `--site-*` and `--lp-*` tokens
there point at those values; do not hard-code the retired navy `#132b47` / blue `#1769bd` in a component, and
do not reintroduce a separate display face (`site-display-font.ts` is gone).

# Marketing mocks & guide art

Moved out of the root `AGENTS.md` to keep it loadable; this is the
authoritative copy. Read it before changing code in this area.

## Public homepage: one scroll story (captain, 2026-10-18)

The public front is one page with four distinct stories: the number (cover +
`#how`), the software (`#dashboard`), the managed service (`#service`), and
software plans (`#pricing`), followed by the contact form. The cover says
“Your Housing Assistant”. The top bar links to How it works, Software, Service, Pricing
and Contact, with the configured number and Portal at the right. Phones get
an accessible menu and a sticky text action after the cover. There is no QR. `HomeScrollStage` uses native scroll and midpoint sentinels; rail links
scroll to scenes, with no wheel interception. Reduced motion and no JavaScript
keep the conversations readable.

`HomeNumberStage` reuses shared sample scripts in `HomeIphonePhone`: an iOS
Messages frame with a Dynamic Island, status bar and the configured PropLane
number in its contact header. No phone number is hard-coded. Its owner scene reads the aggregate `owner-statement` fixture, never
resident details. Network captions describe the shipped public-listing router,
approved vendor jobs, and keeping the PropLane number when moving homes; they
make no claims about sharing a private workspace thread.

The Software section is documented in § One Software section above.

The cover uses self-hosted Inter Tight and one blue (`#2F5FD0`), with the original
`ResidentLifecycleAtmosphere` waves, blue gradients and dots behind the page.
`HomeHousingScene` is inline architectural line art connecting homes with message
threads below the real number. Its subtle message motion stops under reduced
motion; the atmosphere draws statically on phones. Whitespace and subtle
product-frame shadows keep the four sections distinct. It reads the cached shared
line supplied by the layout, including the captain-approved `shadow` mode;
this does not change SMS transport routing. When unavailable, the cover shows
Start free and no invented number.
The five texting beats are Prospects, Residents, Vendors, Owners and Every home.
Each phone uses only its own beat's messages, not a cumulative prospect thread.
The rail and visible scene share one scroll index in both directions.
All operating claims derive from `TRACK_RECORD`. Pricing comes from the rate
card, and each software card selects five included lines from
`MANAGER_PLAN_TIERS` via `managerPlanFeatureSummary`. Service inclusions come
from `MANAGED_INCLUDES`. The compact contact form
requires an email because the existing contact route does, and preserves its
inputs after a failed send. Marketing redirects, sitemap and crawl links share
`src/lib/seo/marketing-routes.ts`.

The active stages fit below the top bar and above the mobile text action at
100% zoom. The compact pricing grid is four columns on desktop and two by two
on phones, with five canonical software feature lines and all six managed
service inclusions. Processing-fee disclosure appears once below the grid.
Text zoom may grow static sections rather than clip their contents.
The closing footer is a full-width ink-blue band with faint waves, the configured
number as a text link, the existing six-link grid and a current-year copyright.

The older reusable lifecycle engine below remains available to other surfaces.

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
demo window (the lifecycle demo; it replaced `SiteHero`). There
is no stage UI: no portal pill bar, stage tabs, "Sample demo" line or Activity
row. The visitor changes portal from the window's own account menu (the real
menu's "Switch to ... portal" rows, `portalSwitchTargets`), every portal draws
"Ask PropLane" and no bell, and every sidebar item opens the real panel for
that tab.

- **Four beats, no more.** `resident-lifecycle-script.ts` holds `STORIES`: a
  prospect asks and books a tour, applies, signs the lease, pays rent and gets a
  repair booked (manager and resident); offer, quote, visit, paid (vendor).
  Each beat is one to three phone messages and the matching real panel.
- **The story is causal and manager-led** (captain 2026-10-07, round 7).
  `MANAGER_STEPS` in `resident-lifecycle-script.ts` is the whole manager story as
  a list of steps (`wait`, `say` a phone message, `nav` to a sidebar tab, `click` a
  control); everything on screen is the fold of the steps that are done
  (`stateAfter`). Every phone line the manager sends sits right after a click the
  manager made in the window: Approve the drafted reply -> tour confirmation;
  Send application -> the "Apply for Room 3 — PropLane" link (the lead-invite
  subject, `lead-invite-email.ts`); Send lease -> "Sign your lease"; Send reminder
  -> the rent reminder; Dispatch vendor -> the plumber booked. The resident's own
  lines (texting, applying, signing, paying, reporting a leak) land between, and the
  panels' rows follow them (the new pending application, lease stage, paid, the open
  service). A writing click waits for the manager, as the product does. Add a step
  there, never a phone line on its own. `tests/unit/home-demo-script.test.ts` pins
  "every `in` line follows a click".
- **The cursor** (`resident-lifecycle-cursor.tsx`): a pointer with a role label
  ("Manager") glides to a control, the control shows a hover outline
  (`[data-demo-hover]`), a ripple rings out, and the engine calls the control's real
  `.click()`, so the panels' own handlers open the sheet or move the row. Targets are
  found by `data-demo-target="<id>"` and must stay on the exact controls whenever a
  panel is redrawn: `nav-<tab>` (sidebar), `comm-approve`, `applications-send`,
  `sheet-primary`, `application-row`, `lease-row`, `payment-row`, `service-row` (a
  row wrapper marked with `DemoTarget`, which draws no box). A target that never
  renders is skipped, so the story never stalls. The cursor scrolls the target into
  view inside the window (never the page), lives in an overlay inside the window so it
  cannot cover the phone, leaves when a visitor pins a tab, and is not drawn at all
  under `prefers-reduced-motion`. Only the manager's window has a cursor.
- **The clock**: a step runs, then the next; after the last, the story starts over.
  The window follows the beat; a sidebar click pins that tab (the cursor leaves, the
  window stops autoplaying, the phone does not). Hover or focus inside the window and
  an open account menu pause the clock; `prefers-reduced-motion` runs no clock and
  shows the first beat still, with no cursor.
- **Nothing is cut off.** A frame that holds a whole thing (the import window in
  `switch-steps.tsx`, drawn at 1100x860 inside a frame sized to it) ends on its last
  card. A fixed-size scrolling window (the hero and every row) fades out at its bottom
  edge and shows a chevron while more is below (`data-scroll` on `.rlp-main`, measured
  from every scroller inside the screen), and both go when everything is in view. The
  Replaces strip wraps instead of scrolling; the phone's sidebar strip fades at its
  edge; a placeholder that does not fit ends in an ellipsis.
- **One phone, sticky and centred.** `ResidentLifecyclePrototypes` takes the replaces strip
  and the lifecycle rows as `children`, so the phone beside the window stays on
  screen (sticky from `lg`, inline under the window below it) through the hero,
  the demo and every row; rows draw no phone of their own. From `lg` the phone sits
  vertically centred in the viewport on the right (captain 2026-10-07: "keep the phone
  centered on screen, in the middle on the right side"): `.rlp-story-phone-slot` is sticky
  with `top: max(header + 12px, 50svh - phone height / 2)` (the lifecycle hero stylesheet),
  and nothing scroll-driven moves it. Captions are roles:
  "Resident's phone" (manager portal), "Manager's phone" (resident portal, the
  thread mirrored), "Vendor's phone".
- **People are shown by role**: "Manager", "Resident", "Vendor" in the window
  chrome, phone headers and account cards (company "Pacific Plumbing" stays); a
  manager's list rows keep a plain first name (`RESIDENT_NAME`), the resident's
  own account is `RESIDENT_SELF`.
- **Every window is one fixed size** (hero and rows): the screen scrolls inside
  it and never grows it (the hero window GROWS on scroll as a transform only; see the next section). The focus ring on a sidebar item sits inside the sidebar.
- **The sidebar is the real sidebar, not a copy** (captain 2026-10-07: "same sidebar tabs"). `DEMO_TABS`
  (`site/product-mock/demo-nav.ts`) is `buildPortalNavItems` over the real portal definitions (`proPortal`,
  the resident catalog, `vendorPortal`) bucketed by the real `groupNavItems` / `PORTAL_NAV_GROUPS`: same rows,
  labels, order, groups, icons (`PortalNavIcon`), count badges (`PortalNavCountBadge`, red for unread mail and
  overdue money, a quiet number otherwise) and the real "Conversations" group. **No row nests any more** —
  vendor Finances was the last one and is a single row since `financials` stopped declaring registry tabs
  ([`vendor-portal.md`](vendor-portal.md) § Finances), so `home-demo-nav-parity.test.ts` expects an empty
  `subItems` everywhere. A tab id IS the real section id (`move-in`, `work-orders`, `payments`). Never write a
  second list: `tests/unit/home-demo-nav-parity.test.ts` rebuilds the expectation from `PORTAL_NAV_GROUPS` and
  fails when a section is added, renamed, moved or left without a panel.
- **Panels come through one contract**, `site/product-mock/demo-panels.tsx`:
  `DemoPanel({ portal, tab })`, one entry per real section id. Only the manager Communication
  thread is drawn by the demo itself (Akhil's, tied to the phone). The tabs the first pass lacked live in
  `panels-manager-rest.tsx` (Tasks, Bookings, Promotion, Forms, Outgoing payments, Finances, Documents),
  `panels-resident-more.tsx` (Tour, Documents) and `panels-vendor.tsx` (Documents, Finances) from
  `fixtures-more.ts`; each copies the real page's tabs, search placeholder, header icon actions and row anatomy
  (read from its component), and the list-band icon vocabulary guard still applies — the allowed set is
  `PORTAL_LIST_BAND_ALLOWED_ICONS` in `portal-list-control-stack.tsx` (Landmark and Withdraw joined it for
  the vendor Finances band; see [`../portal-list-section-layout.md`](../portal-list-section-layout.md)).
- **Pop-ups and record pages are the real ones, drawn from fixtures** (captain 2026-10-08: "a lot of the pop ups in
  home page are not accurate to real portal"). The round + opens the real pop-up (same title, step rail, field
  labels, right-hand preview, footer words), a row opens what the real row opens (a record page, or a modal when the
  real one is a modal), the row's ⋯ is the real menu for that one selected row (`useRowSelection`), the Filter is the
  real popover (`DemoFilterSheet`), and sub tabs are the real labels (import the real constants:
  `MANAGER_TASK_LIST_TAB_LABELS`, `SERVICE_STAGE_TABS`, ...). Never a generic RESIDENT / HOME / STATUS field card and
  never a bare toast where the real portal opens something. Settings gears navigate in the real portal, so the demo
  shows the same icon with a "(sample)" toast. Shell: `product-mock/demo-popup.tsx` (`DemoWorkspacePopup`: the real
  `ListingWorkspace` header, `StepRail`, progress bar, right panel and `AddWorkspace` footer rule, no assistant, no
  fetch; it renders into the window's popup host so it never covers the page) and `demo-record.tsx`
  (`DemoRecordPage`: real header, `recordSections()` rail and header icons, `RecordFactCard` bodies). Doors that fetch
  (`AddWorkspace` doors, `MoveInFormFrame`, `AddResidentWizard`) are static copies built from the same exported pieces
  (`demo-popups-<area>.tsx`); a door that mounts from props (the New property wizard, `ListingEditorV2`, the Add
  application / Add resident step bodies) is the real component. Every pop-up is a `next/dynamic` chunk
  (`demo-popups-lazy-<area>.tsx`), so the home page's first load does not grow. The hero cursor still finds
  `sheet-primary` (a popup's footer primary, or the record header icon the story clicks). Tests:
  `tests/unit/home-demo-popups-<area>.test.tsx` assert the real tab labels, the + pop-up's title and rail, the row's
  record, and that `fetch` is never called.
- **The Dashboards are the real dashboards' own pieces** (`site/product-mock/dashboards.tsx`). Manager:
  `KpiCard` with bars and "vs last month" deltas, `AttentionPanel` fed by the real `buildManagerAttentionRows`,
  `UpcomingPanel`, `PortfolioPropertiesSection`, the real cash-flow `MonthlyProfitChart`, and "Everything open"
  built from the `AttentionGroup` / `IssueRow` / `StatusPill` that `pro-dashboard.tsx` exports (the real
  `ManagerDashboard` also holds its data hooks, so the tree is composed in the same order and spacing).
  Resident: `ResidentJourneyBanner`, `ResidentKpiTile` and the Needs attention groups exported by
  `resident-dashboard.tsx`. Vendor: `VendorDashboardView`, the presentational half of the real `VendorDashboard`
  (the real page renders the same component). No "Welcome back" unless the real page has it. Every number is read
  off the rows the other tabs draw (`world.ts`).
- **Nothing writes.** No network request, nothing saved; a vendor is never shown
  the street address before a quote is accepted (offers say the general area).

## The home page window is the redesigned portal shell, and the hero grows on scroll

Captain 2026-10-07 (approved plan `dashboard-redesign-1007`): the window the home page draws
(`resident-lifecycle-workspace.tsx`, styled by `resident-lifecycle-shell.css`) is the new portal shell, not a
lookalike of the old one: a dark 40px top strip ("Ask PropLane or search <workspace>", the house mark, no plane),
an ink workspace rail (workspace tile, help, the account avatar that opens the account menu), a light 248px sidebar
with collapsible groups bucketed like `PORTAL_NAV_GROUPS` (an unheaded home group, then Portfolio / Leasing / People /
Money, or Applying / Money for the resident (whose My home group is unheaded too — a "My home" heading over the
My home row said the same word twice), Work / Money for the vendor; labels are the real nav labels),
flat white content, and the AI assistant as the ONLY right panel (the strip's right icon docks it; its "Needs
attention" rows are the Dashboard's, counted from them). Match the running portal when you change it. The window's
pages are the real redesigned components inside `DEMO_PAGE_CLASS` (the real main column's 32px rhythm, which the page
shell's negative-margin header band bleeds into) drawn at 82% from `lg` up, because those components answer to the
viewport and the window's column is narrower than a real 1440px one. Every `data-demo-target` (nav-<tab>,
applications-send, sheet-primary, comm-approve, application-row) stays on its control; the cursor re-resolves a target
a beat after finding it, because a freshly mounted real page can swap its toolbar for a fresh copy.

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
Applications panel, the ops task rows, the guide art under `public/marketing/` — depicts
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

## Public homepage assets and pricing

The Swiss page above supersedes the earlier text-first prototypes. The shared
`PricingCards` component shows Free, Pro, Business and “We manage it for you.”
Its compact overview is four aligned desktop cards and stacked phone cards. Software amounts come from the rate card; the service is Custom.
Both offerings use the same configured PropLane line. The public layout supplies
that snapshot to the synchronous homepage, avoiding a loading-shell
layout shift. The homepage preloads a small Inter Tight cover subset (OFL license beside
the font); regenerate it with `scripts/generate-home-swiss-cover.py` when the
headline changes. The same generator produces the Latin-1 variable UI subset,
preserving all weights and shaping features while keeping the full licensed
source font committed. Older Bricolage assets and their generator remain for reusable
lifecycle artwork; they are no longer preloaded by the public layout.
