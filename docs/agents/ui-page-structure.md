# UI page structure (the generic anatomy every page follows)

Read this before designing or changing any page, in any portal (manager, resident, vendor,
admin, public). It is the anatomy; the detailed rules live in the tier-1 docs it points to
(`ui-change-checklist.md`). For a plan, start from the whole-product mock kit
([`ui-mock-kit.md`](ui-mock-kit.md)) and change only the pages the plan touches.

**Redesign means the same features.** Keep every real tab, action, field and flow, only
clearer and working. Anything new that wasn't asked for goes to the captain as a question
with "Keep as today" as an option.

## 0. One UI for every portal

**The manager portal is the reference design.** Resident, vendor and admin pages use the same
anatomy: the same list header, rows, ⋯ menus, record pages, pop-ups and Communication layout.
They show fewer sections, never a different layout.
- **Communication** is called "Communication" in every portal (not "Inbox") and uses the manager
  layout: a left list card (Active | Archived tabs with counts, search, filter, gear, round
  compose), conversation rows with ⋯, and the thread with the real composer on the right.
- **Every list page has status tabs on the left and icon buttons on the right**, like manager
  Residents' Potential · Current · Past, using the buckets that fit the section (Services: Open ·
  Scheduled · Done; Payments: Due · Paid; Inspections: Move-in · Move-out; Jobs: New · Scheduled ·
  Done; Invoices: Draft · Sent · Paid).
- **No page title or subtext on list pages.** The header card is the first thing in the
  content area: no title above it ("Test accounts"), no explanatory paragraph, no footer
  summary ("4 total accounts across 3 workspaces"), no descriptive sentence repeated on rows.
  Settings pages keep their page title and scope chip; record pages keep their record header.
- **No summary cards on top of a list.** Balances, totals and explanations don't sit above
  the header card (e.g. no "Balance / Due now / Paid to date" block on resident Payments). The
  tabs and rows say it; account-level options like autopay live in Settings.
- Resident "My home" and inspection reports are **record pages** (header, grouped rail,
  label/value cards), not stacks of loose cards.
- ⋯ menus and pop-ups are never clipped: they render above the page and flip or shift to stay on
  screen.

## 1. Shell

- **Desktop:** left sidebar with the workspace switcher on top (the PropLane house mark on a
  blue tile, then workspace name and role, a chevron, and « to collapse), uppercase group
  labels, line icons, soft-blue active row, and nested items (Payments ▸ Incoming /
  Outgoing); "Need help?" at the bottom. Top bar on the right: "✦ Ask PropLane ⌘K" pill, then
  the avatar pill.
- **Avatar menu:** name, email · Settings · Appearance ☀/☾ · Sign out (red). Settings
  opens from here, never from the sidebar.
- **Phone:** header "WORKSPACE ⌄" in bold uppercase plus the avatar; bottom tabs (manager:
  Properties · Residents · Dashboard · Communication · More). More is active for every other
  section and opens a sheet grouped like the sidebar. A floating ✦ sits above the tabs.
  Nothing else is pinned.

## 2. List page (every tab that lists records)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Tab 3   Tab 0   Tab 0   🔍 Search <things>            [⚲] [page icons] [⚙]  (+) │
│ ▔▔▔▔▔                                                                          │
└──────────────────────────────────────────────────────────────────────────────┘
  [tile]  Title                                              figure        ⋯
          place line
          ◷ fact · ⌂ fact · ✓ fact
```

- **One header card:** text tabs with grey count pills (active = blue text + underline bar),
  inline borderless search, **icon-only** buttons, then the **round blue +**. The + is the only
  create action (no ADD footer as well, no empty-state button as well).
- **Header icons** are exactly the real page's: filter, page-specific (share link,
  availability, calendar sync, …), settings gear. No download/export icon in list headers.
- **Filters always live in the top-right Filter popover**, never as inline dropdown rows:
  an anchored card titled "Filter" with ✕, UPPERCASE field labels, pill selects, then Reset
  (blue text) and Save (blue pill). Active filters show as a dot or count on the icon.
- **Rows** (`PortalRecordListSurface`): tile · title · place line · glyph facts · figure · ⋯.
  No pills or status chips on rows (the tab is the status). The whole row opens the record.
- **⋯ menu:** a floating card whose heading is the record's name in grey, followed by the
  record kind's real actions in the real order (`src/lib/portals/record-action-order.ts`).
  Destructive actions are red and last. On phone it's a bottom sheet. Choosing an item closes the menu.
- **Empty:** icon tile plus one line; no match: "No matches" plus Clear search.

## 3. Record page (inside pages)

- **Header:** ‹ back · tile · title + place line · **icon-only actions** at the top right
  (primary = filled blue circle, then outline circles, red delete last). Actions follow the
  active section, per `src/lib/portals/record-sections.ts`.
- **Left rail:** groups with uppercase labels (PROPERTY / LEASING / OPERATIONS, or PAYMENT /
  LINKED), plain items, soft-blue active. List only sections that apply and have content;
  never a section whose page says "No service on this charge". On phone the rail becomes a
  section picker.
- **Content:** label/value cards (grey label left, bold value right, hairline rows) for
  facts; linked records as compact rows that open them; Communication as the embedded
  inbox thread with the real composer (attach · ✦ · channel ▾ · send), never a bare
  textarea; Activity as a timeline.
- **Edit** opens the real editor (a property opens the listing wizard, pre-filled), not a
  mini form.

## 4. Pop-ups (`PortalDialog`, see `ui-change-checklist.md` § Pop-ups)

White card, title plus ✕, a hairline, UPPERCASE field labels, pill inputs and selects ~56px,
a hairline, then a text secondary on the left and a filled primary on the right, labelled
with the outcome. Phone: a bottom sheet with a grab handle. Every button has a label.

## 4b. Create and edit flows (full-screen editor)

Every multi-field create or edit (Add property / listing editor, Schedule tour, Add resident,
Add applicant, Add lease, …) is the same **full-screen editor**, never a small modal:
- **Header:** title (+ status chip and address for an existing record), save state ("Not saved
  yet" / "Saved"), "✦ Ask PropLane", ✕.
- **Left column:** a drop card ("Add documents" / "Contact and tour") or cover photo; a "● N
  things to finish ›" card; the step list (title + one-line summary, red dot while
  required info is missing, the active step as a white card with a blue outline).
- **Centre:** a big step title, section cards with two-column fields (required *), and tile
  grids, radio cards, stepper rows or a "Start from a file" strip where the step needs them.
- **Right column:** "<THING> PREVIEW" (facts, with "Not set" for anything unset) and "THIS WILL
  CREATE" (✓ will happen · ! needs attention · – won't happen), and it must be true to what the
  commit really does.
- **Footer:** Back · "Step n of N" · a primary button naming the next step ("Continue to Home"),
  and on the last step the commit ("Add resident & send notice").
Small confirmations and single-field actions stay `PortalDialog` pop-ups (§4).

## 5. Settings

Opens inside the portal shell. On the left, a nav card headed by avatar, name and email,
then groups ACCOUNT / PORTFOLIO / OPERATIONS with icon rows. On the right, the page title
with an Account/Workspace scope chip, then section headings above cards of two-column
rows (label left, control right; read-only values as bold text). Changes save on blur with
a "Saved" tick. Account pages never depend on workspace permissions. Phone: a profile
card and grouped list cards (icon tile · label · ›), where each row opens its page with a
back arrow. Notifications is a read-only "What PropLane sends" list.

## 6. Dashboard

Keep the original layout: four KPI cards with sparklines, Needs attention and Upcoming,
Your properties cards, Cash flow, and Everything open. Additions only as questions.

## 7. Checks before handing over

Real tabs and labels (`src/lib/portals/*`); desktop and phone; empty, loading and error
states; no subtext; icon chrome; `tests/unit/portal-list-rows-no-pills.test.ts` and
`portal-dialog-shape.test.tsx` green. For plans: Before matches today (real screenshots)
and the mock kit's `check.mjs` / `tools/fidelity.mjs` reports are clean.
