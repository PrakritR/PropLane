> Source of truth for its area. READ IT BEFORE changing the Vendor services tab.

# Vendor services: outside marketplaces for odd jobs

Vendors › **Vendor services** (`/portal/vendors?tab=services`, `VendorDirectoryTab` `services`) lists marketplaces
where a manager can find someone for a one-off job. It is modeled on Promotion › Listing sites
([`listing-syndication.md`](listing-syndication.md)): a registry, an `IntegrationRow` per entry, a guide modal.

## The catalog

`src/lib/vendor-marketplaces/registry.ts` is the one list: id, label, glyph, the `ServiceKind`s it offers,
`searchUrl(service, {zip, city})`, `postUrl`, `signupUrl`, a guide (how, cost, rules) and
`integration: "coming_soon"`. The service picker and the house picker (which supplies the ZIP or city to a
search link) drive which rows show; a marketplace that does not offer the chosen service is hidden.

- Every URL is a plain public link the manager opens in their own tab. No scraping, no marketplace API call, no
  headless posting. The file's header comment records what was curl-verified; re-verify before adding a pattern
  (404 is a bug; a Cloudflare 403 wall is accepted). A site with no working deep link links its homepage.
- Entries left out on purpose: HomeAdvisor (it is Angi), Porch (now insurance), Airtasker (not in the US).
- Service labels reuse `VENDOR_TRADE_OPTIONS` wording where a trade already names it.

## Manual accounts

`vendor_marketplace_accounts` (`20261009170000_vendor_marketplace_accounts.sql`) holds one row per
(workspace, marketplace): `account_label` (the email or name used there) and an optional https `profile_url`.
**Never a password or token.** RLS on, no client policy, no client grant (same posture as
`listing_channel_connections`); `GET/POST/DELETE /api/manager/vendor-marketplace-accounts` is the only door, using the
service role pinned to the caller's active workspace (`resolveListingChannelContext`). Writes are owner-only,
the marketplace id must be in the registry, the link must be https, the label at most 120 characters. The table is
classified in `account-purge-manifest.ts`.

## Future (not built)

- Direct connections: post a job and read replies from PropLane. Every row says "Direct connection · Coming soon".
- Dispatch from a resident complaint: a service request offering the marketplaces for its trade. Today the tab is
  reached from Vendors only.

Analytics: the named event `vendor_marketplace_action` `{marketplace, action, service}` (no PII); every control has a
`data-attr`.
