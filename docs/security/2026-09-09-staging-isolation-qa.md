# Staging database and SMS isolation investigation - 2026-09-09

Base: `26404c432` (`origin/staging`). Keeper: `akhil/staging-isolation-threads-20260909`.

## Findings and containment

- Vercel staging alias resolves to Preview deployment `dpl_FZcdjihoUSTowpofkW2HTuciZfX3`.
- Branch-scoped Supabase URL and the actual browser JavaScript both name `xwszcafaontidfgznlxd`.
- Fourteen SMS inbox notices resolve to three mailbox/phone groups. Two groups are fragmented; the largest has seven rows. SMS UI is unset/off, exposing the independently created notices through the inbox.
- Five staging Google Calendar refresh tokens exactly match the production snapshot. The refresh copies the settings table, while tour confirmation/rescheduling invokes Google Calendar sync. This is a confirmed cross-environment side-effect path. Without the reported tour's id/time or entry point, it is not evidence that that specific tour was written directly into the production Supabase database.
- Staging-only containment disabled `connected` and `syncEnabled` on those five exact snapshot matches and stamped their production provenance. No tokens were printed, no production database writes or external messages were performed. A follow-up read-only audit reports zero connected snapshot matches.
- The latest successful local refresh marker is `2026-09-09T05:56:43.577Z`. Scheduled workflow run `34378773018` failed on an empty `SUPABASE_ACCESS_TOKEN` in the `staging-data-sync` environment. Cron is `23 */12 * * *` UTC.
- Three-way merge is row-level. Production changes win whole rows; JSON array elements do not receive separate conflict resolution. This matters for the singleton planned-events record.

## Implementation

SMS notices use owner plus normalized phone for stable persistence, compare-and-swap appends, optional delivery-id deduplication, and an immutable root timestamp. Legacy phone notices fold only with trusted mailbox ownership. Mailbox changes preserve server-owned history; archive/delete members are derived server-side after authorization.

Google Calendar stored credentials are bound to their database project. Staging rejects unmarked/copied connections before decryption/provider access. Browser database guards reject live bundles on known staging hosts and localhost. Missing production-reference configuration no longer disables server/build guards.

## Validation

- TypeScript `tsc --noEmit --incremental false`: exit 0 using Node 24 and an 8 GB heap. Initial Node 23/default heap attempt exhausted memory (exit 134).
- Targeted ESLint: exit 0.
- Focused SMS/database/calendar regression suites pass; both required review reports have no unresolved findings.
- Real dev/test fixture via `node --env-file=.env.test --conditions=react-server --import tsx scripts/qa-sms-isolation.ts`: exit 0; three messages (including concurrent formatted-phone variants) stored in one row.
- Full standard seed blocked by placeholder Stripe key, exit 1. Used the focused dev/test inbox fixture instead; no production seed or wipe.
- `npx graphify hook-rebuild`: exit 1 because installed npm package exposes no executable. Direct `graphify hook-rebuild` also exits 1 (installed CLI lacks the command). No graph artifacts proposed.
- Browser/full-suite results recorded below after completion.

## Release boundary

Staging calendar containment is applied. Code remains on the keeper for captain integration and staging QA; no agent merge or promotion to protected branches.
