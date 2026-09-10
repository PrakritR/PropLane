# Leasing listing facts validation: PRP-435, 436, 439, 441, 443

Base: `6f24d93b712f140d16af5f10e14b1fd88edd61aa`. Keeper:
`akhil/prp-435-leasing-answers`.

The shared leasing SMS/email details tool now returns explicit terms, room
base prices, conditional surcharges, utilities, standard deposits and nullable
pet policy. Missing facts remain unknown; mixed-question replies answer known
parts before addressing missing information. Security and bug reviews are
retained in the adjacent PRP-435 reports. The incorrect blanket custom-calendar
surcharge found during review was corrected and re-reviewed.

## Automated checks

- Full unit suite, one worker: exit 0, 1,318 files and 9,066 tests passed.
- Final focused leasing facts tests after surcharge correction: exit 0, 26 passed.
- Final TypeScript (`tsc --noEmit`, 4GB heap): exit 0.
- Full `npm run lint`: exit 0.
- `PROPLANE_LOW_MEMORY_BUILD=1 NODE_OPTIONS=--max-old-space-size=4096 npm run build`: exit 0.
- `git diff --check`: exit 0.

The full unit run began before the last surcharge refinement. Focused tests and
TypeScript were rerun on the final source, followed by the successful build.

## Dev/test and browser checks

The canonical seed completed successfully against dev/test
`emstjswhotsnyksqhqyf`. The first seed attempt failed because `.env.test` contains
a placeholder Stripe test key. The successful rerun used the existing valid
`sk_test_` key from `.env`, retaining the verified dev/test database target.

Signed in as the seeded manager, opened Properties and the Cascade Lofts preview
at `/portal/properties/listed/mgr-demo-cascade/preview`. Checked desktop and
390px mobile viewports. The rendered listing shows the matching lease term,
room base prices, $150 utility estimate and $1,200 standard deposit. Empty
listing photos render the existing placeholder. No browser console errors
were observed in this flow.

A local read-only harness ran the real listing tools and real model against
that seeded listing. Its mixed question asked about terms, room prices,
utilities, deposit, pets and transit. The model used `get_listing_details`,
answered all five known subjects correctly, and identified transit details as
unavailable. The harness exposed only read tools and invoked no SMS/email
transport, session persistence or escalation. This is model/data-path evidence,
not handset-delivery evidence. Artifacts are in this worktree's ignored output
directory.

## Remaining acceptance and integration

Real prospect SMS and leasing email delivery still need controlled recipients.
No ticket is marked complete or ready for staging on the strength of this
local harness. The SMS/email shared registry and prompt were reviewed; no
separate email implementation was added. Cache scope, public projection and
native presentation remain covered by the review and existing checks.

The installed npm graph hook is unavailable. The installed Python graphify
fallback refreshed the local code graph successfully (26,418 nodes, 87,342
edges). It reports 11 partial syntax extractions in other files and does not
provide the requested TypeScript runtime or semantic document refresh. No
graph or host-local metadata is included in this keeper commit.
