# Resident account creation

> **Model (captain decision, Jul 2026).** A prospective resident CREATES AN
> ACCOUNT and then APPLIES FROM INSIDE THEIR PORTAL. There are three entry
> points, routed by who the person is — the apply surface's single decision
> point is `resolvePublicApplyView` in `public-apply-session.ts`:
>
> 1. **Anonymous visitor** → self-serve signup, `POST /api/auth/resident-register`
>    (ENABLED). The anonymous apply gate (`public-apply-account-prompt.tsx`)
>    offers **Create account (primary) + Sign in + guest**; Create account
>    carries `next=/rent/apply?propertyId=…` so signup lands the renter ON that
>    application (`ResidentSignupForm` navigates straight to `next`, not through
>    the post-auth resolver). **Default-deny inheritance:** at signup the route
>    mints a CLEAN resident profile — `application_approved=false`, no application
>    PII copied, no link to a prior guest application — regardless of any matching
>    application. A verification email proves email control; only once it completes
>    does any pre-existing guest application link/inherit. Signup and applying are
>    NOT blocked on the inbox round-trip. `provisionResidentAccountByEmail` keeps
>    its inheriting behavior ONLY for the token/OAuth callers (which already prove
>    control); resident-register uses the no-inherit path.
> 2. **Signed-in manager/vendor** → `POST /api/auth/create-resident-account`
>    (additive role on the SAME login, no second auth user). Their separate prompt
>    is `signed-in-resident-account-prompt.tsx` — do NOT fold it into the anonymous
>    gate. Owned by the "Multi-role accounts" section of `AGENTS.md`.
> 3. **Guest** (applies without an account) → the emailed **setup token** / OAuth
>    fallback described below. This is now the guest fallback only.
>
> The legacy `register-resident` endpoint and the `resident-setup` **token** POST
> stay gated (token/session proves control). What follows describes the guest
> fallback (path 3).

Guests who apply without an account still get an account only once an
application exists and the person proves they control the application's email —
either by holding the one-time **setup token** (emailed, or handed to the guest
in-session right after applying) or by an **OAuth** email match.

## The one canonical flow

```
apply (guest)                       manager approves
   │  POST /api/manager-applications │  deliverResidentWelcome (resident-welcome.server.ts)
   │  action:"upsert" (unauth)       │  ensureResidentSetupTokenForApplication → token
   │  prepareGuestApplicationUpsert  │        │
   │  mints setup token on the row   │        ▼
   │  returns { setupToken,          │  approval email links /auth/resident-setup?token=&axis_id=
   │            setupHref, axisId }   │
   ▼                                 ▼
finish screen (RentalApplicationFinishPanel)  ── "Create your resident account" → setupHref
   │  wizard also calls send-application-submitted (email backup); passes the SAME
   │  setupToken so the emailed link == the on-screen link (route skips rotation)
   ▼
/auth/resident-setup?token=&axis_id=   (resident-setup-client.tsx)
   │  GET  /api/auth/resident-setup  → validate token, prefill email + name + PHONE
   │  password path  OR  "Continue with Google"
   ▼
POST /api/auth/resident-setup   (password)      POST /api/auth/register-resident-oauth   (Google)
   │  requires PHONE (normalizeE164, 400 if bad) │  token+axis_id authorize; if the Google email
   │  provisionResidentAccountByEmail({phone})   │  DIFFERS from the application, relink the app
   │                                             │  (relinkResidentSetupApplicationEmail) — never reject
   ▼                                             ▼
   sign in → /resident/applications (application visible)
```

## Invariants (do not regress)

- **`POST /api/auth/resident-register` is the ENABLED anonymous self-serve path
  (captain decision, Jul 2026), and it is DEFAULT-DENY on inheritance.** It mints
  a clean resident profile (`application_approved=false`, no application PII, no
  link to a prior guest application) and only links/inherits after email
  verification proves control — a failure to verify must never grant inheritance.
  The generic `/auth/create-account?role=resident` renders `ResidentSignupForm`
  (via `NativeAuthHub`) for an anonymous visitor; a signed-in manager/vendor uses
  the additive `POST /api/auth/create-resident-account` instead. The LEGACY
  `POST /api/auth/register-resident` stays disabled (403).
- **Phone is required** on `/auth/resident-setup` (both password and — via the
  application snapshot — the Google path). `provisionResidentAccountByEmail`
  prefers the caller-confirmed phone over the application's.
- **An unproven address is never an identity.** `provisionResidentAccountByEmail`
  takes `emailProven` (default `true`, today's behaviour); `false` says the address
  is a claim or a placeholder, so the call makes no application link, does not merge
  an auth user that already owns the address, and attaches none of that address's
  inbox threads. The one caller passing `false` today is the guest short-stay
  booking, which mints a resident login keyed on the guest's PHONE and never on the
  email they typed — a door into the portal that does not go through the apply
  surface above, owned by [`bookings.md`](bookings.md) § Guest portal stays and not
  restated here.
- **The setup token is a claim capability — it only leaves via email**, except the
  guest wizard's in-session handoff (the submitter proved email ownership by
  completing the application in that session). `POST /api/auth/resident-setup-link`
  (the "lost my email" resend on `ResidentSignupBlocked` and create-account) emails
  the address on file and NEVER returns the token to the browser; its response is
  neutral (no application enumeration).
- **The finish CTA is server-authoritative and email-independent.** The token is
  minted during the application upsert and its `setupHref` returned there, so a
  failed/unconfigured email send (503) never strips "Create your resident account".
- **OAuth relink is authorized by the setup token, not the email match.** A
  mismatched Google email relinks the application onto the account the applicant
  controls (`resident_email` + snapshot email rewritten) — see
  `register-resident-oauth/route.ts`.

## Files

| Piece | File |
| --- | --- |
| Token lib (mint / validate / relink / consume) | `src/lib/auth/resident-setup-token.ts` |
| Guest upsert (mints token) | `src/lib/auth/guest-application-upsert.ts`, `src/app/api/manager-applications/route.ts` (guest branch) |
| Setup email backup (token reuse, no rotation) | `src/app/api/portal/send-application-submitted/route.ts` |
| Finish CTA | `src/components/marketing/rental-application-finish-panel.tsx`, `…/rental-application-wizard.tsx` |
| Setup screen + password/Google | `src/app/auth/resident-setup/resident-setup-client.tsx`, `src/app/api/auth/resident-setup/route.ts` |
| OAuth (relink) | `src/app/api/auth/register-resident-oauth/route.ts`, `src/app/auth/resident-oauth-finish/page.tsx` |
| Provisioning | `src/lib/auth/provision-resident-account.ts` |
| Resend lost link | `src/app/api/auth/resident-setup-link/route.ts`, `src/components/auth/resident-signup-blocked.tsx` |
| Approval / welcome email | `src/lib/resident-welcome.server.ts` |

## Tests

- Unit: `tests/unit/resident-setup-token-relink.test.ts`,
  `resident-setup-route.test.ts`, `send-application-submitted-handoff-route.test.ts`,
  `register-resident-oauth-relink-route.test.ts`,
  `resident-register-route.test.ts` (self-serve input validation),
  `provision-resident-default-deny.test.ts` (unverified signup inherits nothing),
  `public-apply-account-prompt.test.tsx` (3-action gate), plus existing
  `resident-setup-token.test.ts` / `guest-application-upsert.test.ts`.
- E2E (gated `RESIDENT_SETUP_E2E_ENABLED=1`, dev/test only):
  `tests/e2e/resident-account-setup.spec.ts`.
