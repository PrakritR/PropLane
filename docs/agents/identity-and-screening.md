# Identity and applicant screening

Captain decision (Nov 12, 2026). Applications, leases and tours stay FREE. Two optional checks sit beside them, each its own per-listing setting.

## The two checks

| Check | Provider | Who pays | Where it runs |
| --- | --- | --- | --- |
| Verify ID (government ID + live selfie) | Checkr's `identity_verification` add-on, **$2.95** (`checkr/packages.ts`) | The applicant, inside the same Checkout as the order | Rides the screening order; no pre-application gate |
| Applicant background check | Checkr **Starter** ($24.99: criminal, sex-offender, global watchlist) | The applicant, through PropLane Stripe Checkout, total shown before they confirm | `POST /api/screening/applicant-checkout` |

Checkr has no ID-only product, so a listing with only "Verify ID" on still orders Starter + the add-on (the cheapest orderable). The per-check fee model is the existing one: package and add-on prices come from the Checkr catalog (`checkrPackageCatalog` / `checkrAddOnCatalog`, env overridable); the applicant pays the order total.

**Upgrade.** A manager can upgrade a specific applicant to Essential ($34.99) or Complete ($44.99) from the existing manager screening checkout. The charge is the package DIFFERENCE only (`checkrUpgradeCostCents`), billed to the manager, because today's screening settings make the manager the payer of a manager-initiated order. The upgrade replaces exactly the completed applicant-paid check (`upgrade_from_package` is re-verified at order time), and the ID result is carried over (`carriedIdentity`), never re-bought. Checkr itself bills the full new order to PropLane's Checkr account; the difference is what the customer pays.

## Settings

`applicantScreening` namespace (`{ idCheck, backgroundCheck }`), property override then workspace row then default: **ON for a PropLane-managed (`is_service`) workspace, OFF for self-serve**. Resolver `resolveApplicantScreeningSettings`; route `/api/portal/applicant-screening-settings`; UI is two dropdowns (Verify ID, Applicant background check) in Settings > Automations > Screening, following the scope bar. No new tables or migration.

## Provider switch

`RESIDENT_IDENTITY_PROVIDER`: unset or `checkr` (default), `persona` (the existing inquiry flow, only with its keys), anything else resolves to `null` and fails closed. `RESIDENT_IDENTITY_ENABLED=true` is the master switch for the ID check. `applicantIdCheckAvailable()` is the one answer; a listing that turned Verify ID on while it is false shows **"ID check unavailable"**, creates no Checkout session and never marks anyone verified. "Verified" is derived only from Checkr's re-fetched report (`applicationIdentityVerified`: complete + add-on ordered + `identity_verification.status === "clear"`), drawn as a plain glyph fact, never a pill.

**Stripe Identity is NOT a provider.** Its activation terms bar using it "to determine eligibility for any purpose covered by the US Fair Credit Reporting Act (FCRA)", and tenant screening is such a purpose. `RESIDENT_IDENTITY_PROVIDER=stripe` is refused. If it is ever added it may back only non-eligibility fraud/trust checks, never applications, screening or lease decisions.

**No ID evidence is stored.** The application row keeps the product status and reasons only (`parseCheckrReportSnapshot`); images and document numbers stay at Checkr.

## FCRA authorization

The applicant card shows the standalone disclosure and an explicit authorization checkbox before the Pay button works. The server refuses (`authorization_required`) without `authorize: true` and the current `FCRA_DISCLOSURE_VERSION`; the authorization (version + timestamp) goes into the Stripe session metadata and onto `backgroundCheck.authorization`. The disclosure wording in `applicant-screening.ts` needs counsel review before live rollout.

**Adverse action is NOT built.** The code only shows a warning ("Adverse action may be required before denying based on this consumer report (FCRA)") on a flagged check. There is no pre-adverse / adverse-action notice flow; build it before managers decline applicants on a Checkr report.

## End-to-end path

1. Applicant opens their application (resident portal status screen), sees the itemized total and disclosure, authorizes.
2. `applicant-checkout` re-derives the application's owner, the listing's settings and the price, and creates an embedded Checkout (`purpose=application_screening`, `payer=applicant`).
3. The Stripe webhook (`checkout.session.completed`) calls `runScreeningFromStripeSession` -> `runBackgroundCheck` (idempotent on the session id; `checkout-verify` is the same path for the return trip). Failure after payment refunds, except a provider error that a retry can fix.
4. Checkr creates applicant, property and order; `POST /api/webhooks/screening/checkr` (`Tenant-Signature`, 5 minute replay window, live + test secrets) re-fetches the order and applies Checkr's status. Any `report.*` / `order.*` event is handled; redelivery changes nothing. The route is host-independent, so proplane.ai and axis-seattle-housing.com both work (the legacy redirect never touches `/api/**` or a non-GET).
5. The manager sees the result and the Verified fact on the application's screening panel; the PDF streams through `/api/screening/background-check/document` (authenticated, never a Checkr URL, never stored). The applicant sees progress and Verified only, not the report.

## Production steps

- Env: `RESIDENT_IDENTITY_ENABLED=true` (omit `RESIDENT_IDENTITY_PROVIDER`), `CHECKR_API_KEY`, `CHECKR_WEBHOOK_SECRET` (already set).
- Checkr dashboard: point the webhook at `https://proplane.ai/api/webhooks/screening/checkr` and subscribe to report and order events; the signing secret is `CHECKR_WEBHOOK_SECRET`.
- Stripe: no new events (the existing `checkout.session.completed` handler covers `application_screening`).

## Tests

`applicant-screening*.test.ts`, `applicant-checkout-route.test.ts`, `checkr-webhook-status-mapping.test.ts`, `resident-identity-provider.test.ts`, plus the existing `checkr-*` and `resident-identity-*` suites.
