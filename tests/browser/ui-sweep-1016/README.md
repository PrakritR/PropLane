# Oct 16 portal sweep — visual evidence

Two passes, no dev server, account or database:

```bash
EVIDENCE_DIR=/tmp/ui-sweep-1016 npx vitest run tests/unit/evidence-ui-sweep-1016.test.tsx
EVIDENCE_DIR=/tmp/ui-sweep-1016 PLAYWRIGHT_SKIP_WEBSERVER=1 \
  npx playwright test --config tests/browser/ui-sweep-1016.config.ts
```

1. `tests/unit/evidence-ui-sweep-1016.test.tsx` renders the REAL screens in jsdom
   (Customize dashboard, admin New message, the inbox composer with a failed attachment, the
   inbox work-identity boxes, the public tour scheduler, and a generated room lease) and dumps
   each one as an HTML page under `EVIDENCE_DIR`.
2. `shots.spec.ts` compiles the app's own Tailwind build from `src/app/globals.css`, drops it
   beside the dumps as `app.css`, screenshots every surface at desktop and phone width, and
   **measures the pop-up panels** — the Oct 16 decision is that a pop-up is the height of its
   content (up to 640) rather than a fixed 920 x 640 window, and a static class assertion
   cannot show that. It also reads the painted lease back to prove no birth date, SSN or
   licence is on the page.

The record header's fold is a measurement, and jsdom reports every width as 0, so that part
bundles the REAL `PortalDetailHeader` + `PortalAdaptiveActionRow` (`header-fixture.tsx`) and
drives them live: five icons inline on a desktop header, folding into a ⋯ with a glyph per item
only when they genuinely do not fit.

Shots land in `EVIDENCE_DIR` (default `tests/browser/ui-sweep-1016/.shots`, gitignored).
