/**
 * The one switch that decides whether `/demo` may read the canonical
 * `@test.proplane.local` accounts' real portal rows (`GET /api/demo/portal-snapshot`)
 * or must serve the static snapshot from `demo-guided-data.ts`.
 *
 * **Back ON (captain 2026-09-25).** The home page's Codex-style hero embeds
 * `/demo` showing the real, signed-in-shaped manager portal, and the captain
 * asked for it populated with a real "Seattle Homes" portfolio rather than an
 * empty sandbox — that portfolio has to live on the canonical manager account
 * for the mirror to carry it (this file's whole point). `buildDemoIdleSnapshot()`
 * (`demo-guided-data.ts`) now returns that same portfolio as the static
 * fallback too, so the two sources read identically whether or not the DB seed
 * has run in a given environment.
 *
 * **Dev/test only, so far.** `scripts/seed-demo-manager-portfolio.ts` — the
 * committed, idempotent script that writes this portfolio onto
 * `manager@test.proplane.local` — has only been run against the dedicated
 * test Supabase project (ref `emstjswhotsnyksqhqyf`, the only one that script
 * will write to). **Production's canonical account has not been re-seeded.**
 * The mirror is a single global switch, not per-environment, so once this
 * ships to production the mirror will surface whatever is *actually* sitting
 * on production's `manager@test.proplane.local` right now — which, per the
 * history below, may still be the old deleted fictional fixture (Ava Nguyen,
 * The Pioneer, Cascade Lofts, …) rather than Seattle Homes, until the captain
 * runs the same seed script against production by their own say-so. Do not
 * run that script against production without the captain's explicit go-ahead
 * (the script's own guard also refuses any project ref other than the test
 * one on its own).
 *
 * See `docs/agents/demo-sandbox.md` for the two-source model.
 */
export const DEMO_PORTAL_MIRROR_ENABLED = true;
