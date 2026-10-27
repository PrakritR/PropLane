# Public journey pages (prospect after a text)

Captain, Oct 18 2026: the pages someone reaches after texting the PropLane number wear the approved homepage
look (concept A, Swiss / International): Inter Tight, one blue `#2F5FD0`, ink, hairline rules, flat white
cards, square 3px corners, numbered section headers.

## Which pages

`isJourneyPath` (`src/components/public-site/journey-paths.ts`) is the one list:

| Route | What it is |
| --- | --- |
| `/rent/browse`, `/rent/w/<slug>` | Find a home: four dropdown filters (Budget, Move in by, Area, Room type) + search, flat cards |
| `/rent/listings/<id>` | The listing, photos first (`listing-gallery.tsx`: swipe strip on phone, lead + 4 grid and a full-screen viewer on desktop), numbered sections, sticky card / phone dock with Book a tour · Apply (Request to book on the Short stay segment) |
| `/rent/tours-contact` | Book a tour: day cells and time buttons over `listOpenTourSlots`, or the requested-time picker when the house has no open slot ([`tours-scheduling.md`](tours-scheduling.md) § Requested time) |
| `/rent/apply` | The apply wizard inside `.ps` (palette re-pointed, no fork) |
| `/l/<token>`, `/apply/<code>`, `/tour/<code>`, `/start/<token>` | Phone-bound doors (expired, code gate, phone bind, rent card, finish setup) |

The `gallery` link purpose still redirects to `/rent/listings/<id>`; that page now leads with the photos.
The auth screens (`AuthSplitShell`) use the same font and tokens, with a full-bleed blue art panel.

## How it is built

- `src/components/public-site/public-site.css` holds every token and shared class, scoped under `.ps`.
  `.ps` also re-points the app palette (`--primary`, `--pl-*`, radii, `--font-sans`), so a shared component
  (Button, inputs, the apply wizard) restyles inside a journey page and nowhere else. Restyle through that
  scope; do not fork a shared component for the public look. Portals never carry `.ps`.
- One chrome, two layouts: `PublicShell` (`src/components/layout/public-shell.tsx`) holds the `PublicNavbar` /
  `PublicFooter` for both the `(public)` layout (homepage, phone-bound doors) and the `(rent)` layout. No
  route-specific chrome fork.
- **`/rent` is the WEB channel and carries no number** (captain, Oct 20): a request made on the website is
  answered on the website. `/rent/*` lives in its own `(rent)` route group whose layout passes an EMPTY texting
  snapshot, so the number and the `sms:` href never reach a /rent payload — not in the footer, the menu, the
  listing card or the tour grid — and every listing action (Book a tour, Apply, Request to book, Message the
  manager) goes through a resident account into the resident portal. Guard:
  `tests/unit/rent-web-channel.test.tsx`. Elsewhere the number is `getPublicTextingConfig()` (server, cached;
  null unless the line is in captain-approved `shared` or `shadow` mode) via `usePublicTexting()` — never a
  literal, and with no number "Text us" is not drawn.
- Photos: real ones only; `NoImagePlaceholder` when a listing has none. The page reads the same public
  projection (`publicListingProjection`), which no longer publishes `contactSmsPhone` — only a server-only
  syndication caller opts the work number back in.
- The map pin is geocoded server-side and ZIP-verified (`listing-geocode.server.ts`, and
  `GET /api/listing-geocode?propertyId=` for the second half of a cold load): a street hit counts only inside
  the listing's own ZIP, the fallback is that ZIP's centroid, and a listing with no ZIP draws the neutral
  fallback centre — never a city centre, and never the free-text `/api/geocode` match.
- Room type on browse derives from `listingSubmission.listingPlaceCategoryId`; an option shows only when some
  loaded listing has it.

## Homepage integration

The duplicate journey top bar, footer and chrome switch were removed when merged
with the homepage. Journey content keeps the scoped `.ps` styles and Inter Tight
font; navigation and the ink-blue footer come from the shared public layout.
