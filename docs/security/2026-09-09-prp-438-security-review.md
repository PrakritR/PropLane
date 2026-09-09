# PRP-438 security review

- Reviewed: 2026-09-08T23:19:13-04:00
- Base: 4e81888ef27cbf8ba82abedcc0b0c3e807a94f97
- Uncommitted source diff SHA-256: 2a6a2ece3d2a41f0a35398a4503726edcc87a327248a9e66dc875846da16019b
- Diff inventory: nearby-transit server module, leasing read tool/registry/prompt, SMS and assistant docs, four transit tests, and local validation note.

## Findings

### P1 — deployed lookup is disabled until both managed provider URLs are configured

providerEndpoint deliberately returns null in Vercel/production when either provider setting is absent. The tool then returns provider_unavailable; the leasing prompt escalates. The validation note also says configuration and actual leasing-channel QA remain pending. This is safe, but PRP-438 cannot be accepted as delivering nearby-transit answers in deployed environments until HTTPS Nominatim and Overpass endpoints are configured and a scoped dev/staging lookup is verified.

No cross-listing read was found: the tool first calls loadResolvableListing, which keeps the existing owner/cross-catalog leasing scope. Model input admits a property id and fixed mode only. The server derives address/coordinates, radius, query, provider URL, and response cap. Responses do not expose the address.

Provider URL settings are configuration-only, not model/user input. They reject non-HTTPS credentials-bearing URLs, but are not hostname-allowlisted; deployment configuration should remain restricted to trusted managed/self-hosted provider origins.

