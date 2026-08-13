# Supabase and Stripe setup (PropLane)

This app uses **Supabase Auth** for logins and **Stripe Checkout** (subscription mode) so managers pay before creating a password. Portal tables are empty until you wire your own queries; **public listings** still use local mock inventory.

## 1. Supabase

1. Create a project at [https://supabase.com](https://supabase.com).
2. In **Project Settings → API**, copy:
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (keep secret; server-only)
3. Apply the schema with the Supabase CLI (do **not** copy migrations into the SQL Editor by hand — that lets environments drift). Install the CLI, then from the repo root:
   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   npm run db:push        # applies everything in supabase/migrations/
   ```
   PropLane runs two projects (a shared dev/test project and production) that are kept
   identical via these migrations. See [`docs/database-environments.md`](docs/database-environments.md)
   for the full two-project model and the dev → prod push workflow.
4. **Authentication → Providers**: enable **Email** (password). Enable **Google** and add your Google OAuth client ID/secret (see below). For development you may disable **Confirm email** under Auth settings so sign-up can insert `profiles` immediately; in production keep confirmations on and confirm email before expecting a `profiles` row from client sign-up.
5. **Authentication → URL configuration** (Auth): set site URL to your production domain (`NEXT_PUBLIC_CANONICAL_APP_URL` or `NEXT_PUBLIC_APP_URL`; production is `https://prop-lane.space`) and add redirect URLs. The authoritative production allowlist — including the native-app callbacks and the retained legacy `axis-seattle-housing.com` entries — is in [`docs/mobile-app.md` → Google sign-in (native app)](docs/mobile-app.md); Apple callbacks are in [`docs/apple-sign-in-setup.md`](docs/apple-sign-in-setup.md). For local dev also add:
   - `http://localhost:3000/auth/callback`, `http://localhost:3000/auth/callback/partner-pricing`, and `http://localhost:3000/auth/callback/resident-signup` (exact paths — no `?next=` query on OAuth redirect URLs)
   - Optional: `http://localhost:3000/**` wildcard if you use older callback links with query params

For shareable onboarding links and QR codes, set `NEXT_PUBLIC_CANONICAL_APP_URL` to your custom domain so links do not use the default `*.vercel.app` deployment URL.

### Profiles and manager purchases

- `profiles`: one row per user (`id` = `auth.users.id`), `role`, optional `manager_id`, `application_approved` for residents.
- `manager_purchases`: written when Stripe checkout completes; links `stripe_checkout_session_id`, `email`, `manager_id`, and later `user_id` when the manager finishes password setup. (Apple In-App Purchase on iOS writes the same table via the RevenueCat webhook — see `docs/agents/apple-iap.md`.)

### Google sign-in

1. In [Google Cloud Console](https://console.cloud.google.com/), create an OAuth 2.0 **Web application** client.
2. Add **Authorized redirect URI**: `https://<your-supabase-project-ref>.supabase.co/auth/v1/callback`
3. In Supabase **Authentication → Providers → Google**, paste the client ID and secret, then enable Google.
4. In Google Cloud **Credentials → your OAuth client → Authorized redirect URIs**, add **only** the Supabase callback (copy from Supabase Google provider screen):

   `https://<your-project-ref>.supabase.co/auth/v1/callback`

   Do **not** put your website URL (`https://prop-lane.space/auth/callback`) here — that causes `redirect_uri_mismatch`.

5. Ensure `{your-domain}/auth/callback` is listed under Supabase **Authentication → URL configuration → Redirect URLs** (not in Google Cloud redirect URIs).
6. Users sign in at `/auth/sign-in` via **Continue with Google**. Existing PropLane accounts match by email; new Google users without a profile are sent through `/auth/continue` (create an account first if you are not already provisioned).

### Google “Continue to …” branding (show PropLane, not supabase.co)

Google’s account picker shows **“to continue to {domain}”** based on your OAuth client’s **redirect URI host**. With Supabase Auth, that host is `*.supabase.co`, so users may see `qahnczmilgptcedaqype.supabase.co` until you brand the consent screen.

**In [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → OAuth consent screen:**

1. Set **App name** to `PropLane`.
2. Upload your **App logo** (square, at least 120×120 px — use the PropLane mark, `public/brand/proplane-mark.svg`).
3. Set **User support email** and **Developer contact** to your team address.
4. Under **Authorized domains**, add `prop-lane.space` (and `supabase.co` if not already present).
5. Add **Application home page**: `https://prop-lane.space`
6. Add **Privacy policy** and **Terms of service** URLs on your domain (required for production / verification).
7. Publish the consent screen to **Production** when ready (Testing mode only allows listed test users).

After saving, new sign-ins should show your **PropLane** name and logo (like other apps’ “Continue to Yelp” screen). The subtitle may still mention the Supabase hostname in some cases; fully replacing it requires a [Supabase custom auth domain](https://supabase.com/docs/guides/auth/auth-helpers/auth-ui#custom-domains) (paid add-on) so the redirect host is `auth.prop-lane.space`.

**Checklist:**

| Where | What to set |
|-------|-------------|
| Google OAuth consent screen | App name **PropLane**, logo, home page, privacy/terms |
| Google Credentials → OAuth client | Redirect URI = `https://<project-ref>.supabase.co/auth/v1/callback` only |
| Supabase → Auth → URL config | Site URL = `https://prop-lane.space`; redirect URLs per [`docs/mobile-app.md` → Google sign-in (native app)](docs/mobile-app.md) |
| Supabase → Auth → Google provider | Same Google client ID + secret as Cloud Console |

### Manager personal Google Calendar (per-manager OAuth)

Sign-in Google OAuth (above) is separate from **Calendar sync**. Each manager connects **their own** Google account from **Portal → Calendar**. Tokens are stored per manager in `manager_automation_settings.google_calendar` — managers never see each other's Google events.

**One-time app setup (deploy admin):**

1. In Google Cloud Console, create or reuse an OAuth 2.0 **Web application** client.
2. Enable the **Google Calendar API** for the same project: APIs & Services → Library → search “Google Calendar API” → **Enable**. (Without this, connect succeeds but event sync fails.)
3. Add **Authorized redirect URIs** (use the port you open in the browser — each port needs its own URI unless `GOOGLE_CALENDAR_REDIRECT_ORIGIN` is set):
   - `http://localhost:3010/api/portal/google-calendar/callback` (Cursor 1)
   - `http://localhost:3010/api/portal/gmail-payments/callback` (Gmail payment tracking — same port as calendar when using redirect override)
   - `http://localhost:3009/api/portal/google-calendar/callback` (prakrit integration)
   - `http://localhost:3009/api/portal/gmail-payments/callback`
   - `http://localhost:3011/api/portal/google-calendar/callback` (Cursor 2)
   - `http://localhost:3011/api/portal/gmail-payments/callback`
   - Production: register **every** live domain (canonical + legacy), or set `GOOGLE_CALENDAR_REDIRECT_ORIGIN` to the one origin Google Cloud allowlists:
   - `https://prop-lane.space/api/portal/google-calendar/callback`
   - `https://prop-lane.space/api/portal/gmail-payments/callback`
   - `https://www.prop-lane.space/api/portal/google-calendar/callback`
   - `https://www.prop-lane.space/api/portal/gmail-payments/callback`
   - `https://www.axis-seattle-housing.com/api/portal/google-calendar/callback` (legacy host — still live)
   - `https://www.axis-seattle-housing.com/api/portal/gmail-payments/callback`
   - When only one origin is registered in Google Cloud, PropLane maps every production host to `NEXT_PUBLIC_CANONICAL_APP_URL` / `NEXT_PUBLIC_APP_URL` for the OAuth callback automatically.
4. Set `GOOGLE_CALENDAR_CLIENT_ID` and `GOOGLE_CALENDAR_CLIENT_SECRET` in `.env.local` / Vercel.
   Use the **same** Google OAuth client ID and secret as Supabase **Authentication → Providers → Google** so sign-in tokens work for calendar sync.
5. Apply migration `20260723220000_google_calendar_integration.sql` on Supabase.

**Per manager:** managers who **create an account with Google** automatically request Calendar scopes during sign-in; tokens are saved when provisioning finishes (no manual **Connect** step when Supabase returns provider tokens). If inline tokens are missing, the app redirects through calendar OAuth once after account setup.

**Allow any manager Google account (no per-user test-user list):** publish the OAuth consent screen to **In production** in Google Cloud. Testing mode only allows manually listed test users — that restriction is enforced by Google, not PropLane. Production still requires privacy policy and terms URLs; Calendar scopes may need Google verification.

#### Error: `Access blocked` / `403 access_denied` on Google’s sign-in page

Google shows this **before** PropLane receives a token. The OAuth consent screen is in **Testing** mode, so only emails listed as **Test users** may authorize the app (named “axis” or similar in Cloud Console).

Fix (pick one):

1. **Development (fastest):** [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → **OAuth consent screen** → **Test users** → **Add users** → add every Google account that will connect Calendar (e.g. `ramachandranprakrit@gmail.com`, `founders@axis-seattle-housing.com`). Save, then retry **Connect** on `http://localhost:3010`.
2. **Production:** Publish the consent screen to **In production** (requires privacy policy URL, terms, and possibly Google verification for sensitive scopes like Calendar).

This is not a redirect-URI or localhost bug — Connect is reaching Google correctly; Google is refusing the account until it is on the test-user list or the app is published.


Use these exact values when configuring Google + Supabase for the live site:

| Setting | Value |
|---------|--------|
| Supabase project URL | `https://qahnczmilgptcedaqype.supabase.co` |
| Google **Authorized redirect URI** (Google Cloud only) | `https://qahnczmilgptcedaqype.supabase.co/auth/v1/callback` |
| Supabase **Site URL** | `https://prop-lane.space` |
| Supabase **Redirect URLs** | Every entry in `httpsCallbackUrls` from `https://prop-lane.space/api/auth/oauth-providers` — must include **both** `https://prop-lane.space/auth/callback` and `https://www.axis-seattle-housing.com/auth/callback` (and the partner-pricing / resident-signup / vendor-signup variants for each live domain), plus the localhost dev entries from step 5 above and the native scheme entries in [`docs/mobile-app.md`](docs/mobile-app.md) |
| App OAuth callback (this website) | `https://prop-lane.space/auth/callback` and `/auth/callback/partner-pricing` for Partner pricing Google signup |

Verify live config: open `https://prop-lane.space/api/auth/oauth-providers` — it should report `googleEnabled: true` and the redirect URIs above.

#### Error: `Unable to exchange external code`

This means **Supabase could not trade Google's authorization code for a session** — the failure happens before your app runs (users land on the homepage with `?error=server_error`).

Fix in this order:

1. **Google Cloud Console → Credentials** — OAuth client must be type **Web application** (not Desktop).
2. **Authorized redirect URIs** must include exactly `https://qahnczmilgptcedaqype.supabase.co/auth/v1/callback` — do **not** put `https://prop-lane.space/auth/callback` here.
3. **Supabase → Authentication → Providers → Google** — paste the **same** Client ID and Client secret from that Google OAuth client (re-copy if the secret was ever rotated). Save and re-enable Google.
4. **Supabase → Authentication → URL configuration** — Site URL and redirect URLs as in the table above.
5. Retest at `/auth/sign-in` → Continue with Google. After OAuth works, paid manager signup (Pro/Business → Continue with Google) will proceed to Stripe checkout.

### Tenant screening (Certn)

1. Create a [Certn](https://certn.co) partner account with API access (pay-per-report).
2. Set `CERTN_API_KEY` and `CERTN_WEBHOOK_SECRET` in `.env.local`.
3. In Certn **Partner settings**, enable webhooks pointing to `{NEXT_PUBLIC_APP_URL}/api/webhooks/screening/certn`.
4. Managers choose screening mode on **Applications** → **Off**, **Manual per applicant**, or **Auto on submit**.
5. Each report bills the manager’s Stripe card on file (`SCREENING_COST_CENTS`, default $39.99) before Certn is called.

## 2. Stripe

1. Create or open your [Stripe Dashboard](https://dashboard.stripe.com).
2. **Developers → API keys**: copy **Secret key** → `STRIPE_SECRET_KEY`.
3. **Product catalog**: create **subscription** recurring prices for **Pro** and **Business** (monthly and annual). **Free does not use Stripe** — signup uses `/api/manager/signup-intent` with no card. Copy each **Price ID** (`price_...`) into the matching env var in `.env.example`:
   - `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_ANNUAL`, etc.
   - Or run `npm run stripe:setup-plans` (requires `STRIPE_SECRET_KEY` in `.env.local`) to create/verify products and write price IDs automatically.
4. **Developers → Webhooks → Add endpoint**  
   - URL: `{NEXT_PUBLIC_APP_URL}/api/stripe/webhook`  
   - Events: at minimum `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.updated`, `customer.subscription.deleted`, and `invoice.paid`  
   - Copy **Signing secret** → `STRIPE_WEBHOOK_SECRET`
   - **Local dev:** `npm run stripe:listen` (requires [Stripe CLI](https://stripe.com/docs/stripe-cli)) and paste the printed `whsec_…` into `.env.local`
5. Use **Stripe test mode** locally; use **live keys** only in production with live price IDs. See [`docs/stripe-go-live.md`](docs/stripe-go-live.md) for the full go-live checklist.

Validate env wiring:

```bash
npm run stripe:validate        # test or live — checks keys + prices
npm run stripe:validate-live   # fails unless sk_live_ / pk_live_ are set
```

### Promo `FREEFIRST` (first month free, Pro monthly only)

Checkout only shows the Stripe promotion-code field for **Pro + monthly**; the app rejects `FREEFIRST` for any other tier/billing.

1. In **Product catalog**, open your **Pro monthly** recurring price and copy its **Price ID** (`price_…`).
2. **Product catalog → Coupons → Create coupon**:
   - **Percent off**: `100` (or use **Amount off** equal to one month if you prefer).
   - **Duration**: **Once** (applies to the first subscription invoice = first month on monthly billing).
   - **Applies to**: **Specific products** → choose the product that contains **only** the Pro monthly price, or use **Eligible items** so the coupon applies exclusively to that `price_…` (Stripe UI: restrict to the Pro monthly price so it cannot be used on Business or annual).
3. **Product catalog → Coupons** → open the coupon → **Promotion codes** → **Add promotion code**:
   - **Code**: `FREEFIRST` (must match exactly; codes are not case-sensitive in Stripe for entry, but use this spelling).
4. Test in Checkout (Pro, Monthly): the embedded form includes “Add promotion code”; enter `FREEFIRST` and confirm the first invoice is $0.

## 3. Local environment

Copy `.env.example` to `.env.local` and fill all variables. Set:

```bash
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Restart `npm run dev` after changes.

## 4. Flows implemented

| Flow | What happens |
|------|----------------|
| **Manager paid signup** | Partner pricing → `POST /api/stripe/checkout` → Stripe → success → `/auth/create-manager?session_id=...` → `POST /api/auth/manager-signup` creates Supabase user + `profiles` row with `manager_id` from checkout metadata. |
| **Webhook** | `checkout.session.completed` upserts `manager_purchases` (idempotent). |
| **Sign in** | `/auth/sign-in` uses `signInWithPassword` and reads `profiles.role` for redirect. |
| **Resident / owner** | `/auth/create-account` uses `signUp` + client `profiles` insert (requires RLS insert policy and usually email confirm off in dev). |
| **Admin** | `POST /api/auth/register-admin` validated server-side against the server-only `AXIS_ADMIN_REGISTER_KEY` (never sent to the browser). |

## 5. Your checklist

- [ ] Apply migrations with `npm run db:push` (CLI), not the SQL Editor.
- [ ] Set all Supabase env vars in hosting (Vercel, etc.). Production Supabase creds live in Vercel only; local `.env` points at the dev/test project. See [`docs/database-environments.md`](docs/database-environments.md).
- [ ] Set `FINANCIALS_TIN_ENCRYPTION_KEY` (32+ character random secret) before using manager Financials 1099 / vendor W-9 tax profiles. Required server-side; without it, TIN encrypt/decrypt endpoints fail closed.
- [ ] Create Stripe prices and webhook; set Stripe env vars.
- [ ] Set `NEXT_PUBLIC_APP_URL` to production origin.
- [ ] Set a strong random `AXIS_ADMIN_REGISTER_KEY` in production (admin registration is disabled if unset). Remove any legacy `NEXT_PUBLIC_AXIS_ADMIN_REGISTER_KEY` and rotate the previously exposed key.
- [ ] Set `AXIS_PAYMENT_WAIVER_CODE` only if you intend to allow a Stripe-bypass code in production (waiver is disabled when unset).
- [ ] Decide email confirmation policy for Auth.
- [ ] Replace empty portal UI with real queries when backends are ready.
