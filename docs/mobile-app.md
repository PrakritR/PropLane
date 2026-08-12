# Axis native apps (iOS + Android)

Axis ships to the App Store and Google Play as a **Capacitor** native shell that
loads the live, server-rendered site (`https://prop-lane.space`).
The app reuses 100% of the web app — auth, Stripe, the manager/resident/admin
portals — and adds real native capabilities (push notifications, camera) on top.

The shell now points at the canonical PropLane origin (`https://prop-lane.space`,
`PRODUCTION_APP_ORIGIN` in `src/lib/app-url.ts`); the legacy
`www.axis-seattle-housing.com` host stays live and is still recognized as
production, and its deep links remain declared so already-installed builds keep
working. Repointing the WebView means changing `capacitor.config.ts` +
`CAP_SERVER_URL` — a native-shell rebuild. **Note:** because WebView session
cookies are scoped per registrable domain, an installed app that updates to a
build loading the new domain starts with no session and prompts a one-time
re-login; this is inherent to the domain cutover, not a bug.

- **Web/UI changes ship instantly** via your normal Vercel deploy. No app-store
  review needed for content or UI — the WebView always loads the latest site.
- **Native-shell changes** (new plugins, icons, permissions, the Capacitor
  version) require rebuilding and resubmitting the app.

**Web + native parity:** see [`docs/web-and-native-parity.md`](web-and-native-parity.md)
for the checklist and registries that keep browser and app behavior aligned.

---

## Payments (web vs native app)

| Flow | Web | iOS / Android app |
| --- | --- | --- |
| **Manager subscription** (Pro / Business) | Stripe Checkout — card or Apple Pay | **Apple In-App Purchase** (StoreKit via RevenueCat) on iOS — never a web purchase link (App Store 3.1.1); see [`docs/agents/apple-iap.md`](agents/apple-iap.md) |
| **Resident rent & fees** | Bank (ACH), card (Apple Pay / Google Pay or typed card), or Link via Stripe | Bank (ACH) or card (Apple Pay in Checkout when eligible) via Stripe — no Link |

Per-surface pay methods come from `residentPaymentMethodsForSurface()` (`src/lib/platform/resident-payments.ts`); the app drops Link. The card rail surfaces Apple Pay through Stripe Checkout on web and in the app when the device and domain are eligible. Setup: [`docs/stripe-apple-pay-payments.md`](stripe-apple-pay-payments.md) (rent + application fees), [`docs/stripe-apple-pay-subscriptions.md`](stripe-apple-pay-subscriptions.md) (subscriptions).

---

## App identity (iOS rebranded to PropLane; Android deferred)

The **iOS** bundle identifier is `space.proplane.app` (Team `8FH3GVHCZ9`, App Store
Connect **App ID 6795707576**) — rebranded from the legacy
`com.axisseattlehousing.app`. The old App Store Connect record is abandoned
deliberately (the app is TestFlight-only, never publicly launched), so there
are no compatibility shims.

⚠️ **The legacy record is still live and still installable, and its build numbers
are HIGHER** (49 vs the canonical record's 37) because it kept shipping until the
rebrand. It now displays as "PropLane Legacy". Build numbers across the two records
are **not comparable** — a higher number on the legacy record is an *older*,
orphaned app. Never ship to or modify the legacy record. To see which one a device
actually has installed:

```
/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" \
  /Applications/PropLane.app/Wrapper/*.app/Info.plist
```

The identity lives in `capacitor.config.ts` (`appId`),
`ios/App/App.xcodeproj/project.pbxproj` (`PRODUCT_BUNDLE_IDENTIFIER`, both configs),
`ios/App/App/Info.plist` (the custom URL scheme), `ios/App/fastlane/{Appfile,Fastfile}`,
`public/.well-known/apple-app-site-association` (`8FH3GVHCZ9.space.proplane.app`), and
the shared `NATIVE_OAUTH_SCHEME` / `IOS_BUNDLE_ID` constants under `src/lib/auth/`.

**Android still uses `com.axisseattlehousing.app`** — `android/app/build.gradle`
(`applicationId` + `namespace`), `AndroidManifest.xml` (deep-link scheme),
`MainActivity.java`'s package, and `public/.well-known/assetlinks.json`. Android is not
shipping (its `assetlinks.json` still holds a placeholder keystore fingerprint), and a
correct rename requires moving the Java source package and minting a new Play identity,
so it was left intact and internally consistent. Rename it as one unit when Android ships.

**Console-side follow-ups the bundle-id change requires** (repo code cannot do these):
add `space.proplane.app` to Supabase → Auth → Providers → **Apple** Client IDs; add
`space.proplane.app://auth/callback/**` to Supabase → Auth → URL configuration → Redirect
URLs (native Google/Apple OAuth returns via this custom scheme — there is no Google
reversed-client scheme in this repo); register the new App ID `space.proplane.app` in
Apple Developer with Sign in with Apple + Associated Domains + Push enabled; and create
the App Store Connect record + IAP products for the new id. The IAP product ids are now
`space.proplane.app.pro.monthly` / `.business.monthly` in-repo
(`src/lib/manager-apple-purchase.ts`) — App Store Connect + RevenueCat must be created with
those exact ids (see [`docs/agents/apple-iap.md`](agents/apple-iap.md)). The
`com.axisseattlehousing.app.web` Services ID is a separate identifier, left unchanged in-repo
pending that console work.

## What's already in the repo

| Path | Purpose |
| --- | --- |
| `capacitor.config.ts` | App id `space.proplane.app`, name **PropLane**, points the WebView at production. |
| `native-shell/index.html` | Branded "you're offline" fallback (Capacitor's required `webDir`). |
| `src/components/native/native-bridge.tsx` | Mounted in the root layout. On native only: hides splash, styles the status bar, registers push, opens deep links. No-ops on the web. |
| `src/app/api/native/register-push-token/route.ts` | Stores a device token for the signed-in user. |
| `supabase/migrations/20260628120000_device_push_tokens.sql` | `device_push_tokens` table. |
| `src/lib/push-notifications.server.ts` | `sendPushToUser()` — delivers via Firebase Cloud Messaging. No-ops until `FCM_*` env is set. |
| `src/lib/native/use-native-camera.ts` | `useNativeCamera()` — native camera/library picker, web file-input fallback. |

Apply the migration with your normal flow (e.g. `npm run db:apply-sql`) before
testing push.

---

## Local development (simulator — mobile UI)

Unreleased mobile UI (`/auth/welcome`, native chrome, bottom tabs) only appears
when the WebView loads a server that has that code — usually **your local dev
server**, not production.

```bash
npm run dev              # terminal 1 — keep running
npm run cap:dev          # auto-detects Mac LAN IP for physical iPhone (simulator works too)
npm run cap:ios          # open Xcode, then Run (⌘R)
```

**In Xcode, pick a simulator** (e.g. iPhone 16) — **not** “Any iOS Device
(arm64)”. Simulator builds do not need provisioning profiles.

`npm run cap:dev` writes your Mac's LAN IP into the iOS project (e.g.
`http://192.168.1.50:3000/auth/welcome`). **Physical iPhones cannot use
`localhost`** — phone and Mac must be on the same Wi‑Fi, and `npm run dev` must
be running. Override with `CAP_SERVER_URL` if needed:

```bash
CAP_SERVER_URL=http://192.168.1.50:3000 npm run cap:sync
```

**TestFlight / App Store builds** use production (`npm run cap:prod`). The app opens
`/auth/sign-in`, which shows the native welcome role picker (Resident / Manager).

---

## Prerequisites (install once, on this Mac)

1. **Xcode** (full app, from the Mac App Store — ~7 GB). Then point the command
   line at it and accept the license:
   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   sudo xcodebuild -license accept
   ```
2. **CocoaPods**: `brew install cocoapods`
3. **Android Studio** (https://developer.android.com/studio). On first launch it
   installs the Android SDK. Then add to your shell profile:
   ```bash
   export ANDROID_HOME="$HOME/Library/Android/sdk"
   export PATH="$PATH:$ANDROID_HOME/platform-tools"
   ```
   (Java 21 is already installed and is fine for the Android build.)

---

## One-time: create the native projects

From the repo root, after the prerequisites are installed:

```bash
npx cap add ios
npx cap add android
```

This scaffolds `ios/` and `android/` (committed to git; build artifacts are
git-ignored). The **iOS** app icon and splash screen are generated from the
canonical **PropLane** mark (rounded house/chevron outline + crossing X):

```bash
# Regenerate every derived PropLane raster anytime (sharp is a devDependency):
node scripts/generate-brand-assets.mjs
```

That script is the source of truth for every raster surface. It reproduces the
canonical mark geometry (`src/lib/brand/proplane-mark.ts` — see AGENTS.md,
“Brand assets (PropLane)”) in the PropLane blue (`src/app/globals.css`) and
writes, in one pass:

- `src/app/favicon.ico` — the browser-tab icon (16/32/48/256 PNG entries).
- `icons/icon-{48,72,96,128,192,256,512}.webp` — the PWA manifest icon set
  (`public/manifest.webmanifest`).
- `resources/icon.png` (1024×1024) + `resources/splash.png` (2732×2732) — the
  `@capacitor/assets` sources.
- `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png` — the
  shipped iOS marketing icon (opaque white tile + blue mark).
- `ios/App/App/Assets.xcassets/Splash.imageset/` — the launch image referenced
  by `Base.lproj/LaunchScreen.storyboard` (dark `#080b14` bg + centered white
  tile + blue mark).
- `src/lib/reports/export/assets/axis-logo-mark.png` — the transparent logo
  embedded in exported PDFs (`src/lib/reports/export/pdf-theme.ts`).

Every opaque PNG it writes is **RGB with no alpha channel** — App Store Connect
rejects a marketing icon that carries one (ITMS-90717 "Invalid App Store
Icon"), and a simulator build will not catch it. The script asserts this after
each write, so keep any new output going through its `opaquePng()` helper.

To swap in designer artwork instead, replace `resources/icon.png` +
`resources/splash.png` and fan them out to every derived size:

```bash
# @capacitor/assets prefers ./assets and only falls back to ./resources when
# assets/ is absent. The repo's tracked Assets/ dir (capital A — lease notes)
# matches that probe on case-insensitive macOS/Windows filesystems, so name
# resources/ explicitly rather than relying on the fallback.
npx @capacitor/assets generate \
  --assetPath resources \
  --splashBackgroundColor '#080b14'
```

**Android still ships the legacy "AX" lettermark.** The generator above is iOS
only; `android/app/src/main/res/mipmap-*/ic_launcher.png` and the
`drawable-*/splash.png` variants are untouched Capacitor scaffolding and are
tracked as a separate follow-up. Every non-Android user-visible surface should
read PropLane.

---

## Day-to-day workflow

```bash
npm run cap:sync     # after plugin / native config changes
npm run cap:ios      # Xcode → Run on a simulator
npm run cap:android  # Android Studio → Run
```

See **Local development (simulator — mobile UI)** above for unreleased branch
testing. Production WebView changes ship via Vercel deploy — no app rebuild.

---

## Troubleshooting Xcode builds

### “Build Failed” with destination **Any iOS Device (arm64)**

That target is for **physical devices / App Store archives**. It requires a
**Development Team** and provisioning profile. The repo sets team
`8FH3GVHCZ9` in `ios/App/App.xcodeproj/project.pbxproj`.

**For daily UI work:** switch the run destination to an **iPhone Simulator**
(e.g. iPhone 16 Pro). Simulator builds use “Sign to Run Locally” and skip
provisioning.

### “Signing requires a development team” / Personal Team warnings

1. **Xcode → Settings → Accounts** — sign in with your paid Apple Developer ID.
2. **App target → Signing & Capabilities** — Team = **Prakrit Ramachandran**
   (paid, `8FH3GVHCZ9`), **not** “(Personal Team)”.
3. Keep **Automatically manage signing** enabled → **Try Again**.

`npx cap sync` can strip `DEVELOPMENT_TEAM` from `project.pbxproj`. If signing
breaks after sync, restore the team in Xcode or re-commit the pbxproj lines.

### Emulator shows the **website** (navbar, “Portal sign-in”) instead of mobile UI

The WebView loads whatever URL is in `ios/App/App/capacitor.config.json`:

| `server.url` | What you see |
| --- | --- |
| `https://prop-lane.space/...` | Production website (old UI until deployed) |
| `http://127.0.0.1:3000/auth/welcome` | Local mobile welcome (Resident / Manager) |

Run `npm run cap:dev` with `npm run dev` running, then rebuild in Xcode.

### Xcode Cloud is retired — GitHub Actions is the only TestFlight pipeline

**Do not build this app with Xcode Cloud.** The one build+upload path is the
GitHub Actions workflow
[`.github/workflows/ios-testflight.yml`](../.github/workflows/ios-testflight.yml),
which on every push to `production` (and on `workflow_dispatch`) runs `npm ci`,
`npx cap sync ios` at the production `CAP_SERVER_URL`, the
`scripts/verify-cap-prod-config.sh` Release guard, `fastlane beta` to upload
to TestFlight, and `scripts/ios-testflight-distribute.mjs` to make the build
installable. It self-skips until the `ASC_*` secrets exist.

#### The distribute step is what makes a build installable

`fastlane beta` uses `skip_waiting_for_build_processing: true` so the macOS job
isn't billed for Apple's processing queue. That option is mutually exclusive with
tester-group assignment (pilot needs a processed build to assign one), which is
how builds 33-37 shipped as green runs that no tester could install — uploaded,
"Complete", **empty Groups column**, zero invites.

`scripts/ios-testflight-distribute.mjs` closes it, talking to the App Store
Connect API directly (ES256 JWT from the same `ASC_*` secrets, no extra deps):

1. Resolve `space.proplane.app` → app id and **assert it is 6795707576**. Bundle
   id → app id is pinned so a build can never land on the abandoned legacy record.
2. Resolve the beta group by **exact name** (`Internal — PropLane team`, em dash,
   override with `TESTFLIGHT_INTERNAL_GROUP`). No match → fail and print every
   group that does exist. Matched an *external* group → fail; external testing
   needs App Review and is never enabled here.
3. Poll `builds?filter[version]=<n>` every 20s until `processingState = VALID`,
   logging elapsed time and state each tick, bounded by
   `TESTFLIGHT_PROCESSING_TIMEOUT_SECONDS`, which defaults to (and is capped at) the
   largest wait that still leaves the step budget room to assign and verify — both
   are derived from `STEP_BUDGET_SECONDS` and the poll intervals, never typed in,
   and a unit test asserts that budget still equals the distribute step's own
   `timeout-minutes`. A failed read is a tick, not the end of the wait, **only when
   the request layer tagged it retryable** (transport error, 429, 5xx): an App Store
   Connect blip inside the deadline no longer reds a promote whose build is fine,
   while a 401, a 403, any permanent 4xx, or an untagged error surfaces immediately
   with its own message instead of being re-read to the deadline and reported as
   Apple being slow. `FAILED`/`INVALID` and a build number matching more than one
   build still fail immediately. The timeout message names which case it was —
   still processing, read once and then unreadable, or never readable at all — so
   those are never confused for one another.
4. Assign the build to the group, then **re-read
   `builds?filter[id]=<buildId>&filter[betaGroups]=<groupId>`** and fail unless
   the build is present. The exit code reflects a fresh API read, not the POST's
   status code — a failed assignment can never look green, and conversely a POST
   that errors (a retry landing on 409 "already exists") does not fail a build the
   API says *is* assigned. The read is re-polled a few times over ~1 min because
   that filter is search-index-backed and can lag the write; re-polling only
   prevents a false red, it never softens the verdict. The query is exact rather
   than a page of the group's builds, so a group with hundreds of accumulated
   builds can never report a correctly-assigned build as missing.
5. Report `buildBetaDetail` (`internalBuildState` / `externalBuildState`) and pass
   **only** on an affirmatively installable `internalBuildState` —
   `READY_FOR_BETA_TESTING` or `IN_BETA_TESTING`. `PROCESSING` and
   `IN_EXPORT_COMPLIANCE_REVIEW` are TRANSIENT — `buildBetaDetail` lags
   `build.processingState` because they are separate resources on separate
   backends — so they are re-polled for ~60s and then fail closed; re-polling only
   prevents a false red, it never softens the verdict. Every other value reds the
   run immediately: `MISSING_EXPORT_COMPLIANCE`, `PROCESSING_EXCEPTION`,
   `EXPIRED`, an absent state, an unreadable one, and any
   value Apple adds later. It is an **allowlist, not a denylist of bad states**,
   because a denylist passes everything it has not heard of — that is how an
   absent state (an empty body read as `{}`) once slipped through and silently
   defeated the fail-closed guarantee. Every request retries transport errors and
   5xx (node's `fetch` *rejects* on a dropped socket, so that is caught, not just
   status codes), so an unreadable state is a real unknown, and the step fails
   closed rather than reporting success it cannot support. Only a *retryable*
   failure becomes that unknown: a credential or permanent-4xx failure on the
   `buildBetaDetail` read is re-thrown with its own message rather than dressed up
   as an unknown beta state.

The build number comes from the fastlane step's `build_number` output, not from
"latest build", so a concurrent upload can't cause the wrong build to be
distributed. Export compliance is answered declaratively by
`ITSAppUsesNonExemptEncryption` in `ios/App/App/Info.plist` — a build missing that
key stays un-installable regardless of group assignment, and step 5 catches it.

Rerunning is safe and idempotent (already-assigned builds are detected and left
alone). To backfill a stranded build or just inspect state:

```
export ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_P8_PATH=~/AuthKey_XXXX.p8
node scripts/ios-testflight-distribute.mjs --build=37
node scripts/ios-testflight-distribute.mjs --build=37 --verify-only   # read-only
```

`--verify-only` answers "is build N installable right now": one read of each
resource, no waiting and no re-polling, so a build Apple is still processing is
reported as such immediately instead of blocking. Drop the flag to wait and
distribute.

Xcode Cloud was a redundant second pipeline that did the same thing. It failed
continuously (builds 54–97) because Apple only runs `ci_scripts/ci_post_clone.sh`
when that folder sits next to the Xcode project it builds (`ios/App/`), not at
the git repo root where ours lived — so the post-clone step never ran, no
`npm ci` / `npx cap sync` happened, and `xcodebuild` couldn't resolve the
Capacitor packages `CapApp-SPM/Package.swift` references from `node_modules`
(`the package at '…/node_modules/@capacitor/…' cannot be accessed`). Rather than
maintain two pipelines, Xcode Cloud was disabled in App Store Connect and its
`ci_scripts/ci_post_clone.sh` deleted (it was never invoked by the GitHub
workflow, which inlines the same steps). If you ever re-enable Xcode Cloud,
restore that script **inside `ios/App/ci_scripts/`**, not the repo root.

### “‘apple-sign-in’ depends on ‘capacitor-swift-pm’ 7.0.0..&lt;8.0.0”

Once `node_modules` exists, SPM hits a second conflict: the latest release of
`@capacitor-community/apple-sign-in` (7.1.0 — there is no Capacitor 8 build)
hard-pins `capacitor-swift-pm` to 7.x in its own `Package.swift`, while
`ios/App/CapApp-SPM/Package.swift` pins `exact: "8.4.1"` for the Capacitor 8
core plugins. `xcodebuild -resolvePackageDependencies` cannot satisfy both.

The fix is **[`patches/@capacitor-community+apple-sign-in+7.1.0.patch`](../patches/@capacitor-community+apple-sign-in+7.1.0.patch)**,
which widens that one dependency range to `"7.0.0"..<"9.0.0"`. The root
`postinstall` script runs `patch-package`, so **every `npm ci` re-applies it** —
the GitHub Actions build included — and a fresh clone is never left with the
unpatched plugin. The plugin's Swift source only uses
stable `CAPPlugin` / `CAPBridgedPlugin` APIs that exist in capacitor-swift-pm 8,
so widening the range is compile-safe.

Do **not** hand-edit `ios/App/CapApp-SPM/Package.swift` to work around this — it
is Capacitor-managed and `npx cap sync ios` regenerates it. Dropping the plugin
is also not an option: native Sign in with Apple uses it
(`src/lib/auth/native-apple-sign-in.ts`, see
[`docs/apple-sign-in-setup.md`](apple-sign-in-setup.md)). When the plugin
publishes a Capacitor 8 release, upgrade and delete the patch; bumping it to any
other 7.x means regenerating the patch under the new version-stamped filename.

---

## Push notifications

Both platforms are delivered through **Firebase Cloud Messaging (FCM)** — one
send path. Firebase relays to Apple devices via an APNs key you upload.

### 1. Firebase project
1. Create a project at https://console.firebase.google.com.
2. **Add an Android app** with package `com.axisseattlehousing.app` (the Android
   project still uses the legacy id — see the iOS-rebrand note below). Download
   `google-services.json` → place in `android/app/`.
3. **Add an iOS app** with bundle id `space.proplane.app`. Download
   `GoogleService-Info.plist` → add to `ios/App/App/` (drag into Xcode).
4. **Project settings → Cloud Messaging → Apple app config**: upload your **APNs
   Auth Key** (`.p8` from the Apple Developer portal → Keys → enable APNs).
5. **Project settings → Service accounts → Generate new private key**. From that
   JSON, set in your server env (Vercel + `.env.local`):
   ```
   FCM_PROJECT_ID=<project_id>
   FCM_CLIENT_EMAIL=<client_email>
   FCM_PRIVATE_KEY=<private_key with \n escapes>
   ```

### 2. Native capabilities
- **iOS (Xcode → Signing & Capabilities):** add **Push Notifications** and
  **Background Modes → Remote notifications**.
- **Android:** the `@capacitor/push-notifications` + `google-services.json` setup
  is handled by `npx cap sync`; no manual manifest edits needed for basic push.

### 3. Sending a push
`sendPushToUser()` is ready to call from any server code (cron jobs, API routes,
the existing notification modules):

```ts
import { sendPushToUser } from "@/lib/push-notifications.server";

await sendPushToUser(residentUserId, {
  title: "Rent due soon",
  body: "Your July rent is due in 3 days.",
  url: "/resident/payments", // opened when the notification is tapped
});
```

It looks up the user's active tokens, sends via FCM, and prunes dead tokens.
Until `FCM_*` is set it returns `{ sent: 0, skipped: true }` and changes nothing.

**Step-by-step Firebase setup:** see [`docs/firebase-push-setup.md`](firebase-push-setup.md).

### Google sign-in (native app)

Google OAuth must **not** run in the main WebView (`disallowed_useragent`). Platform paths:

- **iOS** — `ASWebAuthenticationSession` via `WebAuthSessionPlugin` (`ios/App/App/WebAuthSessionPlugin.swift`).
  Supabase `redirectTo` is the custom scheme (`space.proplane.app://auth/callback`); the session
  intercepts that callback natively. Do **not** use `@capacitor/browser` (SFSafariViewController) for
  OAuth on iOS — it cannot follow custom-scheme redirects.
- **Android** — Chrome Custom Tab (`@capacitor/browser`) + HTTPS callback with `native_bridge=1`
  (an HTML bridge page that deep-links into the custom scheme). `native_bridge=1` is the Android
  path only — current iOS builds never route through it.

After you pick an account, Supabase must redirect back into the Axis app — not the marketing homepage.

**1. Supabase redirect URLs** (Authentication → URL configuration → Redirect URLs). **Required:**

```
https://prop-lane.space/auth/callback
https://prop-lane.space/auth/callback/partner-pricing
https://prop-lane.space/auth/callback/resident-signup
https://www.axis-seattle-housing.com/auth/callback
https://www.axis-seattle-housing.com/auth/callback/partner-pricing
https://www.axis-seattle-housing.com/auth/callback/resident-signup
space.proplane.app://auth/callback
space.proplane.app://auth/callback/**
```

Android uses the HTTPS callbacks (bridge page). iOS OAuth uses the custom-scheme entries directly.

Both kinds of entry are required. If the one for the platform in use is missing, Supabase drops `redirect_to`, falls back to the **Site URL**, and sign-in opens the marketing homepage in the system browser instead of returning to the app.

**2. Universal / app links (https fallback)** — committed in `public/.well-known/`:

- `apple-app-site-association` — served as `application/json` (`next.config.ts` headers); iOS opens
  `/auth/callback` from email/deep links (not from in-app OAuth — universal links are suppressed
  inside SFSafariViewController / ASWebAuthenticationSession presented by the same app).
- `assetlinks.json` — Android; replace `REPLACE_WITH_RELEASE_KEYSTORE_SHA256` with your
  signing cert fingerprint (`keytool -list -v -keystore …`)

Deploy the site (Vercel) so those files are live, then `npx cap sync` and rebuild the native
app (Associated Domains entitlement is in `ios/App/App/App.entitlements`).

**3. Verify** — `GET /api/auth/oauth-providers` returns `nativeCallbackUrls` and
`nativeRedirectHint` for your environment.

**Suggested wiring** (alongside the existing SMS sends — push complements, not
replaces, Twilio): the rent/move-in reminder crons in
`src/app/api/cron/*` and the resident/manager notification modules in
`src/lib/*-notification*.ts`. Add a `sendPushToUser(...)` call wherever you
already resolve a recipient's user id.

### 4. Camera (native value-add)
Wire `useNativeCamera()` into document / property-condition photo uploads:

```tsx
const { capture } = useNativeCamera();
const shot = await capture();      // native picker in-app, file input on web
if (shot) await upload(shot.file); // shot.previewUrl for an <img> preview
```

The iOS permission prompts (`NSCameraUsageDescription`,
`NSPhotoLibraryUsageDescription`, `NSPhotoLibraryAddUsageDescription`) are
already committed in `ios/App/App/Info.plist` — edit them there. They are
user-visible at the permission prompt, so they must read **PropLane**.

---

## Shipping to the stores

### Accounts
- **Apple Developer Program** — $99/yr (https://developer.apple.com/programs/).
  Enrollment can take a day or two; start it early.
- **Google Play Console** — one-time $25 (https://play.google.com/console).

### iOS
1. In Xcode, set the team and a unique bundle id (`space.proplane.app`).
2. Product → Archive → distribute to **App Store Connect**.
3. In App Store Connect: create the app, add screenshots, description, privacy
   details (declare camera + push usage), then submit for review.

### Android
1. In Android Studio: Build → Generate Signed Bundle (**.aab**); create/keep a
   keystore safe (losing it blocks future updates).
2. In Play Console: create the app, complete the Data Safety form, upload the
   `.aab`, add a store listing, roll out to internal testing → production.

### Avoiding the "it's just a website" rejection (Apple Guideline 4.2)
This app already includes genuine native features — **push notifications** and
**camera capture** — which clears the bar. To be safe at review:
- Make sure the camera flow and push opt-in are reachable in the build you
  submit.
- Provide a demo reviewer account (resident + manager) in App Store Connect.
- Rent payments via Stripe are fine — they're real-world services, exempt from
  Apple's in-app-purchase requirement (which applies only to digital goods).
  The manager SaaS subscription is NOT exempt: it was rejected under Guideline
  3.1.1 and is bought in-app via StoreKit/RevenueCat on iOS — see
  [`docs/agents/apple-iap.md`](agents/apple-iap.md).

### A credential screen must survive iOS Password AutoFill (Guideline 2.1(a))
Build 69 was rejected because sign-in answered "Enter email and password." over
credentials the reviewer could plainly see on an iPad. Two rules for any
credential form the WebView renders:

- **A real `<form>` with `name`d fields**, not loose inputs in a `div`. iOS
  Password AutoFill and password managers identify credential fields by form
  membership and name, and the keyboard offers "Go" instead of "return" only
  inside one.
- **The submitted value comes from the DOM, not React state.** WebKit writes an
  autofilled value straight into the input and does not reliably fire a change
  event, so state can be empty or hold a stale remembered email while the box
  shows something else. `resolveFormCredentials`
  (`src/lib/auth/form-credentials.ts`) is that one decision — it takes email and
  password together so a pair that was never shown together can't be submitted.
  Coverage: `tests/unit/auth-credential-form-autofill.test.ts`.

---

## Updating the app later
- **Website / portal changes:** just deploy to Vercel. The apps pick it up on
  next launch. No resubmission.
- **Native changes** (Capacitor/plugins/icons/permissions): `npx cap sync`,
  bump the version in Xcode/Android Studio, rebuild, resubmit.
