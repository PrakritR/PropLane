# `/promote prakrit` 2026-10-08 — visual evidence

Run `npm run test:promote-prakrit` (install Chromium with
`npx playwright install chromium` if needed). Set `EVIDENCE_DIR=<dir>` to write
the screenshots somewhere a reviewer can read them.

These tests bundle the **real** `PortalTopBar`, `PortalSidebar`,
`PortalCommandPalette`, `ManagerLeases`, `PortalCalendar`, `ViewAsBanner`,
`AdminViewAsAction`, `AxisAssistant` and `LifecycleFrame` together with the
current Tailwind build, and drive them in Chromium through request interception —
no dev server, accounts or database. Only the portal session, `next/navigation`
and analytics are stubbed, so what the screenshots show is the surface an end
user sees. The page surfaces are mounted inside the same
`PORTAL_SHELL_ROOT_CLASS` / `PORTAL_MAIN_CONTENT_CLASS` wrapper the
authenticated layout uses, so a page's own header band lands where it really does.

They cover the captain's Oct 7–8 asks that the jsdom tests can only assert as
source text:

- the redesigned shell: dark Ask PropLane strip with ⌘K, workspace rail, and
  **no Conversations group** anywhere in the sidebar;
- ⌘K opening the palette while the Ask PropLane popup is up, plus the palette's
  own jump filtering;
- Leases: Filter · Lease settings gear · round + in that order, icon-only, and
  the Filter popover's Property / Stage / Updated fields;
- Calendar: ONE round + whose menu holds Add availability (it opens the form),
  no separate Availability clock icon, and a Plug icon that navigates to
  Settings → Integrations without opening a popup;
- View as: the persistent read-only banner, and the account record's View-as
  slot opening b7a's dialog (hidden entirely for a disabled account);
- the home-page demo drawn as the real portal, for manager (Dashboard,
  Promotion → Listing sites, Communication), resident and vendor.

## Known gap encoded here

`test.fail("the palette opened over the Ask PropLane popup takes focus and
filters")`. The shortcut fires, but the palette it opens over the popup cannot be
used: the popup's modal keeps the focus trap, `body` stays `pointer-events: none`,
and the popup's backdrop is the element at the palette's own coordinates. The
case flips green on its own once that is fixed.
