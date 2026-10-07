# app-store/ — the App Store product page, in the repo

Everything App Store Connect shows for PropLane on iOS lives here, and a push
to `production` ships it (see `.github/workflows/ios-testflight.yml`).

```
app-store/
├── copy.json                 promotionalText · description · whatsNew · keywords
└── screenshots/
    ├── iphone-6.9/           1320 × 2868 — Apple's required set; reused for every iPhone size
    └── ipad-13/              2064 × 2752 — reused for every iPad size
```

Apple shows at most ten screenshots per display; the first three are the
install sheet. Only these two sets are kept on the store version — any other
iPhone / iPad set (a hand upload for 6.5" or 11") is removed on release, because
Apple reuses the 6.9" and 13" sets for every size and a leftover set would show
an older app on some devices. `tests/unit/app-store-assets.test.ts` fails a wrong pixel size,
an eleventh file, or copy over Apple's limits (170 / 4000 / 4000 / 100).

## Re-shoot the screenshots

Seed the showcase manager once (dev/test project only; it writes `SHOT_EMAIL` /
`SHOT_PASSWORD` to the gitignored `.env.local`, and must be re-run after
`npm run test:seed`, which prunes it), start a dev server, then:

```sh
npm run app-store:seed
npm run app-store:shots -- --base http://localhost:3000            # both devices
npm run app-store:shots -- --base http://localhost:3000 --device iphone
```

`scripts/ios-app-store-screenshots.mjs` signs in as that showcase manager
(`SHOT_EMAIL` / `SHOT_PASSWORD`, from the environment or `.env.local`), captures each
screen in `GALLERY` (iPhone at 440x956 @3x, iPad at 834x1112 @3x), frames it and
rewrites the two folders. The frame is fixed: brand blue and navy alternating by slot,
the PropLane mark from `src/app/icon.svg`, a two-line headline with no subtext, and a
device that bleeds off the bottom edge; slots 02 and 05 are a zoomed crop card instead.
It refuses a manager with fewer than three properties, and it stops, rather than shoot
a wrong page, if a route redirects away (slot 08 is a resident's Move in section, slot
10 reaches Rooms through the phone Steps picker: both once silently broke), if an
element is missing, or if the page shows a test-fixture string or "work order".
Look at the PNGs, then commit them: the next production push uploads whatever is committed.

To change a headline or which screen a slot shows, edit `GALLERY` in the script and
re-run it. To change store text, edit `copy.json`; the legal-link footer Apple requires
is appended automatically.

## How it ships

On every push to `production`, after the TestFlight distribute step:

1. `scripts/ios-app-store-release.mjs --plan-version` decides the marketing
   version the build carries (the highest version Apple has seen, plus one
   patch; Xcode's `MARKETING_VERSION` is a floor for deliberate minor/major bumps).
2. The build is uploaded and distributed to TestFlight exactly as before.
3. `scripts/ios-app-store-release.mjs` creates or reuses the editable store
   version, syncs `copy.json` and both screenshot folders (only files whose
   MD5 differs from what the store holds are uploaded), attaches the build,
   submits for review, and reads back **Waiting for Review**. Release type is
   *after approval*, so an approved version goes live on its own.

It holds — and says so, green — when Apple is already reviewing a version. A
6-hourly catch-up run (`schedule`, or `workflow_dispatch` mode `release`)
submits the newest processed build once the queue is clear. A **rejected**
version is never resubmitted automatically: fix it, then run mode `release`
with `force_resubmit` on.

`workflow_dispatch` mode `release` with `dry_run` on prints every call it would
make against the live state without writing anything.
