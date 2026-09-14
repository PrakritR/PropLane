# PRP-472 root validation

## Initial execution source

Keeper `akhil/prp-472-inbox-unread`, integration HEAD `3c997bc4f09ef3b97c80cb559e8909830e164868`, feature changes uncommitted. Initial execution froze 12 source/test/migration files. Root's private per-file SHA-256 manifest is `/private/tmp/axis-inbox-cycle/prp472-source-freeze.json`; aggregate digest `fd2ce4b735773d8c37d5727a987cad9d63d752998ac10b3a91ca7f758424e149`.

Full unit command:

```text
/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node node_modules/vitest/vitest.mjs run tests/unit > /private/tmp/axis-inbox-cycle/prp472-full-unit.log 2>&1
```

Exit **0**: **1,456 files, 10,273 tests passed**, 212.57 seconds. No shell pipe obscured the exit status. The log contains jsdom's unsupported scroll/navigation warnings.

Root loaded the production-build environment read-only using `@next/env`, then asserted the public Supabase hostname was exactly `emstjswhotsnyksqhqyf.supabase.co`. Build script is `next build`. The initial build was deferred when fresh review confirmed behavioral blockers despite the passing suite. A later correction needs its own final-source validation; the initial unit result is not evidence that those missing cases pass.

Independent live dev RPC verification is in [2026-09-13-prp-472-rpc-validation.md](2026-09-13-prp-472-rpc-validation.md). Root also visually inspected the desktop and 390 px screenshots listed in the execution handoff. Both showed all three email/SMS messages; the selected desktop row had no unread badge while other unread badges remained, and the phone layout fit. Those screenshots predate the last initial-execution authority/visibility safeguards; Sol recorded subsequent behavioral checks separately.

At this checkpoint the fresh review is collecting confirmed pending-SMS and optimistic-reconciliation findings for correction. No final acceptance, feature commit/push, Linear completion, staging or production action is claimed.

## Correction cycle 1 source

Correction source froze at the same integration HEAD, with 15 changed/new source, test and migration files. Manifest: `/private/tmp/axis-inbox-cycle/prp472-c1-source-freeze.json`; aggregate digest `74359f8b6b0f799f1976b018fb8b8ed976cad1c6b9dfcd1c4852edad642c6a6b`.

Root verified the running port3009 process belonged to pool6, then stopped it before broad validation to keep memory use bounded on the 8GB host.

```text
/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node node_modules/vitest/vitest.mjs run tests/unit > /private/tmp/axis-inbox-cycle/prp472-c1-full-unit.log 2>&1
```

Exit **0**: **1,458 files, 10,295 tests passed**, 192.33 seconds. The exact source was unchanged during this run; subsequent report edits do not alter source. Root independently viewed `output/playwright/prp472-correction1-alias-held.png` and `prp472-correction1-mobile.png`: distinct alias body plus original email/SMS bodies were visible in the held-request desktop screenshot, and the phone layout fit. Payload and fixture-cleanup assertions remain attributed to Sol's browser handoff.

The second fresh review nevertheless confirmed repeat-open prior-state, persistent localStorage error-loop, and conflicting explicit-binding provenance gaps. It also found the handoff's claim of a fully wired inbox test was broader than the retained tests: pane and controller tests were separate, without a rendered `ManagerUnifiedInbox` integration. This green suite does not close those cases. Build remains deferred until correction cycle 2; no final acceptance or push is claimed.

## Correction cycle 2 final source

Root captured 18 source/test/migration files at integration HEAD `3c997bc4f09ef3b97c80cb559e8909830e164868`. Manifest `/private/tmp/axis-inbox-cycle/prp472-c2-source-freeze.json` records per-file hashes; aggregate `45f0449be351e47abb675cb3e9b38283a015c4f94259290ad0cb00758ba8347c`. Documentation-only evidence updates do not alter this source manifest. Root verified all 18 hashes unchanged after the full unit run.

```text
/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node node_modules/vitest/vitest.mjs run tests/unit > /private/tmp/axis-inbox-cycle/prp472-c2-full-unit.log 2>&1
```

Exit **0**: **1,461 files, 10,320 tests passed**, 269.94 seconds. Existing jsdom scroll/navigation warnings remain in the log. Port 3009 was stopped before this run.

Root independently loaded the production-build environment read-only and asserted the exact dev/test Supabase hostname again. `npm run ship:preflight` exited **0**, PASS 11 with 4 warnings: dirty keeper, production runtime credentials absent from this shell, migration ledger not checked, and Langfuse regression skipped. This is not evidence of staging/production migration parity or release readiness. Log: `/private/tmp/axis-inbox-cycle/prp472-c2-preflight.log`.

Root independently viewed final-source `output/playwright/prp472-correction2-desktop.png` and `prp472-correction2-mobile-390.png`. The selected desktop row has no unread badge; canonical email and native SMS render in both layouts, and the phone layout fits. The repeated probe1 bubble is present twice in the reconstructed synthetic durable fixture (root body plus messages entry), independently confirmed by Sol and attributed in its handoff. Final browser request/visibility/storage assertions are recorded in the correction-2 handoff. Earlier unexplained synthetic fixture absence was independently confirmed at the database boundary, then ceased during instrumented QA; no deletion is attributed without evidence.

Full repository lint command `PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:$PATH NODE_OPTIONS=--max-old-space-size=6144 npm run lint` exited **0**, with **0 errors and 746 warnings**. Log: `/private/tmp/axis-inbox-cycle/prp472-c2-full-lint.log`.

Production-mode build command `PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:$PATH NODE_OPTIONS=--max-old-space-size=6144 npm run build` exited **0**, including compilation, TypeScript and route generation. It loaded `.env.local` and `.env`, with the independently asserted dev/test target; no production env file or release action was used. Log: `/private/tmp/axis-inbox-cycle/prp472-c2-build.log`. The existing middleware convention deprecation remains.

All 18 frozen source hashes remain unchanged after unit, lint and build. Final fresh Astra/security/Bugbot review is pending at this checkpoint.

## Final review findings independently reproduced

The final fresh reviewer and Bugbot found two remaining Medium defects. Root reran the retained exact-source controller/reconciliation and panel callback probe:

```text
/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node /private/tmp/axis-inbox-cycle/prp472-c2-final-review-probes.cjs
```

Exit **0** asserts both failures, not a product pass:

1. An old request for sources A1/B1 remains pending while a current snapshot retains A1 and revises B2. A newer A1/B2 request succeeds, setting both confirmed unread values false. The older network failure then restores A's aggregate and source unread to true while B remains false. The operation no longer owns the overlay, but its fallback still overwrites confirmed truth. Pending operation count ends at zero.
2. In a retained `ManagerSmsPanel` instance, native persistence fails once and stores the ID only in memory. Storage recovers, but explicit reopening hits the all-IDs-present early return before durable retry. Output remains one write, one toast, durable `[]`, memory `[sms1]`. This finding does not claim a full unmount/remount cannot recover.

The passing full suite lacks these exact combined cases. No third automated correction is launched under the feature-cycle limit. PRP-472 stays In Progress, with the feature diff uncommitted and unpushed pending resolution.

Root restored the exact DEV/SMS-disabled runtime on port3009 and reran `npm run sandbox:open` successfully after warming the homepage. An independent authenticated Chromium snapshot loaded the exact canonical thread and showed canonical email plus native SMS. Initial homepage liveness and first browser snapshot timed out during cold compilation; warm checks passed. Review URL: `http://localhost:3009/portal/communication/active/c02c7ffd-50ec-47d0-acf2-82928be6db27%3Aresident%3Af4290f7c-31c7-469e-b0bb-859f5ce37f46`. This is a reviewable local implementation, not final acceptance.
