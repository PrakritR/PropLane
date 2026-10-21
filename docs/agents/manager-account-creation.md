# Manager account creation ("Get started")

The marketing CTAs that have already declared the role (pricing plans, the
homepage "Join free" Manager row) use `MANAGER_GET_STARTED_HREF` in
`src/lib/marketing/public-contact.ts` and open
`/auth/create-account?mode=create&role=manager`; a plain **Get started** that has
not asked yet — the public top bar's signed-out button — uses `GET_STARTED_HREF`
and lands on the role chooser. Either way that surface exists to create a **new**
account, so it never treats an existing session as a reason to go somewhere
else.

## Where it lives

| Piece | File |
| --- | --- |
| Create-account shell (`skipSessionRedirect = isCreate`) | `src/components/auth/native-auth-hub.tsx` |
| The form itself | `src/components/auth/manager-trial-signup-form.tsx` |
| Email/password registration API | `src/app/api/auth/manager-register/route.ts` |
| Partner-pricing OAuth callback | `src/app/auth/callback/partner-pricing/route.ts` |
| Regression coverage | `tests/e2e/manager-get-started-signed-in.spec.ts` |

## The create-account surface never auto-redirects to a portal

Entering a portal from here is always an **explicit user click**, on every path:

- **Already signed in?** What renders depends on whether the session already
  holds manager access (`useSignedInPortalRoles`, the shared probe all three
  create-account tabs use):
  - **Already a manager** → the shared `AuthAlreadyHaveRolePanel`
    (`src/components/auth/auth-already-have-role-panel.tsx`): "you already have
    property manager access" with an explicit **Go to your portal** button
    (`/auth/continue`) and a **Create a different property account** reveal that
    brings the full form back — so creating a second account with a different
    email stays possible, and entering a portal is still a click, never a
    redirect.
  - **Signed in without manager access** → the full create form renders, above
    the `AuthSignedInRoleBanner` notice.

  (The old behavior collapsed the form into one button that converted the
  *current* session and bounced to `/portal/dashboard`; that is the regression
  the e2e spec covers.)
- **Partner-pricing OAuth return.** The callback provisions the account as
  before, but its `resolveRedirect` always returns back to
  `/auth/create-account?mode=create&role=manager&…` — including the **free-tier**
  branch, which used to return `/portal/dashboard` and otherwise fall through to
  `resolveOAuthPortalRedirect`. It appends `account_ready=1` only when
  `ensureFreeManagerPortalAccess` reported `portal_ready`; a skipped provision
  logs a warning and returns without the flag.
- **`account_ready=1`** makes the form show a verified success state — "Your
  property account is ready" plus a primary **Go to your portal** button and a
  **Create a different property account** escape hatch. The flag is confirmed
  against the server (`fetchPartnerPricingSession`) before the state is shown,
  and the OAuth return params are stripped from the URL afterward.

Do not reintroduce a server-resolved portal path or a "continue" screen on this
route — the requirement is product-level, not incidental.

## The email/password form requires full name and phone

`/api/auth/manager-register` rejects a missing `fullName` or an unparseable
`phone` with a 400, so the form collects both and validates them client-side
before posting (`normalizeE164` for the phone). Omitting either field is not a
cosmetic gap — it 400s every email/password signup.

`normalizeE164` lives in **`src/lib/phone-e164.ts`**, which is client-safe.
`src/lib/twilio.ts` re-exports it for the server callers that already import it
from there; client components must import from `phone-e164` so the Twilio SDK and
the Supabase service-role client stay out of the browser bundle.

## A phone on every account, and sign-up by text

Every sign-up door (manager, resident, vendor, the role-agnostic hub) requires the phone, and with
`sms_runtime_config.phone_required` on, any signed-in account (email, Google, Apple) without a verified phone is sent
to `/auth/verify-phone` before a portal. A manager can also create the same account by TEXT: the PropLane line asks
name, business, homes and an optional email, then texts a code the person must text back before
`ensureFreeManagerPortalAccess` runs on the Free plan. The email typed there is an unverified claim, never the login.
Details and invariants: `one-number.md` section W26.
