# Fresh Astra review of the approved extra correction round

Date: 2026-09-11

Decision: **approve the bounded CI contract correction for root's remaining release gates.** No blocking finding remains in this round's scope. This review does not approve a migration, deployment, promotion, billing enablement, or another correction round. Production waiver `2026-09-11-production-comms-billing` remains DRAFT.

## Scope and checkout

Read the complete Akhil feature-cycle skill, repository and Akhil instructions, repository feature-cycle document, approved-extra-round plan and final handoff, correction-2 handoff/review, and both root evidence documents. Reviewed only `tests/unit/ci-test-workflow.test.ts` against the previously reviewed `.github/workflows/test.yml`, with validation and flakiness disposition. There is no graph at either documented graph location according to root's recorded check; the explicit plan and repository documents supplied orientation.

Every shell command used explicit workdir `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`. Independently confirmed HEAD `97815a2d459c0bf96e9e80d4f94d29bff7d23fe2` and MERGE_HEAD `8ce3868b4e5775661956c6c3f36fcb146bfa931a`. No Git, code, credential, database, provider, deployment, or waiver mutation occurred. Only this review document was written.

## Contract assessment

- `tests/unit/ci-test-workflow.test.ts:134` now maps each job to its exact intended runner: unit uses `ubuntu-24.04`; integration, lint, and build use `ubuntu-latest`. The existing independent event-trigger assertion is retained. Inspection of active workflow YAML confirms those jobs have no conditional trigger or upstream dependency.
- Line 27 parses YAML through `yaml.parse`; the new regression consumes actual unit steps instead of accepting a matching YAML comment elsewhere. Optional `WorkflowStep.name` at line 14 correctly types the named-step lookup.
- Lines 151-170 require the named provisioning step to exist before the exact `npm run test:unit` step and require both steps to have no `if`. The provisioning script must contain the exact executable lines installing PostgreSQL 16 server/client plus OpenSSL and exporting `/usr/lib/postgresql/16/bin` through `GITHUB_PATH`. The actual workflow executes update, installation, and export in that order in a normal run block, then prints tool versions and runs the unit command. This is an appropriately small structural regression; it is not a general shell interpreter or proof that arbitrary future shell edits execute those lines.
- The aggregate test at lines 115-132 is unchanged. It still requires exactly `[unit, lint, build]`, `always()`, and failure on a non-success dependency, while excluding integration and browser jobs. No skip, retry, timeout increase, or runtime change was added.

Independent SHA-256 readbacks match the final handoff: contract test `dea7438e89010216f802e66b08043220bd83c1ba0871b3e8c9f42fe775d7247b`; unchanged reviewed workflow `987b17e946da7ca0468ba297e6aa6547c2d1332533c1de6c78c2c38f70ef54f3`; fixed billing runner `56e88313a0da9b14ef04e4d146392782a79085e80ff04266149e8a6f9be09cc6`. Independently read the actual waiver status as `DRAFT - NOT APPROVED, NOT APPLY-CAPABLE, NOT CONSUMED`, still naming that runner.

## Validation and remaining uncertainty

Reviewer independently ran:

`NODE_OPTIONS=--max-old-space-size=2048 /Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin/node node_modules/vitest/vitest.mjs run tests/unit/ci-test-workflow.test.ts --maxWorkers=1 --reporter=verbose`

Exit 0: **1 file, 10 tests passed, 264 ms**. HEAD/merge readbacks, hashes, and `git diff --check` also exited 0.

Accepted as explicitly attributed Sol execution evidence from the final handoff, without duplicating heavy checks on the 8 GB host:

- Final four-file matrix: exit 0, 63 tests, 8.13 seconds, Node 22.23.0, 2 GB heap, one worker.
- Final stable full unit suite: `vitest run tests/unit --maxWorkers=1 --reporter=dot`, exit 0, **1,391 files and 9,768 tests passed**, 533.20 seconds.
- Final standalone `npx tsc --noEmit --pretty false`: Node 22.23.0, 4 GB heap, exit 0 with no output.
- Scoped ESLint and diff check: exit 0. Required graph refresh: exit 1 because npm could not determine an executable; no replacement graph engine was installed.

The prior 7-failure full run, its 1-failure isolated rerun, the interrupted first extra-round broad run (130), and the 2 GB TypeScript OOM (134) remain recorded failures/interruptions, not passes. The deterministic runner mismatch is corrected. The six previously intermittent failures passed unchanged in the final run, but their cause has not been demonstrated or fixed. Luna's selected-environment deletion observation is recorded as an isolation hazard, and import/child-process load sensitivity as a hypothesis, without claiming causal proof. This is a truthful disposition for the authorized narrow round. It does not establish general flake elimination.

Prior build/lint and 14-case seeded browser evidence remain attributed prior evidence for unchanged product source. Root owns new browser QA. Hosted Ubuntu 24.04/PostgreSQL 16 execution and full-E2E failure disposition are still outstanding; a green local unit suite does not close them.

## Root-owned release gates

Continue only through the existing reviewed keeper and staging ladder, exact-SHA deployment with staging-scoped credentials, staging apply/readback, feature billing/tour/recovery QA, designated handset receipt/reply/STOP/START acceptance, and invoicer cutover/rollback proof. Ship preflight, fresh bounded production preflight, Akhil's explicit named-waiver and fixed-runner approval, one-shot production apply with independent readback, and final Vercel/TestFlight distribution verification remain required. Never retry an uncertain apply. This approval supplies none of the outstanding production authority and opens no additional correction cycle.
