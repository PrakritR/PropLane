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

- [x] **1 · Hero — Direction B "Night blue".** — `0d1a2b22`. Dark navy hero (`--pl-black`
  base with two blue radial glows and a dot grain), centered eyebrow + headline
  ("The AI does the busywork. / You approve." in white and `--pl-blue-soft`),
  subhead, CTAs: white primary "Start free — no card", outlined "Book a demo",
  the App Store badge; trust line "Free for one home · No card · Web and
  iPhone". Media: the real manager dashboard in a browser frame whose bar reads
  `prop-lane.space/portal/dashboard`, bleeding off the fold; an iPhone frame with
  the real phone dashboard overlapping bottom-right; one drafted-reply card
  floating bottom-left. Files: `site/hero.tsx`, `landing-proplane.css`,
  `public/marketing/product/{dashboard,phone-dashboard}.png`.
- [x] **2 · Communication scroll story** — `b8646773`. replaces `SiteBento` ("Six things").
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
- [x] **3 · App Store path.** — `0d1a2b22`, `13a36b35` (listing refresh still manual). Canonical URL
  `https://apps.apple.com/us/app/proplane/id6795707576` in
  `ios-app-download.ts`; one shared `AppStoreBadge` (footer's markup extracted)
  used in hero, /app, footer; `<meta name="apple-itunes-app">` in the public
  layout; `/app` rebuilt: headline, badge, requirements line, two phone frames
  with clean screenshots, a QR code (server-rendered with the existing `qrcode`
  dependency) for laptop visitors, four feature rows. App Store Connect asset
  refresh is manual (needs the captain's login) — tracked separately.
- [x] **4 · Menus.** — `e3d01238`. Product becomes a mega menu: "Who it's for" (managers,
  residents, vendors) · "What's inside" (Leasing, Payments & ledger, Inbox &
  work number, Ask PropLane) · featured iPhone app panel. Resources in two
  columns: Learn (Documentation, MCP & API, Security) · Company (Reviews, About,
  Contact & support). Top bar: "Sign in" link + "Start free" primary replace the
  single "Portal" button (signed-in users still see their portal link). Mobile
  sheet: accordion groups, even rows, Start free / Sign in / App Store pinned
  at the bottom. File: `layout/public-navbar.tsx`.
- [x] **5 · Minor fixes (13 checked).** — `c918ec65`. replaces-strip readable (13px chips,
  hidden < 380px); no assistant FAB on marketing pages; "Compare every feature"
  → `/pricing#compare`; proof footnote as a plain sentence; FAQ chevrons that
  rotate, first item open; footer social links verified or hidden; audience
  tabs swap the matching real screenshot; hero domain / six-things / app-mock /
  portal-cta / mobile-nav-gap / smart-banner covered by §1–§4.
- [x] **Verification.** — see evidence. Public smoke e2e green; Lighthouse a11y 100 kept on
  public pages; every menu/footer link resolves; badge → listing in desktop
  Chrome; 1440 + 390 walk of every public page, light and dark; tsc 0, unit
  green, no-mistakes, ff into `prakrit`, :3000 refreshed.

## Out of scope

Pricing table, /docs, /rent browse UI, anything behind sign-in, publishing the
app to more storefronts.

## Validation evidence

Built on `claude-2` on 2026-09-12, verified on `:3002` (this worktree's dev
server) before landing on `prakrit`:

- tsc: 0 errors. Unit: 1404 files / 9877 tests green after updating three
  source-pinned tests to the new menu wording, the canonical App Store URL and
  the `/pricing#compare` teaser link (`ios-app-download`, `public-navbar-
  resources-menu`, `marketing-audience-copy`); new `site-story-labels` test pins
  the story's control labels to the portal's. Lint: 0.
- Public smoke e2e (`public-home`, `public-tours`, `ladder-smoke`): 10 / 10
  green after the teaser-link expectation moved to `/pricing#compare`.
- Lighthouse (desktop): `/` accessibility 100 / best-practices 100 / SEO 100;
  `/app` 100 / 100 / 100. Two contrast findings from the first pass (inactive
  story steps at 40% opacity, small blue chips on light blue) were fixed by
  colouring inactive steps in the muted ink instead of dimming, and using
  `--pl-blue-deep` for the small chips.
- Walked `/`, `/pricing`, `/why-proplane`, `/partner`, `/vendors`, `/app`,
  `/reviews`, `/about`, `/contact`, `/docs`, `/security` at 1440 and 390: no
  page errors from this build; 19 distinct header/footer links all resolve.
  Product and Resources menus opened on desktop and in the phone sheet.
- `apple-itunes-app` meta renders (`app-id=6795707576, app-argument=…/app`);
  every App Store link on the site is the canonical
  `apps.apple.com/us/app/proplane/id6795707576`; the /app QR encodes the same.

Pre-existing, not from this build (left alone, reported): `/rent` itself is a
404 (the browse path is `/rent/browse`, which is what the menus link to), and
`/docs` overflows sideways at 390px on `prakrit` as well.

Deliberate deviations from the plan: the story frame is a faithful rendering of
the portal inbox/dashboard in the site's own components (labels pinned by test)
rather than mounting `portal-inbox-ui.tsx` itself, which pulls portal stores
into the marketing bundle; the audience-switch already swapped its mock per tab
(no change); the chat bubble is hidden only on the marketing routes and stays
on `/docs`, `/support`, `/rent` and the auth flow where a visitor has a question
in hand. The "Property Lane" naming note was never resolved — nothing renamed.

Still owed by a person: the App Store Connect icon + screenshot refresh.
