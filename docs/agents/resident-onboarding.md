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
>    application. **Mailbox proof comes FIRST:** `ResidentSignupForm` is a thin
>    wrapper over the one signup surface `EmailFirstSignup`, which collects only the
>    email and calls `POST /api/auth/email-onboarding/start`; the listing context
>    rides on the stored handoff, and name, phone and `resident-register` itself are
>    only reached by the confirmed session that comes back through the emailed link.
>    So the inbox round-trip IS the signup — nothing is created or applied before it.
>    **Default-deny inheritance:** the route still mints a CLEAN resident profile —
>    `application_approved=false`, no application PII copied, no link to a prior guest
>    application — regardless of any matching application.
>    `provisionResidentAccountByEmail` inherits only for the callers that bind an exact
>    application capability; resident-register uses the no-inherit path.
> 2. **Signed-in manager/vendor** → `POST /api/auth/create-resident-account`
>    (additive role on the SAME login, no second auth user). Their separate prompt
>    is `signed-in-resident-account-prompt.tsx` — do NOT fold it into the anonymous
>    gate. Owned by the "Multi-role accounts" section of `AGENTS.md`.
> 3. **Guest** (applies without an account) → the emailed **setup token** / OAuth
>    fallback described below. This is now the guest fallback only.
>
> The legacy `register-resident` endpoint stays disabled, and every live write seam
> is gated on a confirmed Auth session for the same address. What follows describes
> the guest fallback (path 3).

Guests who apply without an account still get an account only once an
application exists and the person proves they control the application's email.
The **setup token** names which application may be resumed; it is never the proof.
Proof is the emailed `token_hash` link, or an OAuth sign-in whose CONFIRMED address
equals the application's.

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
   │  GET  /api/auth/resident-setup  → validate token, prefill the email (read-only)
   │  "email me a link"  OR  "Continue with Google"
   ▼
POST /api/auth/email-onboarding/start           POST /api/auth/register-resident-oauth   (Google)
   │  { email, applicationId, setupToken }       │  needs a CONFIRMED Google/Apple email that
   │  reserves the exact application context,    │  EQUALS the application's; a different address
   │  then emails a token_hash link              │  is refused (403), never relinked
   ▼                                             │
/auth/confirm?token_hash=&type=magiclink        │
   │  verifyOtp, then                            │
   │  POST /api/auth/email-onboarding/finish     │
   │   → bind_resident_setup_subject (exact      │   → bind_resident_setup_subject
   │     application + setup-token digest)       │
   │   → provisionVerifiedResidentHandoff        │   → provisionResidentAccountByEmail
   ▼                                             ▼
/auth/continue → POST /api/auth/email-onboarding/continue (one-shot handoff cookie)
   ▼
/resident/applications (application visible)
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
- **No account, and no password, before mailbox proof.** `/auth/resident-setup` no
  longer sets a credential: it sends the emailed `token_hash` link, and the account is
  only created, confirmed and bound once that link is opened. Every write seam
  (`/api/auth/resident-setup`, `/api/auth/resident-register`,
  `/api/auth/register-resident-oauth`) refuses 403 `EMAIL_VERIFICATION_REQUIRED`
  unless the request already carries a confirmed Auth session for that same address.
  `provisionResidentAccountByEmail` prefers the caller-confirmed phone over the
  application's.
- **An unproven address is never an identity.** `provisionResidentAccountByEmail`
  takes `emailProven` as a REQUIRED argument — there is no default. `true` is re-checked
  against Auth itself (`email_confirmed_at` set, and the confirmed address equal to this
  one) before anything is written; `false` says the address is a claim or a placeholder,
  so the call makes no application link and does not touch an auth user that already owns
  the address. Inheritance additionally needs the exact `applicationId` — the old
  newest-matching-row-by-email lookup is gone, and an id whose `resident_email` does not
  match the verified session is refused 403. It no longer merges a lookalike account
  (`migratePortalUserId`), confirms an email itself, or attaches an address's inbox
  threads. The one caller passing `false` today is the guest short-stay
  booking, which mints a resident login keyed on the guest's PHONE and never on the
  email they typed — a door into the portal that does not go through the apply
  surface above, owned by [`bookings.md`](bookings.md) § Guest portal stays and not
  restated here.
- **The setup token names an application; it does not prove the mailbox.** It
  normally only leaves via email, and the guest wizard's in-session handoff hands it
  back to the submitter's own browser — which is exactly why it cannot stand in for
  mailbox proof on its own. `POST /api/auth/resident-setup-link`
  (the "lost my email" resend on `ResidentSignupBlocked` and create-account) emails
  the address on file and NEVER returns the token to the browser; its response is
  neutral (no application enumeration).
- **The finish CTA is server-authoritative and email-independent.** The token is
  minted during the application upsert and its `setupHref` returned there, so a
  failed/unconfigured email send (503) never strips "Create your resident account".
- **Application handoff requires a verified matching Auth mailbox.** A setup token is a
  resume reference and cannot prove email ownership or relink an application to a different
  mailbox. Email onboarding binds the exact application to the verified session.
- **Approval does not provision a login.** `provisionApprovedResidentAccount` returns
  `invitation_required` until a verified resident handoff; it never creates or confirms an
  account from application email alone. The setup screen offers the email verification link.
- **An email address is not proof of ownership.**
  `POST /api/auth/confirm-resident-email` refuses every request identically (403
  `EMAIL_VERIFICATION_REQUIRED`) with no lookup and no mutation — typing an address
  must never mark it confirmed. A sign-in blocked on an unconfirmed address is told
  to use its email link through `presentSignInError`
  (`src/lib/auth/sign-in-error.ts`, the one owner of that copy); no surface retries
  the credential behind a client-side auto-confirm.

## Files

| Piece | File |
| --- | --- |
| Token lib (mint / validate; binding is `bind_resident_setup_subject`) | `src/lib/auth/resident-setup-token.ts` |
| Guest upsert (mints token) | `src/lib/auth/guest-application-upsert.ts`, `src/app/api/manager-applications/route.ts` (guest branch) |
| Setup email backup (token reuse, no rotation) | `src/app/api/portal/send-application-submitted/route.ts` |
| Finish CTA | `src/components/marketing/rental-application-finish-panel.tsx`, `…/rental-application-wizard.tsx` |
| Setup screen + the verified-session seam | `src/app/auth/resident-setup/resident-setup-client.tsx`, `src/app/api/auth/resident-setup/route.ts` |
| Emailed onboarding handoff (start / finish / continue) | `src/app/api/auth/email-onboarding/{start,finish,continue}/route.ts`, `src/app/auth/confirm/page.tsx`, `src/app/auth/continue/page.tsx` |
| Handoff expiry sweep | `src/app/api/cron/auth-handoff-cleanup/route.ts` (hourly, `vercel.json`) |
| OAuth (exact email match, no relink) | `src/app/api/auth/register-resident-oauth/route.ts`, `src/app/auth/resident-oauth-finish/page.tsx` |
| Provisioning | `src/lib/auth/provision-resident-account.ts`, `src/lib/auth/verified-resident-handoff.server.ts` |
| Approval provisioning (invitation only, never a credential) | `src/lib/auth/provision-approved-resident.ts` |
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
- Unit (security invariants above): `tests/unit/security/no-fixed-resident-password.test.ts`,
  `confirm-resident-email-disabled.test.ts`,
  `resident-setup-email-link-recovery.test.ts`.
- E2E (gated `RESIDENT_SETUP_E2E_ENABLED=1`, dev/test only):
  `tests/e2e/resident-account-setup.spec.ts`.
