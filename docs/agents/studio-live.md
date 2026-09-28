> Moved out of AGENTS.md to keep every-session context lean. This file is the
> source of truth for its area — READ IT BEFORE changing code in this area.

# Studio Live mode (framing the real app in the mock-kit studio)

The PropLane mock-kit studio (`~/proplane-mock-kit/studio/studio.html`,
served at `http://localhost:8960` by `tools/kit-server.mjs`) has a
Proto | Live toggle. Proto shows the studio's own static replica
(`proto/`). Live frames the REAL app (`http://localhost:3000` in normal dev)
inside the studio's Before/After panes, signed in as whichever portal role
the studio is currently "viewing as" — so the captain can click through the
actual product, not a mockup, without leaving the studio.

Two things block an iframed real app by default, and both are gated so
**production and preview behavior never changes**:

## 1. Framing headers (`src/lib/security/browser-headers.ts`)

The app always sends `X-Frame-Options: SAMEORIGIN` and a CSP with
`frame-ancestors 'self'` — correct in production, but it refuses to be
framed by the studio's own origin. `buildBrowserSecurityHeaders()` adds the
studio's exact origins to `frame-ancestors` and drops `X-Frame-Options`
(no multi-origin form exists for it, and a browser that honors
`frame-ancestors` already ignores it per spec) **only when
`NODE_ENV === "development"`** — i.e. only under `next dev`. `next build`
always sets `NODE_ENV=production` regardless of Vercel target, so production
and preview headers are byte-identical to before this existed
(`tests/unit/browser-security-headers-studio-live.test.ts` pins both).

Origins allowed to frame the app in development only:
`http://localhost:8960`, `http://127.0.0.1:8960` (the kit server, both
hostnames), `http://127.0.0.1:4387` (Lavish's artifact host, when the studio
is opened as a Lavish plan instead of standalone).

## 2. Cross-site cookies — open the studio at `localhost:8960`, not `127.0.0.1:8960`

The app's Supabase auth cookies are `SameSite=Lax`. A `SameSite=Lax` cookie
is not sent on a cross-site subframe navigation or any subsequent
same-iframe fetch — so if the studio's own top-level page is a different
**site** than `localhost:3000`, sign-in inside the framed app can set the
cookie but the app can never read it back, and every request inside the
iframe looks signed out.

`localhost` has no registrable public suffix, so browsers treat it as one
site regardless of port — `http://localhost:8960` and `http://localhost:3000`
are the same site; `http://127.0.0.1:8960` is a **different** site (an IP
literal is its own site), and so is Lavish's own artifact origin. That means:

- **Open the studio at `http://localhost:8960/studio/studio.html`** (not the
  `127.0.0.1` form, and not embedded in a Lavish artifact page) for Live mode
  to actually complete sign-in. The kit server already answers on both
  hostnames (`tools/kit-server.mjs` binds `127.0.0.1`, which loopback-resolves
  `localhost` too) — no server change needed, just use the right URL.
- When the studio is opened any other way (embedded in a Lavish plan, or via
  `127.0.0.1:8960`), `studio.js` shows an **"Open standalone ↗"** link
  (`#sb-open-standalone`) pointing at the working `localhost:8960` copy,
  since Live mode's sign-in is silently broken there no matter what the
  headers allow.

## The sign-in route: `GET /api/dev/studio-sign-in`

`src/app/api/dev/studio-sign-in/route.ts` (guard logic in
`src/lib/dev/studio-sign-in.server.ts`) signs the browser into a shared dev
test account and redirects to `next`. The studio's Live mode loads this URL
in the iframe instead of the real path directly
(`liveUrlFor()` in `studio/studio.js`), using
`proto/tools/routes.json` — the fidelity tool's own map of every replica
page/tab/modal to its real app path — to resolve the current replica route
to the real `next` path.

```
GET /api/dev/studio-sign-in?as=<manager|resident|vendor|admin>&next=<same-origin path>
```

**Fails closed with a bare 404** (never a redirect, never an error body — this
must not be a discoverable surface anywhere but a local dev box) unless ALL
of:

1. `NODE_ENV === "development"`.
2. The request's `Host` header is `localhost` or `127.0.0.1` (any port).
3. `NEXT_PUBLIC_SUPABASE_URL` points at the dedicated dev/test Supabase
   project (`emstjswhotsnyksqhqyf`) — never staging (`xwszcafaontidfgznlxd`)
   or production (`qahnczmilgptcedaqype`), even from a local dev process.

`next` is validated with the same open-redirect guard every other auth
redirect in this app uses (`src/lib/auth/safe-next-path.ts`) — an absolute or
protocol-relative destination is rejected and falls back to `/`.

### Accounts

Reuses the SAME `E2E_*` env vars and defaults every other QA/E2E fixture in
this repo already reads — `tests/helpers/canonical-test-accounts.mjs`,
`tests/fixtures/qa-accounts.mjs`, `tests/helpers/seed-test-db.mjs` — so there
is one account registry, never a second one that can drift from what
`npm run test:seed` actually creates:

| `as=` | Account | Env vars (email / password) | Default |
| --- | --- | --- | --- |
| `manager` | `testeverything@test.proplane.local` — the all-portals sandbox account (fuller seeded portfolio; also carries admin/resident/vendor `profile_roles`) | `E2E_EVERYTHING_EMAIL` / `E2E_EVERYTHING_PASSWORD` | `TestEverything123!` |
| `resident` | `resident@test.proplane.local` | `E2E_RESIDENT_EMAIL` / `E2E_RESIDENT_PASSWORD` | `TestResident123!` |
| `vendor` | `vendor@test.proplane.local` | `E2E_VENDOR_EMAIL` / `E2E_VENDOR_PASSWORD` | `TestVendor123!` |
| `admin` | `admin@test.proplane.local` | `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` | `TestAdmin123!` |

All four are created by `npm run test:seed` against the dev/test project. If
your dev environment seeded custom passwords via these same `E2E_*` vars
(e.g. in `.env.test`), set the identical vars in `.env.local` (gitignored,
never commit) so this route signs in with the password that actually matches
what was seeded.

## Studio wiring (`~/proplane-mock-kit`)

- `studio/studio.js`: `liveUrlFor()` resolves the current replica route
  (`state.portal/section/tab/id`) against `proto/tools/routes.json`'s
  `routes[].real.path` (falls back to a best-guess path for a route the
  generator hasn't captured yet), maps the portal to a sign-in role
  (`studioSignInRoleForPortal` — public pages skip sign-in entirely), and
  points the iframe at `/api/dev/studio-sign-in?as=<role>&next=<realPath>` on
  whichever branch/port `state.liveBranch` selects.
- The `#frame-source` Proto/Live select (`studio/studio.html`) was previously
  removed from the markup while `studio.js`'s wiring for it stayed dead code,
  and two `state.frameSource = "proto"` overrides forced Proto even after a
  captain's own explicit `?source=live` — both restored/removed together with
  this change, since Live mode was otherwise unreachable regardless of the
  header/cookie fixes above.
