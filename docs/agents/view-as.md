> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

# View as (read-only support mode)

A named PropLane operator can open an account's manager, resident or vendor
portal **read-only** for 30 minutes, with a reason, logged on that account's
audit trail. It is never "act as".

## The rules

- **Who:** `isAdminUser` AND the auth user id is in `PROPLANE_VIEW_AS_OPERATOR_IDS`
  (comma-separated). Empty or unset means nobody. Both are re-checked on every
  request, not only at start.
- **What:** `POST /api/admin/preview` `{targetUserId, portal, reason}`. Reason is
  3..300 chars. The target must hold the portal in `profile_roles` (legacy
  `profiles.role` only as the fallback), must not be an admin, disabled or
  purged, and a test-workspace member only if the operator is also on
  `PROPLANE_TEST_WORKSPACE_OPERATOR_IDS`.
- **Audit first:** the `admin_view_as_started` row (`audit_log`, `landlord_id` =
  viewed account, `actor_user_id` = operator, `dedupe_key = view_as_started:<sid>`)
  is inserted BEFORE the cookie is set. If the insert fails there is no session.
  End (and sign-out, and the banner's expiry timer) writes `admin_view_as_ended`
  with the duration. The viewed account is never notified.
- **Cookie:** one value, `axis_view_as`, `base64url(payload).base64url(HMAC-SHA256)`
  signed with `PROPLANE_VIEW_AS_SECRET` (32+ chars; unset = the feature is off).
  Payload: `{adminId, targetId, portal, iat, exp, sid}`; `exp - iat` is capped at
  30 minutes inside verification. httpOnly, SameSite=Lax, Secure in production.
  The two old unsigned cookies are never read.
- **Honoured only when** signature + expiry hold, the REAL signed-in user is
  `adminId`, that user is still an allowlisted admin, and the viewed account
  still holds the portal. Anything else behaves as if there were no cookie.

## Where it is enforced (read-only is three layers, the first is the control)

1. **`src/middleware.ts`** refuses every non-GET/HEAD/OPTIONS request, on any
   path (so server actions too), with `403 {error:"read_only_view_as"}` while a
   validly signed unexpired cookie is present. Only `DELETE /api/admin/preview`
   and `POST /api/auth/sign-out` pass. It also refuses private-document GETs
   (`viewAsDeniesPrivateBytes`: signed-URL minting, attachment/PDF bytes).
   Pure policy lives in `view-as-token.ts`; `tests/unit/view-as-middleware.test.ts`
   enumerates it.
2. **`createSupabaseServiceRoleClient`** is wrapped by `withViewAsReadOnly`: while
   the cookie is open, `insert/update/upsert/delete` (except `audit_log`) and
   storage `upload/remove/createSignedUrl/download` resolve a Supabase-shaped
   `read_only_view_as` error. This catches heal-on-read GETs. `rpc()` is NOT
   covered. GET handlers that heal, backfill or provision also skip themselves
   via `isViewAsSessionOpen()`.
3. **The UI** stamps `data-view-as` on `<html>`, rewrites any attempted write into
   an instant refusal, mounts no assistant, no push registration, and opts
   PostHog out (no capture, no recording).

## How data becomes the viewed account's

`createSupabaseServerClient().auth.getUser()` / `getClaims()` answer with the
viewed account while a session is honoured, so every route that resolves its
caller that way and reads with the service role returns that account's rows.
`getServerSessionProfile` / `getPortalAccessContext` resolve as the viewed
account too (roles from the viewed account, `effectiveRole` = the portal opened).
`/admin`, `/api/admin` and `/api/auth` keep the operator's own identity, so the
admin console and the End route always work. `createRealIdentitySupabaseServerClient`
is for code that must know the real operator (start/end/verify only).

Not switched, and they will show the operator's own data while viewing:
reads made through the SESSION client with RLS (`/api/pro/account-links` was the
one such GET and now reads with the service role), and browser-direct Supabase
queries (`resident-profile-panel`, `vendor-settings-panel`,
`resident-documents-panel`, `resident-lease-list`).

## Adding a route

A new GET that heals/backfills/provisions on read must check `isViewAsSessionOpen()`.
A new GET that streams private bytes or mints a signed URL goes in
`PRIVATE_BYTES_PATTERNS`. Never read the viewing cookie yourself.
