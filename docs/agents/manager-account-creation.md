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
| The form itself | `src/components/auth/email-first-signup.tsx` (`ManagerTrialSignupForm` is a thin wrapper that passes `intent="manager"`) |
| Registration API (requires a confirmed session, no credential) | `src/app/api/auth/manager-register/route.ts` |
| Paid-checkout completion | `src/app/api/auth/manager-signup/route.ts` |
| Partner-pricing OAuth callback | `src/app/auth/callback/partner-pricing/route.ts` |
| Regression coverage | `tests/e2e/manager-get-started-signed-in.spec.ts` |

## A multi-role sign-in opens the portal this device used last

`pl_last_portal` (`src/lib/auth/last-portal.ts`) is an httpOnly, lax, one-year cookie holding a role string only (no ids),
written by the two server doors that open a portal: `POST /api/auth/set-active-portal` (the chooser and the account
menu's switch) and the post-sign-in resolver (`resolvePostSignInDestination`, behind `/api/auth/oauth-portal-access`
and the phone verify route). A cookie cannot be set from a layout, which is why it is not written "when a layout
renders". It survives sign-out on purpose: it is a device memory.

`resolveOAuthPortalRedirect` uses it only for a generic sign-in (`/auth/continue`) by an account with MORE than one
role, and only when the role is still in the `profile_roles` rows read for that very sign-in (`pickLastPortal`);
otherwise it is `/auth/choose-portal` as before. A `?next=` deep link wins, a single-role account ignores it, and the
primary admin's manager routing is unchanged. When it opens a portal it also pins `axis_active_portal`, because a
multi-role account cannot render a portal without it. Applies to every sign-in method (password, Google, Apple, phone).
Tests: `tests/unit/last-portal.test.ts`, `tests/unit/phone-verify-next.test.ts`.

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

## Email first, then full name and phone

There is no password on this surface. `EmailFirstSignup` has two steps: with no
confirmed session it collects the email alone and posts
`/api/auth/email-onboarding/start`, which emails a `token_hash` link; the account
is created, confirmed and routed back only once that link is opened. The returning
confirmed session then sees its verified email read-only plus **Full name** and
**Phone**, and that is the only request `/api/auth/manager-register` accepts — it
answers 403 `EMAIL_VERIFICATION_REQUIRED` without a confirmed session for the same
address, and 400 on a missing `fullName` or unparseable `phone` (`normalizeE164`).
`/api/auth/manager-signup` (the paid-checkout completion) applies the same two gates
and additionally requires the confirmed address to equal the purchase's. The emailed
handoff is owned by [`resident-onboarding.md`](resident-onboarding.md); only the
manager specifics live here.

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
