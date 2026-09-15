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
install sheet. `tests/unit/app-store-assets.test.ts` fails a wrong pixel size,
an eleventh file, or copy over Apple's limits (170 / 4000 / 4000 / 100).

## Re-shoot the screenshots

Run a dev server with the seeded e2e manager (`npm run test:seed`), then:

```sh
npm run app-store:shots -- --base http://localhost:3000            # both devices
npm run app-store:shots -- --base http://localhost:3000 --device iphone
```

`scripts/ios-app-store-screenshots.mjs` signs in as
`manager2@test.proplane.local`, shoots each screen in `GALLERY` on the phone
and iPad viewports, frames it with its headline in PropLane's font, and
rewrites the two folders. It refuses a manager with fewer than three
properties. Look at the PNGs, then commit them — the next production push
uploads whatever is committed.

To change a headline or which screen a slot shows, edit `GALLERY` in the
script and re-run it. To change store text, edit `copy.json`; the legal-link
footer Apple requires is appended automatically.

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
