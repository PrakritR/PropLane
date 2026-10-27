# Oct 26 pass 2 — visual and transcript evidence

Three lanes land together: the PropLane line's home lock and stay chat
(`line-206-chat-1026`), bookings across Airbnb / Booking.com / PadSplit /
SpareRoom (`bookings-channels-1026`) and phone sign-in (`phone-signin-1026`).

Two passes, no dev server, account or database:

```bash
EVIDENCE_DIR=/tmp/pass2-1026 npx vitest run \
  tests/unit/evidence-pass2-signin-1026.test.tsx \
  tests/unit/evidence-pass2-chat-1026.test.tsx \
  tests/unit/evidence-pass2-bookings-1026.test.tsx \
  tests/unit/line-206-home-lock.test.ts \
  tests/unit/channel-overlap-route.test.ts
EVIDENCE_DIR=/tmp/pass2-1026 npx playwright test --config tests/browser/pass2-1026.config.ts
```

1. The three `evidence-pass2-*` harnesses render the REAL screens in jsdom — the
   sign-in door, the resident stay chat (cards stamped by `buildInboxEventStamp`
   itself), the tour host-team thread, the bookings timeline, the Connect Airbnb
   pop-up, and the Bookings / Posting integration rows — and dump each as an HTML
   page under `EVIDENCE_DIR`.
2. `line-206-home-lock.test.ts` and `channel-overlap-route.test.ts` write two
   transcripts beside them: the whole 206 conversation (who was texted what, and
   whose Communication each turn landed in), and every save the schedule-records
   route accepted or refused over a channel reservation.
3. `shots.spec.ts` compiles the app's own Tailwind build from
   `src/app/globals.css`, drops it beside the dumps as `app.css`, and screenshots
   every surface at the width a person reads it (the sign-in door on a phone, the
   month timeline wide, and once more scrolled to the end of the month).

Shots land in `EVIDENCE_DIR` (default `tests/browser/pass2-1026/.shots`, gitignored).
Without `EVIDENCE_DIR` every one of these is an ordinary assertion-only test.
