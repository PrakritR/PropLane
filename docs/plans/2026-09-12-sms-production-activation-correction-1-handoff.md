# SMS production activation correction 1 handoff

## Goal and scope

Correction pass for F1 and F2 in
`docs/security/2026-09-12-sms-rollout-bugbot-review.md`, under
`docs/plans/2026-09-12-sms-production-activation.md`. This pass only closes the
remaining missing-schema entitlement-read gap and aligns the existing add-on
Remove control with the already-closed purchase boundary.

## Repository state

- Checkout: `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/5/AXIS-2`
- Branch: `prospect-sms-release`
- Starting/current HEAD: `a4967b835880ad44b13b10c1fcc112de80081fbe`
- No commit, push, database access, network call, deployment, or production
  mutation was performed.
- The previously reviewed atomic-workspace migration is unchanged. SHA-256:
  `0c1924b8a0e2339d6bb6ae370ff2823badb5374bde51f157b788ac09b3cfe36c`.

## Correction decisions and behavior

- `loadManagerPlanAddonQuantities` now returns `ok: false` for every database
  error. A PostgREST schema-cache miss and a PostgreSQL missing-relation error
  can no longer become a known zero-add-on plan.
- A successful empty `manager_plan_addons` query still returns the four zero
  quantities, so an installed empty table remains a known plan state.
- The real `loadWorkspacePlan` path is covered for the empty success control,
  an ordinary timeout, the PostgREST schema-cache message, and the PostgreSQL
  missing-relation message. Each error marks the plan unknown.
- The existing workspace route contract still returns 503 for an unknown plan
  without invoking `create_portal_workspace_with_limit`.
- The Remove button is disabled whenever `row.purchasable` is false, including
  a positive existing quantity. It carries the same honest unavailable title
  as Add. A rendered component test verifies the disabled control does not send
  a mutation request.
- The shared purchase boundary remains closed. No billing, entitlement-write,
  route, SQL, or migration behavior was reopened or changed in this correction.

## Correction files

- `src/lib/plan-addons.server.ts`
- `src/components/portal/manager-plan-addons-panel.tsx`
- `tests/unit/workspace-plan-addons.test.ts`
- `tests/unit/manager-plan-addons-panel.test.tsx` (new)
- `docs/plans/2026-09-12-sms-production-activation-correction-1-handoff.md`

## Validation evidence

- `npx vitest run tests/unit/workspace-plan-addons.test.ts tests/unit/workspaces-create-route-contract.test.ts tests/unit/manager-plan-addons-panel.test.tsx`
  - exit 0; 3 files, 12 tests passed.
- `npx vitest run tests/unit/manager-plan-addons-closure.test.ts tests/unit/workspace-plan-addons.test.ts tests/unit/workspaces-create-route-contract.test.ts tests/unit/atomic-workspace-plan-limit-migration.test.ts tests/unit/manager-plan-addons-panel.test.tsx`
  - exit 0; 5 files, 24 tests passed.
- `npx eslint src/lib/plan-addons.server.ts src/components/portal/manager-plan-addons-panel.tsx tests/unit/workspace-plan-addons.test.ts tests/unit/workspaces-create-route-contract.test.ts tests/unit/manager-plan-addons-panel.test.tsx`
  - exit 0; zero errors and one pre-existing
    `react-hooks/set-state-in-effect` warning at
    `manager-plan-addons-panel.tsx:64`.
- `npx tsc --noEmit --incremental false`
  - produced no output for about 120 seconds and was stopped; exit 130. The
    preceding implementation handoff recorded this command at exit 0 before
    F1/F2, and root owns the fresh build/typecheck for the frozen correction.
- A broad `npm run test:unit -- ...` attempted by the Terra delegate expanded
  to the full unit suite because of the package script. It was stopped after an
  unrelated inbound-email-webhook failure/timeout; exit 130. It is not used as
  correction evidence. Root reported the prior frozen full unit run at exit 0
  before this small correction.
- `npx vitest run tests/unit/inbound-email-webhook.test.ts`
  - exit 0; 1 file, 42 tests passed. The earlier broad-run observation did not
    reproduce in isolation.
- `git diff --check`
  - exit 0.
- `npx graphify hook-rebuild`
  - exit 1: npm could not determine an executable to run.
- `graphify hook-rebuild`
  - exit 1: the installed Graphify executable does not support `hook-rebuild`.
  The checkout has no `.graphify/graph.json`, so no graph artifact was changed.

## UI review and remaining QA

The F2 change preserves semantic buttons, accessible labels, established token
styles, existing 36px desktop geometry, and existing loading/error/empty states.
Only disabled state and explanatory title changed. Root should verify the
positive-quantity row in staging at the existing Billing & plan add-ons surface,
including keyboard focus order and compact/mobile rendering. No local browser
or seeded-data run was performed in this bounded implementation pass.

## Next-session prompt

Fresh Astra should review F1/F2 against
`docs/security/2026-09-12-sms-rollout-bugbot-review.md`, using this handoff and
the dirty diff from HEAD `a4967b835880ad44b13b10c1fcc112de80081fbe`.
Confirm that every add-on database error stays unknown through
`loadWorkspacePlan`, a successful empty result stays known zero, workspace
creation returns 503 without its RPC for unknown capacity, and positive existing
quantities expose no enabled Remove action while `purchasable` is false. Recheck
the migration hash and ensure no correction touched SQL. Root retains ownership
of build/full-unit, migration runner, external operations, staging QA, and the
production release ladder.
