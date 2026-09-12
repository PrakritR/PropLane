# Temporary direct-production release execution handoff

## Scope and state

Goal: implement the bounded Akhil-authorized direct-production option, preserve the normal staging path, integrate current main and the exact hosted-CI repair, and prepare a fresh reviewable release candidate.

Plan: `docs/plans/billing-migrations-temporary-direct-production.md`.

Checkout: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/4/AXIS-2`, branch `prospect-conversation-production`.

Starting HEAD: `c391932da41bf19ec2266b4b30e90c5bfb0c7071`.

Current HEAD: `7458cf092d950a6b4dc1050d6a3e169286457ef4`. Temporary preservation commit `136569a12` and merge commit `7458cf092` integrated `origin/main` `490964121`. No push, application promotion, deployment, provider call, or production database operation was performed by this execution session.

Root separately completed the explicitly authorized six-source production billing migration, fresh verification, and waiver consumption. See `docs/plans/billing-migrations-temporary-direct-production-root-evidence.md` and `docs/waivers/2026-09-11-production-comms-billing.md`. Do not rerun the consumed operation. Historical migration-name differences remain outside the authorized SQL scope.

## Decisions and implementation

- `npm run ship:production` keeps `origin/staging` as its default source and does not read the exception policy.
- `npm run ship:production -- --skip-staging` selects only `origin/main`.
- The script and `docs/agents/temporary-direct-production-policy.json` both pin Akhil, `origin/main`, `origin/production`, and expiry `2026-09-15T04:00:00Z`. Unexpected keys or values fail closed.
- The policy is checked before fetch and again after preflight, immediately before checkout and push. Expiry is exclusive.
- Existing fast-forward, preflight, production-branch, Vercel and TestFlight behavior remains.
- The four policy documents and the preflight checklist point to the one machine-readable policy.
- The exact four-file hosted-CI repair was transplanted from pool 3 after source fingerprint checks. It gives the unit job full Git history and probes OpenSSL with `version`; all other checkout jobs retain shallow defaults.

Policy/release files:
`AGENTS.md`,
`docs/agents/AGENTS-akhil.md`,
`docs/agents/deployment-workflow.md`,
`docs/ship-gate.md`,
`docs/agents/temporary-direct-production-policy.json`,
`scripts/promote-staging-to-production.sh`,
`scripts/ship-preflight.sh`,
`tests/unit/akhil-release-routing-instructions.test.ts`,
`tests/unit/promote-scripts.test.ts`.

Exact hosted-CI repair files and final source hashes:
`.github/workflows/test.yml` `61ad9525442db16aa73ed42b2d728cf00791ec116ef3dea3480884b4503c46cc`;
`scripts/testing/comms-billing-migration-apply-local-harness.mjs` `d0fa18cc7b8128c7dfa7be893ab83e2f112aec259785e9c41a62855e6ffea6ee`;
`tests/unit/ci-test-workflow.test.ts` `f5c64726b28ac506ddee696d51bf4b254c3519fc5ce9b9363a85189f723df00f`;
`tests/unit/comms-billing-migration-apply-local-harness.test.ts` `caad4256f0f924bc8da803692eadfd11000c1a63fd6d4f57d2b9bf4e90717746`.

Root owns the concurrent consumed-waiver and root-evidence changes. Preserve them exactly.

## Validation

- `npx vitest run tests/unit/promote-scripts.test.ts tests/unit/akhil-release-routing-instructions.test.ts`: exit 0, 2 files, 16 tests.
- `npx vitest run tests/unit/ci-test-workflow.test.ts tests/unit/comms-billing-migration-apply-local-harness.test.ts tests/unit/comms-billing-migration-apply-subprocess.test.ts tests/unit/comms-billing-migration-apply.test.ts tests/unit/comms-billing-migration-preparation.test.ts`: exit 0, 5 files, 45 tests.
- Scoped ESLint for the changed JS/TS tests and harness: exit 0.
- `bash -n scripts/promote-staging-to-production.sh scripts/ship-preflight.sh`: exit 0.
- Policy `jq` exact-contract assertion: exit 0.
- `git diff --check`: exit 0.
- Six migration SHA-256 values, preparer `cff0016...`, runner `56e883...`, and bundle `c801315...` matched the consumed waiver.
- `node scripts/prepare-20260911-comms-billing-migrations.mjs`: exit 0, preparation only, six exact sources, 67,040-byte bundle.
- Root's network-capable `npm run ship:preflight`: exit 0, 11 checks and 4 warnings, recorded in root evidence. This execution's sandboxed repeat exited 1 because `git ls-remote` could not resolve GitHub; it did not indicate missing local refs.
- `npx graphify hook-rebuild`: one bounded attempt, exit 1 because npm could not resolve registry.npmjs.org. No retry or graph artifact change.

No browser exercise was required for these operations scripts, docs and CI-only changes. The already reviewed prospect/tour integration was preserved; root recorded focused nine-test integration evidence.

## Review and remaining gates

The initial Luna documentation action was rejected by automatic approval review because it weakened the staging gate. It made no changes. The exact retry cited Akhil's verbatim current authorization, fixed expiry, and preservation of all other gates; automatic review accepted it. No alternate tool was used to bypass the rejection.

Fresh Astra review found the real-clock happy-path and expiry-during-preflight risks. Both were corrected and the final 16-test matrix passed. Root's separate fresh Astra review covers the four-file hosted-CI delta.

The code release remains unpushed. Root should preserve this working tree, finish the fresh Astra review record, commit the scoped diff, push the keeper fast-forward only, land it under the authorized route, and observe hosted unit/build/lint/integration/e2e results before any production application promotion. Do not treat the successful database apply as a code deployment or as proof of all-history migration-name parity.
