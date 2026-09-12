# PRP-473 resumed ship-readiness audit

Date: 2026-09-10

Keeper: `akhil/backlog-repeat-issues`
Keeper HEAD: `0b6d56794407277761ad5f6c680a522e97db2e6d`

## Findings

- `origin/main` and `origin/production` both resolve to `2d1353af42c3a652be6cf8a69640468b453f4cea`.
- `git ls-remote --heads origin main staging production` returned `main` and `production` only. There is no remote staging branch. A stale local `refs/remotes/origin/staging` points at `372d67c4f`; do not mistake that tracking ref for a deployable staging branch.
- `npm run ship:preflight` exited 1: missing remote staging, dirty keeper, and the current shell lacks production-only secrets (`CRON_SECRET`, `RESEND_*`, `ANTHROPIC_API_KEY`, Supabase service credentials, Stripe). Those shell warnings are not evidence that Vercel Production is unset; production env was not pulled or inspected.
- The preserved PRP473 implementation is still an uncommitted dirty diff (12 `src` files, 8 tests, 2 agent docs, plus unrelated planning/security artifacts). `git diff --check` exited 0.
- `HEAD` is an ancestor of `origin/main` (`git merge-base --is-ancestor HEAD origin/main` exit 0), while `origin/main` is not an ancestor of the keeper (exit 1). Captain integration must account for the newer main commits; no merge/rebase/promotion was performed here.

## Remote dependency drift to revalidate after integration

The remote delta after the keeper base is principally PRP463/listing plus communication eligibility/contact work. It does not directly change the PRP473 tour source paths, and the path intersection between the dirty PRP473 implementation and the remote changed paths is empty. Relevant shared-behavior changes include:

- `src/lib/comms-billing/manager-comms-eligibility.server.ts` is now the shared request/status decision for manager work-number and work-email channels. Re-run its unit coverage and manager SMS/number eligibility coverage after integration; PRP473's SMS provider boundary depends on manager SMS entitlement/number readiness even though it does not import this new helper directly.
- `src/lib/manager-assistant-email/manager-assistant-email.server.ts` adds `resolveActiveManagerWorkEmail`, and resident contact/reachability surfaces now hide email when Resend is not configured. PRP473's signed guest reply address uses the existing inbound-email reply-address path, so confirm the guest email fallback remains truthful and separately verify resident contact surfaces after integration.
- `src/lib/comms-billing/eligibility.server.ts` now accepts a channel-specific refusal argument. Keep tour/SMS refusal behavior on the work-number channel and re-run SMS tests; do not copy the new work-email wording into tour notifications.

## Required handoff gates (not green yet)

1. Root's two reply-bug fixes must be completed and reviewed against the complete dirty PRP473 diff; this audit did not edit source or claim the fixes are correct.
2. Run the focused PRP473 tests, then the full unit suite, typecheck, lint, build, and `git diff --check` on the final integrated tree. Existing prior green results in the handoff files predate resumed fixes and do not clear them.
3. Exercise the full manager pending-tour flow with a task-unique dev fixture and both selected-channel/skip edges. Recheck the resident recipient thread where applicable. `/demo` is not evidence.
4. Real handset/provider acceptance remains outstanding: enqueue versus handset delivery, STOP/START, inbound YES/another-time, duplicate/stale replies, and provider receipts. No real provider send was made in this audit.
5. Fresh security-review and bugbot evidence must cover the final branch diff. Then captain-only ladder: keeper -> `prakrit` -> `main` -> newly created/updated `staging` -> `production`; QA must occur on staging before live. Agents must not merge, push, create the staging branch, or deploy.

## Evidence commands

```text
git rev-parse origin/main origin/production
  2d1353af42c3a652be6cf8a69640468b453f4cea (both)
git ls-remote --heads origin main staging production
  main + production only; staging absent
npm run ship:preflight
  exit 1 (missing remote staging; dirty tree; shell-only secret warnings)
git diff --check
  exit 0
```

No Vercel CLI, env pull, database write/read, provider contact, branch mutation, merge, push, deployment, or no-mistakes invocation was performed.
