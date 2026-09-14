# PRP-472 authorized follow-up and release plan

## Authority and starting point

Akhil resumed after the two-cycle report: "can you do one more test and then push towards getting this onto prod". This explicitly authorizes another bounded correction and the reviewed keeper -> main -> staging QA -> production ladder. The new user instruction supersedes the prior automatic correction stop. Never skip staging, invoke no-mistakes, send provider messages, or touch locked live listings. Root owns Git publication, Linear and release/database operations.

Keeper `akhil/prp-472-inbox-unread`, pooled worktree `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/6/AXIS-2`, HEAD `3c997bc4f09ef3b97c80cb559e8909830e164868`. The feature diff is uncommitted. Frozen 18-file source digest from the previous review is `45f0449be351e47abb675cb3e9b38283a015c4f94259290ad0cb00758ba8347c`. Read the final review, correction-2 handoff, original plan/safety/upstream addenda, root/RPC validation and current repository/Akhil instructions. Canonical feature-cycle document is in the original checkout if absent here.

Root reran the actual frozen-source private reproduction `/private/tmp/axis-inbox-cycle/prp472-c2-final-review-probes.cjs`; exit0 confirms both defects remain. This is a reproduction pass, not product acceptance.

Remote main/staging/production currently align at `75d711053085e340072c605bcb96eaa9416ef87e`. Root will inspect the upstream delta while implementation runs. Do not merge or change branch without root coordinating a clean local checkpoint. Final release validation and fresh review must cover the integrated candidate, not only the old keeper.

## Execution ownership

Fresh Sol-medium manager delegates substantial source work to Terra and retained tests to Luna with disjoint ownership. Sol owns integration and real browser QA. Root owns broad serial validation and release. Source changes should stay in `portal-inbox-read-operation.client.ts`, `portal-inbox-storage.ts`, `pro-sms-panel.tsx` and minimal necessary shared helper/caller integration. No SQL/hash/grant change is needed. No database mutation by delegates; the existing exact synthetic DEV fixture may be read and opened normally. Coordinate any bounded fixture resets with root, preserving unrelated data.

## F1: unknown outcomes cannot overwrite confirmed source truth

Separate confirmed server outcomes from withdrawing an unknown operation's speculative overlay. A rejected/malformed/missing outcome must only remove that operation's compatible owned overlay and preserve current confirmed truth. Do not settle a captured fallback through the same path as a confirmed server result. Preserve actual per-source partial successes, exact observation matching, completeness, stale-viewer protections, bodies/attachments/folders/drafts, and token-owned pending cleanup.

Retain tests using the real controller AND real reconciliation together. Different email aliases share explicit native binding: old A1/B1 pending; refreshed snapshot keeps A1 and revises B2; newer A1/B2 succeeds; older network reject must leave both source and aggregate unread false. Test reverse settlement order, malformed/missing response, earlier partial success and exact changed-source protection. The existing mock `applyUnread` test does not prove this contract. Keep the common success -> failed reopen path passing.

## F2: explicit mounted-panel opens retry durable storage

The panel must distinguish volatile membership from durable receipt success. Its all-IDs-in-memory fast return currently bypasses the helper's durable membership decision after a failed write. Let bounded explicit opens reach the durable check, or track successful persistence faithfully. Do not introduce render-driven storage loops, repeated toasts, duplicate POSTs or loss of unrelated receipt IDs. Preserve viewer keys and hidden-pane authority.

Retain an actual `ManagerSmsPanel` React test for write failure -> storage recovery -> mounted A/B/A or list/back/reopen -> durable receipt contains the ID and survives reload. Use the real opened-state helper. Assert bounded attempts/toasts while failure persists, explicit retry success, preservation of unrelated opened IDs, and no receipt while hidden. Full unmount/remount recovery alone is insufficient.

## Verification and handoff

Run focused new regressions, existing read/controller/storage/route/combined-pane tests and PRP470 compatibility. Use Node22. No broad concurrent runners on this 8GB host. Sol should drive the affected real DEV browser flows on pinned port3009 with SMS UI enabled and actual transport/scheduler/provisioning flags0; root currently owns the server and browser `inbox-cycle`, so coordinate access. Reuse valid prior QA for unchanged paths and distinguish private probes from React/browser evidence. Never send a provider message for QA.

After source focus passes, coordinate local checkpoint and pinned upstream integration with root, then exercise the integrated candidate. Read relevant local Next guides and area contracts for any merge repair. Refresh graph with the required hook once, recording the known CLI failure honestly if still unavailable; no global repair. Deliver `2026-09-13-prp-472-release-followup-handoff.md` with actual commands/results, source/integration decisions, test names, browser evidence, remaining risks and source freeze. Root then runs required full unit/lint/build and local portal E2E before promotion, and launches fresh Astra/security/Bugbot review.

## Release gates owned by root

Only after the candidate is reviewed and validated: commit/push keeper fast-forward, update Linear appropriately, fast-forward main, then staging. Verify exact deployed staging SHA and environment, apply only reviewed missing schema using a backup and fail-closed narrow path, and run real staging feature QA. The read RPC is already applied to DEV only. Resolve exact staging and production migration history by name, never blindly replay history or apply unrelated pending files. Production schema apply requires preserved backup, reviewed exact target/path and post-apply verification. User's ship request authorizes the feature's bounded release, not unrelated production changes. Verify Vercel production and iOS TestFlight distribution after production push; do not claim live success from upload alone.

## Release review addendum: failed results are not confirmed truth

Fresh security review of the ongoing user-authorized follow-up identified a related F1 case: the route's `status: failed` unread value comes from `initialRecord`, read before a failed RPC, so it can be older than another operation's successful read. The controller currently promotes every syntactically valid failed result to confirmed truth. Correct this before landing: treat failed per-source results as unknown, withdraw only that operation's compatible overlay and notify once, preserving confirmed truth from GET or another successful operation. Preserve valid successful partial results. Add real controller plus reconciler regression for older A1/B1 failed=true arriving after newer A1/B2 success=false, plus reverse settlement and actual failed-envelope partial behavior. Do not alter the server API, grants, SQL CAS, observation identity or group-completeness rules. Existing Sol follow-up manager integrates this bounded correction with a Terra delegate; root reruns broad checks on the resulting frozen source. Fresh security reviewer rechecks it and fresh final Astra/Bugbot review remains required.
