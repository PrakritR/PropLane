# Akhil release-routing security review

Date: 2026-09-10. Observed keeper HEAD: `30ca5d43d978f049f51489b666a2a282d699b029`, branch `akhil/backlog-repeat-issues`, worktree `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`.

Disposition: no actionable security finding established. The routing correction is acceptable for keeper handoff. This is not release approval and does not clear the production schema or QA gates.

## Scope and context

This is a bounded security refresh in the existing PRP-473 reviewer context because collaboration slots were occupied. It is not the fresh top-level Astra review; that phase is owned by the separate `akhil_release_review` agent.

Reviewed the complete uncommitted diffs in `AGENTS.md`, `docs/agents/AGENTS-akhil.md`, `docs/agents/deployment-workflow.md`, `docs/agents/sandbox-open-review.md`, `docs/ship-gate.md`, `.cursor/rules/ship-and-review-gate.mdc` and `.cursor/rules/sandbox-open-feature-review.mdc`, plus new `tests/unit/akhil-release-routing-instructions.test.ts`. Read the authorized release plan, execution handoff and schema evidence. Original-checkout mirrors and unrelated untracked planning files are outside this bounded review; mirror preservation is attributed to execution/root, not independently certified here.

The user explicitly authorized agents working for Akhil to ship without captain handoff. The amended documents implement that authorization rather than inventing new authority. No product source change is included in the reviewed dirty scope.

## Security conclusions

- `AGENTS.md:53` and `:54` retain production-data and locked-listing prohibitions. The release exception at `:55` is explicitly limited to agents working for Akhil, his keeper and his explicit ship request. It retains `main` -> `staging` -> `production`; no direct-main production path is introduced.
- `AGENTS.md:68` retains fast-forward-only pushes and stopping on a non-fast-forward. `:73` says only the captain integration rung is bypassed. The reviewed/QA-tested condition at `:124` removes a separate human handoff requirement only after explicit Akhil authorization; it does not waive review, staging, testing or production safety.
- The matching Akhil document preserves no unsolicited Linear/Lavish/workflow and no no-mistakes rules. Without an explicit release request, keeper plus Review URL remains the default. Agents do not write `prakrit` or gain authority over other developers' keepers. Prakrit's captain routing remains separately scoped in the shared documents and active rules.
- `docs/agents/deployment-workflow.md:22` restates the narrow authority and safety limits. `:29` identifies the root-verified existing Vercel project, rejects relinking and requires staging branch-scoped variables rather than generic Preview defaults. `:43` prohibits the currently mis-targeted manual wrappers for this release. These changes reduce accidental production-environment/project selection risk; they do not create new credentials or deployment mechanisms.
- Existing migration-order prose at `docs/agents/deployment-workflow.md:70` is not authority to override root production-data restrictions. The current release/schema artifacts explicitly hold production and require a separately reviewed and authorized database-remediation scope. The doc correction does not authorize applying migrations or repairing production migration history.
- The new test is a textual instruction contract. It provides useful regression checks for explicit authorization, staging references, Prakrit's path, ordinary keeper handoff and project naming. It is not an enforcement mechanism or proof of deployment/schema safety; the actual prose and operational gates were inspected independently.

## Checks and attribution

Independent `git rev-parse HEAD` confirmed the hash above. `git diff --check` passed. The following command completed exit 0, one file / four tests, 262ms:

```bash
env PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:$PATH NODE_OPTIONS=--max-old-space-size=4096 SMS_RUNTIME_ENABLED=0 SMS_OUTBOX_SCHEDULER_READY=0 npx vitest run tests/unit/akhil-release-routing-instructions.test.ts --maxWorkers=1
```

Independently ran `git diff --quiet cdfd2debe67a26d9ae0e01dc743c754d68ece2b6 HEAD -- <all 13 previously reviewed PRP-473 source paths>`: exit 0. The prior source implementation remains unchanged after integration. This narrow identity check does not certify every integrated dependency; the fresh lead review owns the integrated validation assessment.

Execution reports full unit 9,591 tests passing, integration 270 passing / 20 skipped, focused integrated 243 passing, TypeScript/lint/build success, and real dev browser/inbox verification. These were read as attributed evidence and not rerun by this security refresh. Full E2E, staging QA and controlled handset/provider acceptance remain explicitly unrun. Root's read-only catalog report establishes actual production webhook/recovery schema omissions rather than relying on version-ledger differences. This reviewer did not query the database or Vercel to independently reproduce those catalog results.

Production is held for schema reconciliation and remaining release QA, not captain permission. This review authorizes no database remediation or promotion and does not imply that a green routing test clears any operational gate.

Only this report was written. No source/test/mirror edits, branch changes, commits, pushes, database/provider writes, deployment, credential access, tracker operations or no-mistakes invocation occurred.
