# Communication billing release approved extra-round handoff

Date: 2026-09-11

Status: **BOUNDED TEST CONTRACT CORRECTION COMPLETE; FRESH ASTRA REVIEW AND RELEASE GATES REMAIN**

Plan: `docs/plans/2026-09-11-comms-billing-release-approved-extra-round.md`.
This was Akhil's one user-approved additional correction round after the two
automatic correction cycles. It grants no additional correction round and no
Git, database, provider, deployment, waiver, or production authority.

## Checkout and scope

- Workdir for every command:
  `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`.
- Keeper: `akhil/backlog-repeat-issues`.
- Starting and current HEAD:
  `97815a2d459c0bf96e9e80d4f94d29bff7d23fe2`.
- The existing no-commit merge of
  `8ce3868b4e5775661956c6c3f36fcb146bfa931a` remains pending and was preserved.
- Only `tests/unit/ci-test-workflow.test.ts` changed in this round. The workflow,
  runtime/UI source, SQL, migration/apply runners, consumed recovery artifacts,
  and production waiver were not edited.
- No credentials, remote database or provider calls, account changes, Git
  mutations, deployments, production approval, no-mistakes, Linear, or Lavish
  actions occurred.

## Delegation and integration

The collaboration delegate cap rejected the initial Terra spawn. Root explicitly
authorized the previously working exact-model CLI fallback. Fresh ephemeral
Codex contexts were then invoked with explicit `--cd` and command workdir:

- GPT-5.6 Terra, medium reasoning, owned only
  `tests/unit/ci-test-workflow.test.ts`. It implemented the narrow contract fix
  and ran the focused test. Terra edited no other file.
- GPT-5.6 Luna, medium reasoning, read-only sandbox, independently reviewed the
  CI contract and inventoried the previously flaky test files. It edited no file
  and ran no competing suite.

Sol independently inspected Terra's diff. Root then identified two integration
details that Vitest transpilation alone would not prove: the parsed `WorkflowStep`
type needed optional `name`, and the provisioning step itself needed to be
asserted unconditional. Sol stopped the first broad run before editing, added
those two assertions in the same owned file, reran the narrow gates, and started
a new stable-source full run.

## Change and decision

`tests/unit/ci-test-workflow.test.ts` now:

- preserves independent-trigger checks while asserting exact runners per job:
  `unit` is `ubuntu-24.04`; `integration`, `lint`, and `build` are
  `ubuntu-latest`;
- parses active YAML and requires the named unit provisioning step before the
  exact unconditional `npm run test:unit` step;
- requires the provisioning step itself to be unconditional;
- requires the exact PostgreSQL 16 server/client and OpenSSL install command and
  the exact PostgreSQL 16 binary-directory export to `GITHUB_PATH`.

The aggregate dependency test remains unchanged and continues to require exactly
`unit`, `lint`, and `build`.

Luna found no proven timer leak, mock leak, or application defect behind the six
non-CI failures from the previous full run. It recorded these bounded findings:

- `tests/unit/inbound-email-webhook.test.ts` deletes selected environment values
  in hooks rather than restoring possible prior values. This is a real isolation
  hazard, but it did not establish the prior timeout or mock-count failure cause.
- Dynamic route/module imports in the inbound-email and manager-phone suites and
  synchronous child processes in the sandbox-port suite are plausible load
  sensitivity mechanisms only.

No speculative change was made to those tests. All six cases passed twice in
this round, including in the final full suite. The failed prior full-run evidence
is retained; the green run is not represented as proof that an intermittent
root cause was fixed.

## Validation evidence

All Vitest invocations used Node `v22.23.0`, a 2 GB heap, and
`--maxWorkers=1`.

1. Terra focused test before Sol integration details:
   - `vitest run tests/unit/ci-test-workflow.test.ts --maxWorkers=1 --reporter=verbose`
   - Exit 0: 1 file, 10 tests passed, 272 ms.
2. First affected four-file matrix:
   - `vitest run tests/unit/ci-test-workflow.test.ts tests/unit/claw-manager-phone-scoping.test.ts tests/unit/inbound-email-webhook.test.ts tests/unit/sandbox-port-range.test.ts --maxWorkers=1 --reporter=verbose`
   - Exit 0: 4 files, 63 tests passed, 9.17 seconds.
3. After the parsed-step type and unconditional-provisioning assertions:
   - Same four files with `--reporter=dot`.
   - Exit 0: 4 files, 63 tests passed, 8.13 seconds.
4. Scoped ESLint over `tests/unit/ci-test-workflow.test.ts`:
   - Exit 0, no output, both before and after final integration.
5. `git diff --check`:
   - Exit 0, no output, both before and after final integration.
6. Required graph refresh:
   - `npx graphify hook-rebuild`
   - Exit 1: `npm error could not determine executable to run`.
   - No different graph engine was installed and no unrelated rebuild was run.
7. First broad unit attempt after Terra's initial edit:
   - `vitest run tests/unit --maxWorkers=1 --reporter=dot`
   - Exit 130 because Sol deliberately interrupted it before changing the test
     type and assertion. This is not a pass and was not reused as evidence.
8. Initial standalone TypeScript attempt with a 2 GB heap:
   - `npx tsc --noEmit --pretty false`
   - Exit 134 after approximately 56 seconds due to V8 heap exhaustion. It
     emitted no TypeScript diagnostic and is not a pass.
9. Final stable-source full unit suite:
   - `vitest run tests/unit --maxWorkers=1 --reporter=dot`
   - Exit 0: **1,391 files passed; 9,768 tests passed; duration 533.20 seconds**.
10. Final standalone TypeScript check, serialized after unit, Node 22.23.0 with
    a 4 GB heap:
    - `npx tsc --noEmit --pretty false`
    - Exit 0, no output.

Current protected identities after the round:

- Changed contract test:
  `dea7438e89010216f802e66b08043220bd83c1ba0871b3e8c9f42fe775d7247b`.
- Unchanged reviewed workflow:
  `987b17e946da7ca0468ba297e6aa6547c2d1332533c1de6c78c2c38f70ef54f3`.
- Unchanged fixed billing runner:
  `56e88313a0da9b14ef04e4d146392782a79085e80ff04266149e8a6f9be09cc6`.
- Unchanged actual waiver:
  `9b8f208c2e994c5a484c12f87879b6426348cdb9f34e64d0139279f3c4a78e10`,
  still exactly `DRAFT - NOT APPROVED, NOT APPLY-CAPABLE, NOT CONSUMED` and
  still naming the fixed runner above.

Prior successful production-mode build, standalone typecheck, full lint, and
14-case seeded browser proof remain attributable prior evidence because this
round changed only a unit contract test. The fresh standalone typecheck above
specifically validates the final test-source edit.

## Remaining gates and fresh review request

Fresh Astra review of this bounded extra-round diff and evidence is mandatory.
Hosted Ubuntu 24.04/PostgreSQL 16 execution remains unobserved. The existing
full-E2E failures still require explicit disposition. Keeper landing, exact-SHA
staging deployment with staging-scoped credentials, reviewed one-shot staging
apply/readback, full billing/tour/recovery QA, designated test-handset
receipt/STOP/START/reply acceptance, and invoicer cutover/rollback proof remain.
Then remain ship preflight, fresh production preflight, Akhil's explicit approval
of named waiver `2026-09-11-production-comms-billing` for the unchanged fixed
runner, one-shot production apply with independent readback, staging-to-production
promotion, and final Vercel/TestFlight verification. An uncertain apply is never
retried.

Exact next-session prompt:

> Fresh GPT-6 Astra review for Akhil's user-approved communication-billing extra
> correction round. Work only in
> `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`, with that explicit
> workdir for every command. Read the full Akhil feature-cycle skill, `AGENTS.md`,
> `docs/agents/AGENTS-akhil.md`, `docs/agents/akhil-feature-cycle.md`,
> `docs/plans/2026-09-11-comms-billing-release-approved-extra-round.md`, prior
> correction-2 handoff/review and root evidence, and this handoff. HEAD remains
> `97815a2d459c0bf96e9e80d4f94d29bff7d23fe2` with the existing no-commit merge.
> Review only `tests/unit/ci-test-workflow.test.ts` against the unchanged
> `.github/workflows/test.yml`, plus the truthful validation and Luna inventory
> disposition. Verify exact per-job runners, independent triggers, parsed active
> YAML, ordered unconditional PostgreSQL 16/OpenSSL provisioning and PATH export,
> unconditional unit command, unchanged aggregate dependencies, and final full
> unit/typecheck evidence. No edits unless writing the review artifact; no new
> correction plan or execution round, Git mutation, credentials, remote DB or
> provider action, deployment, waiver approval, no-mistakes, Linear, or Lavish.
> If a finding remains, report it to Akhil/root without opening another round.
> The production waiver must remain DRAFT.
