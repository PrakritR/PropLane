# Zillow Rentals Feed application (draft)

Draft answers for Zillow's Rentals Feed program. Anything Zillow's own form asks that is not
answered here is marked "confirm on application": we do not guess at program requirements.

## Applicant

| Question | Draft answer |
|---|---|
| Company | PropLane |
| Product type | Property management software (managers publish and manage their own rental listings; PropLane does not own or operate the rentals) |
| Website | https://proplane.ai |
| Contact | Work email of the PropLane account holder submitting the application (not a personal address). Confirm the exact address before sending. |
| Listing volume | Confirm on application. Take the live count of listings with Zillow turned on from `manager_property_records` (`property_data.listingSubmission.syndication.zillow.enabled = true`, `status = 'live'`) the day we apply. |
| Feed model | One XML feed per workspace; each manager's feed contains only that workspace's opted-in, live listings. |
| Update cadence | Served on request with a 60 second CDN cache (`s-maxage=60`, `stale-while-revalidate=600`), so a Zillow crawl sees changes within about a minute. Confirm Zillow's preferred crawl cadence on application. |
| Feed format | HotPads Rental Network XML, `<hotPadsItems version="2.1">`. Confirm on application that this is the schema the program wants for new partners. |

## Feed URL

Pattern: `<canonical origin>/api/feeds/zillow/<feedKey>.xml`

- Route: `src/app/api/feeds/zillow/[feedKey]/route.ts`. Public and anonymous; the `.xml` suffix is optional.
- `<feedKey>` is an opaque token from `manager_syndication_feeds.feed_key`. It is not a user id or
  workspace id, so the URL reveals no identity. Unknown or disabled key returns 404.
- The origin is the canonical server origin (`resolveEmailLinkBaseUrl()`), never the request
  origin, except localhost outside production (see the Integrations row in `AGENTS.md`). For
  production that is `https://proplane.ai`.
- The application needs one real feed URL. Use a workspace we own with at least one fully eligible
  listing so a reviewer sees a non-empty feed. Confirm on application whether Zillow wants one URL per
  company or one per customer.

## Field map

Source is `publicListingProjection` output only (the same allowlist the public catalog uses). Emitted
by `src/lib/listing-syndication/zillow-feed.ts`.

| Feed element / attribute | Source | Notes |
|---|---|---|
| `Listing@id` | `property.id` | |
| `Listing@type` | constant `RENTAL` | |
| `Listing@companyId` | `property.managerUserId` | Omitted when absent. Confirm on application whether Zillow wants a stable company id that is not a user id. |
| `Listing@propertyType` | `listingSubmission` | `house` for an entire-home listing, otherwise `apartment` |
| `name` | `property.title`, else `listingSubmission.buildingName` | |
| `street` | `property.address` | |
| `city` | `property.neighborhood`, else `property.buildingName` | Approximation: the structured city is not on the public projection |
| `state` | `property.zip` via ZIP3 prefix table | Approximation; null when the ZIP is not recognised |
| `zip` | `property.zip` | |
| `lat` / `lng` | `property.mapLat` / `property.mapLng` | Only when present |
| `price` | `listingSubmission` | Whole dollars per month; cheapest room when listed by room |
| `numBedrooms` | `property.beds` | |
| `numFullBaths` | `property.baths` | |
| `squareFeet` | `listingSubmission.houseSizeSqft` | Only when present |
| `description` | `listingSubmission.houseOverview` | |
| `ListingPhoto@source` | `listingSubmission.housePhotoDataUrls`, else every room's `photoDataUrls` | Only real http(s) URLs; never a placeholder |
| `contactEmail` | `property.contactWorkEmail` | Workspace work email |
| `contactPhone` | `property.contactSmsPhone` | Workspace work number, never a personal phone |
| `availableOn` | `property.available` | |
| `listingUrl` | `buildManagerListingUrl(origin, property.id)` | Public PropLane listing page. No `?src=` tag today; adding `?src=zillow` is a follow-up so Zillow leads are counted. |
| `unit` | `property.unitLabel` | Only when present |

## Exclusion rules

A listing is left out of the feed entirely, never padded with a placeholder, when any of these holds:

1. No street address (`no_street_address`).
2. No real photo (`no_photo`).
3. No workspace work number (`no_work_number`). Zillow gets the work number or nothing.

The build returns the excluded ids with their reasons (`ZillowFeedBuildResult.excluded`); the
Listing sites UI shows the same three facts as hold reasons.

## After approval

1. Record Zillow's approval and any partner/company id they issue.
2. Set `ZILLOW_FEED_APPROVED=1` (or `true`) in the deployment env. Zillow approves PropLane once, so it is
   an env flag, not a per-workspace setting. It is read only in `GET /api/manager/listing-channels`
   (`zillowFeedApproved()` in `route.ts`; `registry.ts` is client-imported) and returned as
   `zillowFeedApproved` in the status payload.
3. `src/components/portal/listing-site-guide.tsx` then hides the Zillow guide's by-hand steps and shows the
   registry's `howApproved` text, the per-listing status table, hold reason and Zillow toggle.
4. Decide with Zillow how the feed key reaches them (per-workspace URL given at onboarding versus a
   directory). Confirm on application.
5. Add `?src=zillow` to `listingUrl` in the feed so leads from Zillow are counted (lead source cookie
   `pl_src`, allowlist in `src/lib/listing-channels/lead-source.ts`).
