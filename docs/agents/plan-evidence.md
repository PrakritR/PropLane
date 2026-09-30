# Plan evidence (lane workflow v2, captain decision Sep 28 2026)

Every lane plan (`~/proplane-mock-kit/studio/plans/<lane>/<id>/plan.html`) adds
whichever of these three apply to the change. None of them replace the plan's
UI mocks or Build contract — they sit alongside as evidence the captain can
check before saying "build". Skip a section that genuinely doesn't apply (a
pure backend job with no screen skips Mobbin; a change that reads and writes
no table skips the schema check) and say why in one line rather than omitting
it silently.

## Mobbin references (any UI change)

Pull 2-4 real screens or flows from apps solving the same problem —
`mcp__mobbin__search_screens` for a single screen shape, `search_flows` for a
multi-step journey. Render them as a small reference strip near the plan's own
mock, captioned with the app name. These are inspiration, not a spec: PropLane's
own design system and `docs/agents/ui-page-structure.md` still win on layout,
chrome, and the no-pills / no-subtext rules.

## PostHog usage evidence (any change to an existing screen or feature)

Before proposing a redesign or removal, check whether anyone uses the thing.
Run `mcp__claude_ai_PostHog__exec` against the relevant insight or event
(reuse an existing name from `src/lib/analytics` where one exists rather than
inventing a query). Put the number and the exact event/insight name in the
plan — e.g. "12 managers opened Financials > Payouts in the last 7 days
(`payouts_tab_viewed`)". Never include a person's identity, email, or other
PII in the plan; aggregate counts only.

## Supabase schema check (any change that reads or writes data)

List every table and column the change touches, split into **Reads** and
**Writes**. Verify each one actually exists against the **dev** project
(`emstjswhotsnyksqhqyf`, never staging or production) with
`mcp__claude_ai_Supabase__list_tables` and read-only
`mcp__claude_ai_Supabase__execute_sql` (`select` only — this check never
writes). For every column, confirm a migration under `supabase/migrations/`
actually creates it; a column the code assumes but no migration created is
flagged in the plan as **unverified** rather than silently listed as if it
exists. A phantom column the code assumes, and schema drift between dev and
production, are the two failure classes this check exists to catch before a
build starts; the environment model itself is
[`database-environments.md`](../database-environments.md). Table format:

| Table | Column | Read/Write | Migration |
| --- | --- | --- | --- |
| `portal_work_order_records` | `resident_email` | Read | `202601...xyz.sql` |
| `portal_service_request_records` | `dispatch_note` | Write | **unverified — no migration found** |

## Where this lives

The plan gate (`gate:prompt`, `no-mistakes`) does not enforce this file —
enforcement is the captain reading the plan before approving it. Keep each
section short; the plan's job is still to show the UI and the build contract
first.
