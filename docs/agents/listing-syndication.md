> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

# Listing syndication: listing sites

> **Scope widened (2026-10-06): official APIs and feeds only, never scraping.**
> The Zillow feed below is one channel of the "Listing sites" registry
> (§ Listing sites: the channel registry). Everything below that section about
> the Zillow feed is unchanged.

**The Zillow Rental Network channel (Zillow · Trulia · HotPads), one feed per
WORKSPACE, registered once with Zillow (W013).** Each listing opts in
individually from its Review step. There is no Apartments.com feed, no lead
ingestion (leads already arrive through tour requests + the inbox, same as
every other prospect channel), and no key-regeneration flow.

**W013 — per-workspace feeds.** A manager account may hold several
`portal_workspaces`; the feed used to be scoped by `manager_user_id` alone, so
a multi-workspace manager's single feed mixed every workspace's listings.
`manager_syndication_feeds` now carries `workspace_id`
(`supabase/migrations/20260927134258_listing_syndication_per_workspace.sql`,
additive, service-role only), unique on `(manager_user_id, workspace_id)`. A
pre-existing single feed keeps its exact `feed_key` — never regenerated — and
was backfilled onto that manager's DEFAULT workspace
(`ensure_default_portal_workspace`), so a URL already registered with Zillow
keeps working, now scoped to that workspace's listings. A second (or shared)
workspace gets its own feed, created lazily on first read.

## The feed is a projection of the public payload, nothing more

`src/lib/listing-syndication/zillow-feed.ts` is a pure function that maps an
array of `publicListingProjection` outputs (`src/lib/public-listings.server.ts`
— see `docs/agents/lease-generation.md` § "the public payload is an explicit
allowlist") to Zillow's HotPads-schema XML. It takes **only** that projected
shape. A third party crawls this feed with no PropLane credential, so it is
exactly as anonymous as `/api/property-records/public` — never widen it to
read the raw stored listing.

Two fields the wizard collects (`city`, `state`) are excluded from
`publicListingProjection` and therefore genuinely unavailable to this feed.
The mapper falls back to the public `neighborhood` for `<city>` and derives
`<state>` from the public ZIP via a small USPS ZIP3-prefix table
(`stateFromZip`). Both are documented, deliberate approximations — not a
second path around the allowlist. Do not touch `publicListingProjection`
itself to "fix" this; that decision belongs to whoever owns the allowlist.

## Opt-in state lives on the submission, not a new column

`syndication?.zillow` sits on `ManagerListingSubmissionV1`
(`src/lib/manager-listing-submission.ts`) — the same JSONB blob every other
listing field already round-trips through on the existing wizard save path.
It is manager-internal operational state, not marketing copy, so it is
**deliberately not** on `PUBLIC_SUBMISSION_KEYS`. There is no parallel SQL
column mirroring it: the feed route reads the raw stored row (before
projecting) to decide which listings are opted in, then hands only the
projected shape to the XML mapper.

```ts
syndication?: {
  zillow?: {
    enabled: boolean;
    sentAt?: string;             // ISO timestamp of the most recent opt-in
    status?: "sent" | "live" | "rejected";
    reasons?: string[];          // why the feed excluded it, e.g. "no_photo"
  };
};
```

Turning the Review step's toggle on writes this through the wizard's existing
save path — there is no second save path. `status`/`reasons` are written by
this wave's toggle only (`status: "sent"` on opt-in); nothing yet closes the
loop from Zillow back to `"live"`/`"rejected"` — that is a real gap, not an
oversight, and is a separate future task (a webhook or a poll from Zillow's
side would set it).

## Exclusion, never a placeholder

A listing missing a street address or a real, already-uploaded photo (whole-
home `housePhotoDataUrls`, falling back to room photos for a by-room /
shared-home listing) is left OUT of the feed entirely — see
`docs/agents/marketing-mocks.md` and the top-level "never fabricate a photo"
rule. The Review step computes the same two checks live (`listingReadiness`'s
sibling `zillowSyndicationGapStep` in `listing-editor.tsx`) so the manager sees
"Not accepted · fix the items below" instantly, without waiting on a feed
fetch.

A by-room (shared-home) listing becomes ONE `<Listing>` — priced at its
cheapest currently-priced room, photographed from that room (or the house) —
not one `<Listing>` per room. Zillow's schema does not model co-living well;
splitting per room is future work if it turns out to matter.

## The feed route

`GET /api/feeds/zillow/[feedKey]` (`src/app/api/feeds/zillow/[feedKey]/route.ts`)
is anonymous, keyed by an opaque `feed_key` from `manager_syndication_feeds`
(never the manager's user id or workspace id — the URL alone reveals no
identity). It looks up the feed row (now also reading `workspace_id`) with the
service-role client, 404s on an unknown or disabled key, then intersects
`getPublicListings()` (already sandbox-filtered, contact-resolved, projected)
with `zillowEnabledPropertyIds`'s id set — a raw `manager_property_records`
query filtered to `manager_user_id` AND `workspace_id` — before mapping to
XML. `publicListingProjection` carries neither `syndication` nor `workspaceId`
(both excluded from the public allowlist), so the workspace scoping happens
entirely through that pre-computed id set, never by filtering the projected
listing itself. `Content-Type: application/xml`, `Cache-Control` matches the
other public listing reads (`public, s-maxage=60, stale-while-revalidate=600`).

`manager_syndication_feeds` (`supabase/migrations/20260920203000_listing_syndication.sql`,
`20260927134258_listing_syndication_per_workspace.sql`) follows
`manager_house_public_links`'s shape exactly: service-role only, `revoke all
... from anon, authenticated`. The manager-facing settings row lives on
Settings → Integrations → Posting, owned by
[`integrations.md`](integrations.md); it reads/creates the feed through
`GET /api/manager/syndication-feed`, an authenticated route that resolves the
caller's ACTIVE workspace (`resolveWorkspaceFromSettingsRequest` — explicit
`?workspaceId=`, else the workspace-switcher cookie, else the viewer's own
default) and keys the feed to that workspace's OWNER, never the viewer's own
id when a co-manager is acting in a shared workspace. Regenerating the key is
out of scope — a manager who already handed this exact URL to Zillow would
break that registration.

`ZILLOW_FEED_APPROVED=1` (deployment-wide, read only in the listing-channels GET route) marks Zillow's feed approved. Until it is set, every surface has to say the same thing: the guide's mode line reads "Posts for you once Zillow approves · by hand until then" above its by-hand steps, and the Listing sites row carries the same by-hand fact as a manual channel (`Posted by you · <date>` / `Not posted yet`), never the feed-queued count. Once it is set the guide drops the by-hand steps and shows only the status table, and the row reads `Posts for you · N of M listings`.

## Registering the feed with Zillow

1. Open Settings → Integrations → Posting in the manager portal and copy the
   Zillow feed link (creates the feed on first read).
2. Submit that URL once to Zillow's Rental Network feed registration (covers
   Zillow, Trulia and HotPads together — there is no separate step per site).
3. Per listing, turn on "Also list on Zillow, Trulia and HotPads" from that
   listing's Review step. Zillow's crawl picks up the change on its own cycle
   (the row says "usually live within 24 hours").

The draft answers for Zillow's Rentals Feed application form — the field map it
asks for, which questions we deliberately leave as "confirm on application",
and what to do after approval — are kept in
[`docs/ops/zillow-feed-application.md`](../ops/zillow-feed-application.md).
That file is the application worksheet; the code facts it cites stay owned here.

## Agent tool

`listing_syndication_status` (`src/lib/tools/domains/properties.ts`, manager
`agentRegistry`) is READ-ONLY: whether a property is opted in and the feed's
last-known status/reasons. There is no write tool — per AGENTS.md's AI Agent
& Tool Layer contract, listing edits stay out of the agent until charge
generation and listing normalization move server-side, and toggling
syndication is a listing edit.

## Listing sites: the channel registry

`src/lib/listing-channels/` is the one registry of where a listing can be
advertised. Every channel has one **posting mode** (`posting` in
`registry.ts`), and the UI is one flat list of 16 rows in reach order (`order`,
`listingChannelsOrdered()`), no groups and no sub-tabs, in property
**Promotion › Listing sites** and the overall **Promotion › Listing sites** view
(there is no rail tab). A row (glyph, name, plain-text fact, chevron) opens that
site's guide (`listing-site-guide.tsx`) in the drawer/dialog.

| Posting mode | Channels | How it works |
| --- | --- | --- |
| `feed` | Zillow Rental Network | Nothing is pushed; Zillow's crawler reads the workspace feed. The guide shows every listing's own state ("Posting" / "Off" / its hold reason) and the per-listing switch. |
| `manual` | Facebook Marketplace, Facebook Groups, Craigslist, SpareRoom, Roomies, Roomster, Zumper and PadMapper, Apartments.com, Redfin (via Rent.), Furnished Finder, Nextdoor, Reddit | The site forbids automation. The guide: create an account, copy the post (and download photos), post it, mark it posted (optional ad link). Row fact: "Posted by you · Oct 8" or "Not posted yet". |
| `api` | Facebook Page, Instagram (Meta Graph API) | PropLane posts for the manager once Meta approves the app (per-listing switch in the guide). Until then the row says "Coming soon · post by hand for now" and the guide has the by-hand steps. |
| `partner_only` | Apartment List | Takes partner feeds only. The row says "Partner feed only"; the guide shows one "Nothing to post" block. |

Rows are ordered Zillow, Facebook Marketplace, Facebook Groups, Craigslist,
SpareRoom, Roomies, Roomster, Zumper and PadMapper, Apartments.com, Redfin,
Apartment List, Furnished Finder, Nextdoor, Reddit, Facebook Page, Instagram.
**Redfin (`redfin_rent`) and Reddit (`reddit`) were added; Google Business
Profile and LinkedIn were removed** (they cannot advertise a rental). Their
partner contacts live on in `RETIRED_PARTNER_CONTACTS` in the registry, for an
admin to read there; the Listing sites API ships no partner contacts. Availability: `feed` and `manual` are `live`, `api` is
`live` only when Meta is live, `partner_only` is `partner_only`; there is never a
"Coming soon"-only dead row.

### The guide schema

Each `ListingChannelDef` carries `guide: { how, signupUrl?, signupNote,
createUrl?, createNote, cost, rules[] }`, rendered verbatim by
`ListingSiteGuide` (the copy comes from the approved studio plan
`listing-sites-guides-1008`). Steps: 1 Create an account (new tab,
`rel="noopener noreferrer"`), 2 Copy your post (post preview, Copy and
Download photos icon actions; photos come from
`/api/manager/listing-channels/photos?propertyId=`, any workspace member who
can see the listing, host-allowlisted, one photo in memory at a time under a
40 s deadline inside the route's `maxDuration`; entries are numbered by the
listing's own photo order, and a zip short of the listing's photos says so with
`X-Photos-Partial: <fetched>/<total>` and a `-photos-partial.zip` name rather
than passing for a complete short listing), 3 Post it, 4 Mark as posted
(`POST /api/manager/listing-channels/mark-posted`, owner only, optional
`postedUrl` stored in `listing_channel_posts.posted_url` and surfaced back as
the step's "Open ad" link). It ends with "Keep the account
safe" (`rules`). Workspace mode has a listing picker (newest listing by
default); the property panel binds the guide to its listing. The guide shows
"<n> leads from this site" from `leadCounts[channelId]` on
`GET /api/manager/listing-channels` (`leadCountsByChannel`).

### The `?src=` tag

Every post's listing link is tagged `?src=<channelId>`
(`taggedListingLink` in `post-text.ts`), so a lead that arrives through a posted
ad can be traced to the site. The link line is never trimmed. `GET
/api/manager/listing-channels?propertyId=` returns a built `postTexts` entry
for every channel that is posted by hand. The Zillow feed's own `listingUrl`
carries no tag yet, so Zillow leads are not counted — a deliberate follow-up,
tracked in the ops worksheet linked above.

The allowlist `normalizeLeadSource` checks is **derived** from
`LISTING_CHANNEL_DEFS` (`LEAD_SOURCE_CHANNEL_IDS`), never hand-listed, so a new
site is tagged and counted the moment it is in the registry. `pl_src` is a
first-party cookie written by the public listing page itself
(`ListingSourceCapture`), 30 days, `SameSite=Lax`, `Secure` on https (omitted on
http so a localhost lane still records a tag). Only the applicant-facing write
stamps `source_channel`: a manager-initiated create or draft save is never credited to
whatever tagged link that manager happened to open. `source_channel` and
`posted_url` are the only thing their migration adds, so each write retries once
without the column (`isMissingColumnError`) rather than failing the applicant's
submission (draft save included), the tour request or the manager's "Mark as
posted"; the Listing sites GET reports `schemaReady: false` instead. A write
path that wraps the failure in its own `Error` must pass the original along as
`cause`, or its prefix hides what the database actually said.

### "Listed with PropLane"

The line itself is unchanged — `buildListingPostText` appends it when the
workspace setting says to, and it is never trimmed. The **switch** is no longer
a row in the Listing sites view: it moved to Settings › Integrations › Posting,
owned by [`integrations.md`](integrations.md) § Posting.

**Never scraping, never headless or browser-driven posting, anywhere.** A site
with no official API or feed is `manual` or `partner_only`, full stop.

### One post builder

`buildListingPostText` (`post-text.ts`) is the only place post text is made. It
reads **`publicListingProjection` output only** (headline, address, price, beds,
baths, rooms, a few quick facts, the first sentences of the overview, the
public listing link) plus the workspace **work number and work email**
(`resolveActiveManagerSendNumber` / `resolveActiveManagerWorkEmail`, server
side, never the stored blob's copy). **No work number: nothing is built**, the
row says "Set up work number". The same holds for the Zillow feed (a listing
with no work number is excluded with reason `no_work_number`) and for flyer /
promotion text (`promotionWorkContactLine`: work number plus work email, empty
without a number, never PropLane's support line or a personal phone). Pinned
across every channel by `tests/unit/listing-posts-work-number.test.ts`. Each channel trims the body to its own limit and
never cuts the link or contact lines.

### Eligibility: held with a reason, never a placeholder

`listingChannelEligibility` holds a listing with no street address or no real
(https) photo. The row says "Held: no photo" / "Held: no street address".
Instagram cannot publish without a photo, so the same rule covers it.

### State and the queue: `listing_channel_posts`

One row per (property, channel) (`20261006120000_listing_channel_posts.sql`):
`enabled`, `state` (`pending | posting | posted | held | failed | off |
posted_by_me`), `pending_action` (`publish | update | unpublish`),
`external_id`, `last_error`, `content_hash`, `attempts`, `next_attempt_at`,
plus `posted_url` (`20261008180000_listing_lead_source.sql`, the ad link the
manager pasted when marking a by-hand post as posted).
The row is both the record and the queue.

* **RLS:** client roles may only `SELECT` their own rows
  (`manager_user_id = auth.uid()`). Every write is a server route on the
  service role, owner-of-workspace only, with the property re-derived from the
  stored record (`propertyInWorkspace`); an id in a body is never authorization.
* `listing_channel_connections` holds the long-lived Meta Page token,
  `data-encryption` envelope (same pattern as the Google calendar tokens),
  service-role only (no client grant at all).
* **Triggers:** `POST /api/property-records` (save, publish, unpublish, delete)
  calls `scheduleListingChannelSync` after the write: it queues publish /
  update (the content hash changed, e.g. a price change) / unpublish, then
  drains the queue off the request path. `GET /api/cron/listing-channel-posts`
  (every 5 minutes) retries with exponential backoff and gives up after 5
  tries. A failure there never fails the save.
* **Facebook Page:** photo post (`POST /{page-id}/photos`, caption = the built
  text). Update = delete + repost (a photo post's caption is not editable).
  Unpublish = `DELETE /{post-id}`.
* **Instagram:** media container + `media_publish`; needs a photo. The API
  cannot edit or remove a post, so update and unpublish record that and say so
  on the row.
* A token Meta rejects (code 190) marks the connection revoked and the row says
  "Reconnect Facebook"; it does not retry.

### Meta availability and env

Facebook Page and Instagram are **Coming soon** unless `META_APP_ID` and
`META_APP_SECRET` are set **and** `META_APP_LIVE=1`. A development-mode Meta app
works only for the app's own admins, so a dev server may set the flag to test
with its own Page; production leaves it unset until Meta's Business Verification
and App Review approve PropLane.

| Env | Meaning |
| --- | --- |
| `META_APP_ID`, `META_APP_SECRET` | The Meta app. Also key the signed OAuth state and the data-deletion `signed_request`. |
| `META_APP_LIVE` | `1` turns the channels on. |
| `META_GRAPH_VERSION` | Optional, default `v21.0`. |
| `META_REDIRECT_ORIGIN` | Optional: the origin registered as the OAuth redirect (local dev). |

Routes: `GET /api/integrations/meta/connect` (OAuth dialog, scopes
`pages_manage_posts pages_read_engagement pages_show_list instagram_basic
instagram_content_publish`), `GET /api/integrations/meta/callback` (signed
state, 15 minutes, same signed-in manager, owned workspace),
`POST /api/integrations/meta/disconnect`, and Meta's required
`POST /api/integrations/meta/data-deletion` (verifies `signed_request` with the
app secret, deletes that Meta user's tokens and posting rows, answers `{ url,
confirmation_code }`; the status page is `/integrations/meta/data-deletion`).
Register those two URLs in the Meta app. Coverage:
`tests/unit/listing-channels-*.test.ts`, `meta-oauth-state.test.ts`,
`meta-data-deletion.test.ts`, `listing-channel-posts-rls.test.ts`,
`listing-sites-panel.test.tsx`.
