# Public site round 2 — hero, communication story, App Store, menus (approved build)

Prakrit approved this plan in Lavish session `ebf6181b4cb83816` on 2026-09-12
("Approved — build the adopted sections and checked fixes on claude-2, land on
prakrit for review", then "build approved"). Built on keeper `claude-2` from
`b6085cd6` (the shipped public site), landed on `prakrit` for review on :3000.
The rendered plan (references, mocks, before/after) lives at
`.lavish/site-round-2/plan.html` in the `proplane-claude-2` worktree (gitignored).

Rules: one slice = one commit + push + ticked item; tsc 0 and unit green on the
tip; public smoke e2e green; every marketing screenshot comes from dev/test seed
data with setup nudges dismissed and no dev badge; nothing behind sign-in
changes. Brand name stays **PropLane** (the "Property Lane" note was never
resolved — ask before renaming anything).

## Completion checklist

- [ ] **1 · Hero — Direction B "Night blue".** Dark navy hero (`--pl-black`
  base with two blue radial glows and a dot grain), centered eyebrow + headline
  ("The AI does the busywork. / You approve." in white and `--pl-blue-soft`),
  subhead, CTAs: white primary "Start free — no card", outlined "Book a demo",
  the App Store badge; trust line "Free for one home · No card · Web and
  iPhone". Media: the real manager dashboard in a browser frame whose bar reads
  `prop-lane.space/portal/dashboard`, bleeding off the fold; an iPhone frame with
  the real phone dashboard overlapping bottom-right; one drafted-reply card
  floating bottom-left. Files: `site/hero.tsx`, `landing-proplane.css`,
  `public/marketing/product/{dashboard,phone-dashboard}.png`.
- [ ] **2 · Communication scroll story** replaces `SiteBento` ("Six things").
  Four steps on the left (prospect texts · resident reports a repair · vendor
  asks a question · you approve), a sticky product frame on the right that
  switches with the step in view (IntersectionObserver; reduced-motion and
  phones stack). Steps 1–3 render the portal inbox as it ships: conversation
  list, thread with EMAIL/TEXT chips, the "Draft with AI · Ask PropLane ·
  Schedule for later" row, the In-app/Email/Text segment with "Sending as …",
  the AI draft in the composer with the send button. Step 4 renders the
  dashboard's "AI drafts · Pending approval" group with Approve / Discard.
  Copy is fixture data; a unit test pins the story's control labels to the
  portal's. Ends with the "Also inside …" line. Files: new `site/story.tsx`,
  `(public)/page.tsx`.
- [ ] **3 · App Store path.** Canonical URL
  `https://apps.apple.com/us/app/proplane/id6795707576` in
  `ios-app-download.ts`; one shared `AppStoreBadge` (footer's markup extracted)
  used in hero, /app, footer; `<meta name="apple-itunes-app">` in the public
  layout; `/app` rebuilt: headline, badge, requirements line, two phone frames
  with clean screenshots, a QR code (server-rendered with the existing `qrcode`
  dependency) for laptop visitors, four feature rows. App Store Connect asset
  refresh is manual (needs the captain's login) — tracked separately.
- [ ] **4 · Menus.** Product becomes a mega menu: "Who it's for" (managers,
  residents, vendors) · "What's inside" (Leasing, Payments & ledger, Inbox &
  work number, Ask PropLane) · featured iPhone app panel. Resources in two
  columns: Learn (Documentation, MCP & API, Security) · Company (Reviews, About,
  Contact & support). Top bar: "Sign in" link + "Start free" primary replace the
  single "Portal" button (signed-in users still see their portal link). Mobile
  sheet: accordion groups, even rows, Start free / Sign in / App Store pinned
  at the bottom. File: `layout/public-navbar.tsx`.
- [ ] **5 · Minor fixes (13 checked).** replaces-strip readable (13px chips,
  hidden < 380px); no assistant FAB on marketing pages; "Compare every feature"
  → `/pricing#compare`; proof footnote as a plain sentence; FAQ chevrons that
  rotate, first item open; footer social links verified or hidden; audience
  tabs swap the matching real screenshot; hero domain / six-things / app-mock /
  portal-cta / mobile-nav-gap / smart-banner covered by §1–§4.
- [ ] **Verification.** Public smoke e2e green; Lighthouse a11y 100 kept on
  public pages; every menu/footer link resolves; badge → listing in desktop
  Chrome; 1440 + 390 walk of every public page, light and dark; tsc 0, unit
  green, no-mistakes, ff into `prakrit`, :3000 refreshed.

## Out of scope

Pricing table, /docs, /rent browse UI, anything behind sign-in, publishing the
app to more storefronts.

## Validation evidence

Pending implementation.
