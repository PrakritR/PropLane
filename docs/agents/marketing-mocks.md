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
