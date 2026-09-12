# Akhil authorized release: workflow and integrated validation

## Astra plan and authority

Akhil explicitly requests: "yes put them in prod and then continue going towards the next ones, also get rid of this 'captain' instruction you have, only prakrit uses that not me."

This authorizes Akhil-specific integration and promotion without captain handoff. It does not waive staging QA, production application-data protections, locked listing protections, ordinary review/tests, or fast-forward-only remote writes. Do not run no-mistakes, open a PR, write Linear, change Prakrit's process, or send messages to real contacts.

Execution worktree: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`.
Keeper: `akhil/backlog-repeat-issues`, starting HEAD `cdfd2debe67a26d9ae0e01dc743c754d68ece2b6`.
Observed origin/main and origin/production: `2d1353af42c3a652be6cf8a69640468b453f4cea`. Remote staging is absent. Recheck drift before acting.

## Scope and decisions

1. Integrate current origin/main into the published keeper with an ordinary merge, never rebase or force. Inspect differences and preserve the already-reviewed PRP-473 fixes and newer main work. Sol may create the keeper merge commit, but no protected branch pushes or promotions in execution.
2. Correct the active shared instructions so Akhil's explicitly requested release path is keeper -> main -> staging -> production, without requiring prakrit or captain approval. Default to keeper plus Review URL when Akhil has not requested a release. Prakrit retains keeper -> prakrit -> main -> staging -> production. Never direct main -> production. Preserve staging and data safety. Remove contradictory global agent restrictions by scoping them to Prakrit or the matching developer process.
3. Likely instruction scope: AGENTS.md, docs/agents/AGENTS-akhil.md, docs/agents/deployment-workflow.md, docs/ship-gate.md, docs/agents/sandbox-open-review.md, .cursor/rules/ship-and-review-gate.mdc, .cursor/rules/sandbox-open-feature-review.mdc. Read other active routing rules and make only necessary scoped corrections. Captain-specific rules already skip Akhil; do not broadly delete historical captain text or change AGENTS-prakrit.md. Do not rewrite unrelated docs or introduce a second workflow source of truth.
4. The original checkout `/Users/akhilvemuri/coding/AXIS-2` has user-owned dirty instruction and script edits. Mirror only the narrow requested Akhil routing corrections into its active instruction files with apply_patch, preserving all existing user hunks. Do not stage or commit anything there. Record exact mirrored files. If safe mirroring conflicts with unrelated edits, report rather than overwrite.
5. Preserve local-only docs/agents/akhil-feature-cycle.md and backlog planning artifacts. Do not accidentally include unrelated untracked files. No migrations or application source changes are expected; any necessary integration correction requires relevant area/Next.js guide pre-reads, behavioral regression tests and documentation.

## Delegation

Fresh Sol-medium manages integration and validation. Terra owns scoped instruction implementation after the merge. Luna independently audits active instruction routing and validates no remaining Akhil captain requirement, preserving Prakrit and safety requirements. Avoid concurrent writes. Root independently prepares read-only cloud/deployment readiness. Send root an early update once integration and instruction scope are stable.

## Validation and acceptance

- Existing PRP-473 regression coverage must stay green, particularly final guarded compare-and-swap and mixed legacy/modern reply ambiguity. Read docs/plans/2026-09-10-prp-473-resumed-review.md and associated handoff/evidence.
- Run focused PRP-473 tests plus changed-main communication entitlement/contact dependencies, full unit suite, typecheck, lint, build, integration tests and git diff --check on the integrated source. Exact commands and exit codes, no pipes hiding failures. Use Node 22, 4GB heap, full unit <=2 workers, focused <=1 worker; one compiler/build at a time.
- Read docs/ship-gate.md and exercise required local full E2E for changed portal UI/routes. Do not call a smoke suite full E2E. Retain browser evidence with real dev data for manager reschedule, duplicate/no-op, resident inbox delivery and mobile rendering. Avoid fresh seed overwriting existing fixtures; existing task tour 80eb0801-755d-4cf8-be15-bff69eafb61c is available, owner c02c7ffd-50ec-47d0-acf2-82928be6db27. Never use /demo as proof.
- Root-owned dev server session 74874 on pinned port 3008 may need stopping before build. Coordinate before starting another server. SMS runtime and outbox scheduler disabled locally. Credentials/session state are private under /Users/akhilvemuri/.local/share/proplane-codex/dev-test/; never print or commit credentials.
- Routing acceptance: Akhil explicit ship request may integrate and promote through staging; absent ship request handoff remains keeper; Prakrit captain pipeline unchanged; no production data writes, no staging skip, no force pushes, no unsolicited PR/Linear, no no-mistakes.
- Graphify artifacts are absent in this pooled tree; installed CLI mismatch is known. Attempt required hook rebuild after meaningful source changes, document inability without generating incompatible artifacts. Do not modify tracked local graph metadata.

## Handoff and release phases

Sol writes docs/plans/2026-09-10-akhil-authorized-release-handoff.md with starting/current HEAD, diff scope, integration decisions, original-checkout mirror details, all command exit codes, browser evidence and exact unresolved gates. Do not claim production delivery.

Root launches a fresh Astra reviewer against the plan, handoff and integrated diff before committing/pushing workflow corrections or promoting. Corrections follow the feature cycle, at most two rounds. Then root can fast-forward main to the tested keeper, recreate staging using the existing missing-branch ship:staging path, verify its branch-scoped non-production environment, perform staging QA, run ship:preflight and promote staging -> production. Confirm Vercel proplane deployment serves the expected commit and iOS TestFlight distribution, not merely upload.

Actual live Vercel project is proplane (prj_rupckw3T2v0oXVg2nTLVCYePKDUc), not the separate axis-2 project. Do not create/relink projects. Production data is read-only, so production verification is non-mutating smoke/log inspection. Staging provider/handset validation needs a designated test recipient, never infer one from an incident. Missing external credentials or unsafe targets are concrete blockers; captain permission is not.

After the production checkpoint, continue high-priority repeat issues PRP-475 then PRP-476 with individual fresh feature cycles and actual Langfuse/Twilio correlation. The current fix is not proof those tickets are resolved.
