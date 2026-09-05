# Resident My home and housemate sharing

The resident sidebar labels the existing `/resident/move-in/*` section **My home**. Its entry remains visible before lease completion with the shared stage lock; the underlying house details still require a fully signed lease or a manager-attested tenancy. Existing URLs and native deep links remain valid. The section includes placement, housemates, house information/rules, amenities, move-in instructions, and the dedicated Inspections tab.

Housemates contains the resident's sharing controls. Name, room, email and phone are independent **opt-in** fields; no stored choice means all four are private. Room sharing also controls whether the peer is grouped as a roommate. Managers retain their normal tenancy-management access. Consent changes affect subsequent server reads; already delivered data or copies cannot be recalled.

`resident_housemate_sharing` is service-role only with RLS enabled. Its primary key is the authenticated resident's user id, with account-deletion cascade. `GET/PATCH /api/resident/housemate-sharing` resolves the resident context server-side; the strict schema accepts four booleans only, never an identity or profile fields. Writes audit intent/outcome and emit `housemate_sharing_updated` with booleans only. The form disables saving until preferences are successfully loaded and preserves errors for retry.

`loadResidentMoveInForEmail` is the canonical server projection for disclosure. It first scopes the home to the viewer's own application (and active manager when called from SMS), then restricts peers to that manager/property. Both self and peer must be current residents under `isCurrentResidentApplicationRow`; withdrawn rows are excluded. Historical house information can remain visible without exposing any current housemates. Profile values are passed through `sharedHousemateDetails` BEFORE browser props or assistant results are constructed. Missing/failed preference reads fail closed, an empty name falls back to "Housemate" rather than email, and private fields are absent/empty in the response. The client never receives a hidden email as a row key.

Resident tools `get_housemates`, `get_housemate_sharing`, and `update_housemate_sharing` use the same functions. The update is a normal `defineWriteTool` preview/confirm action; no inline write path exists. Housemate contact displays are excluded from PostHog autocapture and session replay. Existing assistant tracing covers these tools.

Apply `20260905213000_resident_housemate_sharing.sql` before deployment. It is applied to dev/test only; staging and production use the release ladder.

Coverage: `resident-housemate-sharing*.test.ts`, `resident-housemate-disclosure-loader.test.ts`, resident navigation/tool-gating and platform-parity tests. Browser verification uses two dev residents to exercise save, opt-in disclosure, opt-out redaction, mobile layout, cross-origin rejection and identity-injection rejection.

## Housemates: scoped, paged, and named from the listing

`loadHousematesForProperty` (`src/lib/resident-move-in-info.ts`) reads
`manager_application_records` scoped to ONE property and paged in 500-row batches. An
unfiltered landlord-wide read stopped at Supabase's 1,000-row ceiling, so a manager with a
large application history silently lost housemates from a resident's My home list.

It queries every placement path `propertyIdFromAppRow` reads — the `property_id` and
`assigned_property_id` COLUMNS plus the `row_data->>assignedPropertyId`,
`row_data->>propertyId` and `row_data->application->>propertyId` JSON copies — deduped by
row id. The JSON fallbacks are load-bearing: an older row can carry the placement only in
`row_data` while the scalar column is null or stale, and scoping on the columns alone
dropped exactly those peers. The JS predicate still decides membership, so a row matched on
one path whose resolved property is a different house is discarded, and the current-resident
and per-field opt-in checks are unchanged.

A peer's room label comes from the listing (`property_data->listingSubmission->rooms`, or the
legacy `row_data->submission->rooms`) keyed on the structured room id, so a housemate who
opted into sharing their room reads "Garden Room" rather than the raw `home::room-3`
placement id. Consent is unaffected — without `shareRoom` the label is still redacted to an
empty string, and roommate identity still resolves from the structured id, never the label.
