# Calendar availability edit-dialog browser regression

Run `npm run test:calendar-availability` (Chromium via `npx playwright install chromium`).

Bundles the **real** `PortalCalendarPanels`, `Modal`, `Button`, listbox `Select`
and current Tailwind CSS with esbuild and serves them through Playwright request
interception — no dev server, accounts, or database. Only the schedule-record
store's server write, the app-UI provider, Next navigation, the manager session
and the work-assignment directory are stubbed (`stubs.tsx`).

The fixture mounts the panel the way the manager Calendar page does — `studioGrid`,
`availabilityKeysByKind`, `coManagerPeers`, and one house — so the spec drives the
shared calendar a manager actually sees, not the legacy compact grid.

Covers:

- exactly **three availability kinds** — Tours · Services · Tasks (inspections and
  move-ins fold into Tasks) — each painted run labelled by its own kind, with its
  own small × ("Remove `<kind>` availability `<hours>`");
- the **shared people row**: availability is shared with everyone on the workspace
  calendar (no opt-in), one colour and initials per person, every block saying
  whose it is, and hiding a person taking their hours off the grid;
- clicking a run opens the prefilled **Your availability** dialog (kind, date,
  from/to); **Save** rewrites that kind's record and **Delete** removes just that
  run;
- kind isolation: editing a services run writes only the per-manager services
  record, never the per-house tours key the public booking route reads;
- the same three kinds, people row and dialog on a phone (which opens on Agenda
  by design — the spec switches to Week through the real control).

Set `EVIDENCE_DIR=<dir>` to also write screenshots.
