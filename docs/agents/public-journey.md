# Public journey pages (prospect after a text)

Captain, Oct 18 2026: the pages someone reaches after texting the PropLane number wear the approved homepage
look (concept A, Swiss / International): Inter Tight, one blue `#2F5FD0`, ink, hairline rules, flat white
cards, square 3px corners, numbered section headers.

## Which pages

`isJourneyPath` (`src/components/public-site/journey-paths.ts`) is the one list:

| Route | What it is |
| --- | --- |
| `/rent/browse`, `/rent/w/<slug>` | Find a home: four dropdown filters (Budget, Move in by, Area, Room type) + search, flat cards |
| `/rent/listings/<id>` | The listing, photos first (`listing-gallery.tsx`: swipe strip on phone, lead + 4 grid and a full-screen viewer on desktop), numbered sections, sticky card / phone dock with Tour · Book (captain, Nov 12: no Monthly / Short stay control, no move-in or room pickers, no short-stay block on the listing) and, beside them, **Message** and **Text us** (§ Message and Text us). Each room's details carry the same two |
| `/rent/tours-contact` | Book a tour: day cells and time buttons over `listOpenTourSlots` with no account at all (captain, Nov 14: a guest gives name, phone, email and a time; the room is a dropdown defaulting to "not sure yet"), or the requested-time picker when the house has no open slot ([`tours-scheduling.md`](tours-scheduling.md) § Requested time). Its Message tab is the same Message form (a phone and a texted code, no account wall) |
| `/rent/apply` | The apply wizard inside `.ps` (palette re-pointed, no fork). No account wall (captain, Nov 14): the answers stay in the browser, and Submit asks the renter to prove a phone or mailbox (`GuestApplicationVerify`) |
| `/l/<token>`, `/apply/<code>`, `/tour/<code>`, `/start/<token>` | Phone-bound doors (expired, code gate, phone bind, rent card, finish setup, personal account link) |

The `gallery` link purpose still redirects to `/rent/listings/<id>`; that page now leads with the photos.
The auth screens (`AuthSplitShell`) use the same font and tokens, with a full-bleed blue art panel. That panel also carries the
PropLane line (captain, Nov 15: publish the number widely), on every screen it is drawn on (auth, invite, MCP): the
configured number from `getPublicTextingConfig()` under "Text us", as an `sms:` link and never `tel:`; with none
configured, or on a failed read, the heading stands alone and the rest of the panel stays decorative (`aria-hidden`).

## How it is built

- `src/components/public-site/public-site.css` holds every token and shared class, scoped under `.ps`.
  `.ps` also re-points the app palette (`--primary`, `--pl-*`, radii, `--font-sans`), so a shared component
  (Button, inputs, the apply wizard) restyles inside a journey page and nowhere else. Restyle through that
  scope; do not fork a shared component for the public look. Portals never carry `.ps`.
- One chrome, two layouts: `PublicShell` (`src/components/layout/public-shell.tsx`) holds the `PublicNavbar` /
  `PublicFooter` for both the `(public)` layout (homepage, phone-bound doors) and the `(rent)` layout. No
  route-specific chrome fork.
- **`/rent` is the WEB channel; the one number it may carry is the configured PropLane line, only in "Text us"**
  (captain, Nov 12; replaces the Oct 20 rule that /rent carried no number). Tour and Apply need NO account (captain, Nov 14, overriding the Oct 20 / Nov 3 account-first rules; see below) and carry no number. The `(rent)` layout keeps the chrome (navbar,
  footer) on an EMPTY texting snapshot, so no number reaches the menu or the footer, and passes the real
  `getPublicTextingConfig()` snapshot only to the page CONTENT through a nested `PublicTextingProvider`. A /rent page
  therefore shows exactly one number, from that config and never a literal; `sms:` appears only on the Text us control
  (`ListingTextUsLink`) and never `tel:`; with no number configured Text us is not drawn and the page carries no number
  at all. Guard: `tests/unit/rent-web-channel.test.tsx`.
- **Guest tour and guest apply (captain, Nov 14: renters from Facebook, Zillow and Roomies book and apply with NO account).**
  *Tour:* `POST /api/public/partner-inquiries` accepts `kind:"tour"` with no session. It rate-limits per IP and per phone, re-derives the home
  from the database (`loadGuestTourListing`: a LIVE listing; the body never names an owner or a status), files through the one
  `createTourInquiry` (`guestApplicant`, the published-slot and double-book checks unchanged) with the `sms` notice channel and a server-owned
  `guestTour` flag, and records the prospect on the spine (`recordGuestTourProspect`, an UNVERIFIED phone identity, source `tour`, no ops alert).
  Confirmation goes by `notifyGuestTourConfirmed` (email + text, never a /resident link). A signed-in resident keeps the account path. A tour fee
  is raised only for an account, as for an SMS prospect.
  *Apply:* the wizard keeps no server row for a guest. Submit stores the finished draft (`POST /api/public/application-drafts`, table
  `guest_application_drafts`: SHA-256 of an unguessable token only, 24 h, body wiped on claim), then the renter proves a phone (the phone sign-in
  door, `intent: resident_signup`, which creates the phone-only resident only after the code) or a mailbox (the emailed `token_hash` link through
  `email-onboarding/start`, destination decided by the server). The resident portal's apply page claims the draft
  (`POST /api/resident/application-drafts/claim`: the session's CONFIRMED email or VERIFIED phone must be the one the draft names; the token and
  property id are only lookup keys) and submits it through the ordinary signed-in write, so the pre-apply gate (`preApplySubmitGate`), the fee gate and
  every other submit check still run. No account exists before proof.
  *Text me a link* (captain, Nov 14: accounts ideally, plus the SMS link system): a third proof on apply, and the primary account step on a guest tour
  that ticked the SMS box. `POST /api/public/guest-signup-link` texts a single-use phone-bound `account` link (`target_type` `guest_apply` /
  `guest_tour`, hash only, 2 h) to the phone ALREADY on the held draft or the guest tour (the request never names a phone), from the home's workspace
  line as a control text (STOP wins). `/l/<token>` only draws a Continue button; `POST /api/l/<token>/guest-signup` spends it, and opening it IS the
  phone proof (`completeGuestSignup`: a phone-only resident with the phone VERIFIED, or the one existing account on that phone through
  `smsProvenSessionAllowed`, never a second; a tour is linked to it) and lands on the apply page, which claims the draft as above. Guard:
  `tests/unit/guest-signup-link.test.ts`.
- **Message and Text us** (design-1112 §1, §5). *Message* is the third action in the card and the phone dock and
  "Message about this room" in each room's details (never inside a manager's own preview). It opens
  `ListingMessageSheet` (`listing-message-sheet.tsx`, `.ps` classes, no email field, no subtext): message, phone, optional
  first name -> six-digit code texted to that phone -> sent. It needs NO account: `POST /api/public/listing-message`
  (`send_code` / `verify_send`) rate-limits by IP, phone and property, checks the code (`phone_otp_challenges`, purpose
  `listing_message`, bound to the home), re-derives the workspace and owner from the home (a live listing; a room must be one
  of its rooms), records consent, and stores the message exactly as typed through the prospect spine
  (`recordInbound`, source `listing_message`, a VERIFIED phone identity) so it reaches the manager's Communication
  inbox stamped with the home and room. No answer says whether the phone already has an account. A signed-in visitor whose
  verified phone is the one typed skips the code. The sent state offers "Create account" and "Text us".
  *Text us* is an `sms:` link to the configured line with a prefilled body (`textUsBody`: the home, the room, then the
  home's entry code in parentheses, which is how the inbound router knows the home); the code is the home's active
  `sms_entry_codes` row, created once lazily by `GET /api/public/listing-message?propertyId=` (CDN-cacheable).
  A /rent page is still the web channel for everything else: pages and their CDN headers are unchanged, and the Message
  form is a client island that only calls the route when a button is pressed.
- **Quick chat** (captain, Nov 15; `WebChatLauncher` on every `/rent/listings/<id>`, `POST|GET /api/public/web-chat`, `src/lib/web-chat/`): the first thing a listing visitor can do, with NO account and NO phone code to start. The visitor is a random id in a signed httpOnly cookie (`pl_wc`, `visitor-session.ts`; a bad, expired or foreign cookie is "no visitor", re-signed weekly with the same id) and nothing else identifies them; the home, workspace and owner are re-derived from the listing id (`loadMessageListing`), never the body. A message is `recordInbound` as `channel in_app`, `source web_chat`, a HANDLE identity (`web_<id>`) tagged house and room; the reply is the SMS leasing agent's own registry and write allow-list (`runLeasingWebAgentTurn`, read tools + `escalate_to_manager` + `request_tour`), credit reserved before the model and handed back when nothing is produced, held by the manager's approval setting. Caps: per IP, visitor (hour and day) and home, 1000 characters, a honeypot; a visitor's text renders as plain text, only assistant/team replies link and only to this site. A phone typed in chat only OFFERS the texted code; the thread merges into that phone's (`stitchByPhone`, the one merge) only after the code proves it, after which the visitor writes as that phone and a text from it to the (206) line continues the thread. The phone step carries the shared `SmsConsentCheckbox` (unchecked by default, § Web opt-in consent in [`sms-system.md`](sms-system.md)): the code proves the phone for that merge, and only the visitor's own tick records an SMS opt-in (`recordOptIn(..., "web-chat")`). Team replies reach the open chat by a coalesced poll of the visitor's own session thread (id, role, text, time only; no staff names, notes or ids). A signed-in account sees "Open your assistant" (the portal's own top-bar assistant), never a second floating button inside a portal. Guard: `tests/unit/web-chat-*.test.ts`. Not yet on `/rent/browse` (no home to route to).
- **Personal account link** (`/l/<token>`, purpose `account`, `src/lib/personal-link/`): the link a message or a text hands
  back. A phone-bound link (hash stored, 14 days, replaces its predecessor, single use) that needs no code step because it only
  ever reaches a phone that already proved itself. The page (`PersonalAccountForm`) asks for a name and an optional email
  (a claim, never the login); `POST /api/l/<token>/account` provisions the phone-only resident account (or signs in the one
  existing phone-only account), links it to its history with `linkAccountToProspectRecord`, and lands it in
  `/resident/communication`. An account with stronger credentials is sent to the ordinary sign-in.
- Photos: real ones only; `NoImagePlaceholder` when a listing has none. The page reads the same public
  projection (`publicListingProjection`), which no longer publishes `contactSmsPhone` — only a server-only
  syndication caller opts the work number back in.
- The map pin is geocoded server-side and ZIP-verified (`listing-geocode.server.ts`, and
  `GET /api/listing-geocode?propertyId=` for the second half of a cold load): a street hit counts only inside
  the listing's own ZIP, the fallback is that ZIP's centroid, and a listing with no ZIP draws the neutral
  fallback centre — never a city centre, and never the free-text `/api/geocode` match.
- **A room's availability is computed from live occupancy, never read from the saved string** (plan
  `channels-sync-1027`). The catalog (`getPublicListings`) carries the label `applyLiveRoomAvailability` wrote, so a
  leased room never says "Available now". A room freeing within 60 days reads "Available <date>"; a room leased
  longer reads "Leased until <date>" on its listing page and is left off the browse card; one closed with no end is
  "Not available". The listing page itself states an open or opening room in the "open now" wording ("Open now" /
  "Opens <date>"), and any count of what is open counts rooms open today. Full rules, that one count and the guards:
  [`bookings.md`](bookings.md) § Channels: true availability.
- Room type on browse derives from `listingSubmission.listingPlaceCategoryId`; an option shows only when some
  loaded listing has it.

## Homepage integration

The duplicate journey top bar, footer and chrome switch were removed when merged
with the homepage. Journey content keeps the scoped `.ps` styles and Inter Tight
font; navigation and the ink-blue footer come from the shared public layout.
