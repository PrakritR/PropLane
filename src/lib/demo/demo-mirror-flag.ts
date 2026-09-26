/**
 * The one switch that decides whether `/demo` may read the canonical
 * `@test.proplane.local` accounts' real portal rows (`GET /api/demo/portal-snapshot`)
 * or must serve the bundled static snapshot from `demo-guided-data.ts`.
 *
 * **Permanently OFF (captain 2026-09-25).** `/demo` renders from ONE bundled,
 * deterministic dataset in code: a fully synthetic "Seattle Homes" account
 * (manager, residents, a vendor — ids in the `demo-*` namespace), never a
 * live mirror of any real account's rows. This guarantees the exact same
 * data in every environment — dev, staging, production, desktop, phone — on
 * every load, and guarantees `/demo` never reads or writes a real row
 * anywhere. The DB-mirror code below is retired, not paused: do not flip
 * this back on. If a future change wants live data in `/demo` again, that is
 * a new decision, not a revert of this one.
 *
 * See `docs/agents/demo-sandbox.md` for the current single-source-of-truth
 * model.
 */
export const DEMO_PORTAL_MIRROR_ENABLED = false;
