# Admin Accounts (the access decisions, not the plan)

Owner of the staff-facing **Accounts** surface: the list at `/admin/axis-users`,
one account's record page, and the three per-kind routes behind them. A
manager's plan, cap, overrides and the billing audit convention are
[plan-entitlements.md](plan-entitlements.md) — read that for anything about what
an account is *charged*. This file owns what an account is *allowed*.

## One account, three kinds, three routes

`src/lib/admin/admin-account-keys.ts` is the client-safe map every surface
shares: the kinds (`manager` | `resident` | `vendor`), the list tab each lives
under (`?category=` — managers keep their historical `management` slug), the
record page's `<kind>-<id>` URL key, and the one existing route per kind:

| Kind | Route | Label |
| --- | --- | --- |
| manager | `PATCH`/`DELETE /api/admin/managers` | Manager |
| resident | `PATCH`/`DELETE /api/admin/residents` | Resident |
| vendor | `PATCH`/`DELETE /api/admin/vendors` | Vendor |

Each starts with its own `requireAdminActor()` and then writes through the
service-role client. They are not interchangeable with the billing writer:
`PATCH /api/admin/managers` carries both the `active` flag (here) and `tier`
(plan-entitlements.md § Per-account overrides).

The record page (`admin-account-record-page.tsx`) is header + rail
(Account · Money · Activity) over a single read,
`GET /api/admin/accounts/<user id>` (a UUID; the path id is never
authorization, so it is validated and the profile loaded before anything else is
read); Money exists for a manager only. Disable and Delete are header
`PortalIconAction`s, and the list row's ⋯ menu offers the same two — one hook,
`useAdminAccountActions`, owns both so the two entry points can never grow
different rules.

## Disabling access is audited

A reason is required for every kind, and the trail is the point of asking.

`setAdminAccountActive` (`src/lib/admin/admin-account-active.server.ts`) is the
**one** writer of `profiles.application_approved` from staff, shared by all three
routes:

- A missing or blank `reason` is refused **400 before the flag is touched**
  (`normalizeAdminAuditReason`, the same 280-character trim the billing audit
  uses). A reason the route then discarded would be worse than never asking.
- It reads the before-value first (no explicit refusal reads as **active**), then
  writes one `audit_log` row through `writeAuditLog`: action and tool
  `admin_account_active`, `landlord_id` the account, `actor_user_id` the staff
  member, `input_summary` carrying `field: "active"`, `before`, `after`,
  `accountKind`, `accountUserId` and the reason. `landlord_id` being the subject
  is what lets `audit_log_landlord_idx` answer "everything ever done to this
  account" in one query.
- **The audit insert is best-effort on purpose**: the flag has already moved, so
  a failed insert must not fail a request whose write landed. The response
  carries `auditRecorded`, and `false` makes the toast say the entry could not be
  written instead of reading as a clean success. Never "fix" this by rolling the
  flag back or by failing the request after the flag has moved.

Every Disable / Enable control — the Accounts list row, the record header, the
manager Danger zone — collects the reason through one popup,
`AdminAccountActiveDialog` over `AdminBillingActionDialog`.

Coverage: `tests/unit/admin-account-active-reason.test.ts`,
`tests/unit/admin-account-active-audit-route.test.ts`.
