> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

# Listing syndication: Zillow Rental Network

**Scope: Zillow Rental Network only (Zillow · Trulia · HotPads), one feed per
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

## Registering the feed with Zillow

1. Open Settings → Integrations → Posting in the manager portal and copy the
   Zillow feed link (creates the feed on first read).
2. Submit that URL once to Zillow's Rental Network feed registration (covers
   Zillow, Trulia and HotPads together — there is no separate step per site).
3. Per listing, turn on "Also list on Zillow, Trulia and HotPads" from that
   listing's Review step. Zillow's crawl picks up the change on its own cycle
   (the row says "usually live within 24 hours").

## Agent tool

`listing_syndication_status` (`src/lib/tools/domains/properties.ts`, manager
`agentRegistry`) is READ-ONLY: whether a property is opted in and the feed's
last-known status/reasons. There is no write tool — per AGENTS.md's AI Agent
& Tool Layer contract, listing edits stay out of the agent until charge
generation and listing normalization move server-side, and toggling
syndication is a listing edit.
