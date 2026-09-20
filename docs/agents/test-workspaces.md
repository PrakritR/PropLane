# Private test workspaces

Private test workspaces let trusted operators exercise the real manager and resident portals while keeping their data and effects outside the customer domain.

## Durable boundary

- `test_workspaces` is the namespace. `test_workspace_members` assigns one auth UUID to one namespace and is retained after account deletion.
- Classification never depends on the feature switch or membership state. Turning the switch off, suspending a member, or expiring access cannot turn a test identity into a customer identity.
- Root records persist `test_workspace_id`. Database triggers derive it from every populated account, email-backed profile, and named parent reference, and reject normal-to-test or cross-workspace relationships.
- Public listing queries always require `test_workspace_id is null`. An active authenticated member may use the same listing and application UI through private, `no-store` responses scoped to their workspace.

## Access and provisioning

- `PROPLANE_TEST_WORKSPACES_ENABLED=true` enables access. It defaults off.
- `PROPLANE_TEST_WORKSPACE_OPERATOR_IDS` is a comma-separated UUID allowlist. An operator must also hold the admin role, must be a normal account, and cannot be a canonical demo/sandbox identity.
- The admin Test accounts page creates a workspace and invites a fresh auth identity. Existing auth emails cannot be converted. The new user remains banned until profile, role, membership, and audit rows are durable.
- Only the narrow operator invitation path may deliver the auth invite. Business email, SMS, push, webhook, calendar, payment, screening, and number-provisioning effects are captured or refused for classified identities, including suspended identities and delayed workers.

## SMS and schedules

- Active manager, co-manager, and resident members may use the existing SMS test surface. Capability, session history, pending actions, targets, application stage, and confirmations are re-authorized against the workspace on every request.
- A workspace shares data only with its own members. It never reads the public catalog or a normal account's records.
- Workspace turns use the shared atomic rate limiter in addition to the per-account assistant limit.
- Confirmed tours and slot conflicts use a workspace namespace. The normal global schedule remains reserved for customer data.

## Rollout

Schema must be applied before code because portal layouts fail closed when classification storage cannot be read. Keep the feature switch off until each environment has its reviewed migration, private operator allowlist, workspace-level model capacity, and captured-provider verification. Production schema, configuration, or data changes require separate approval.
