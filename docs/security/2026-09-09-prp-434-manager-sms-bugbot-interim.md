# PRP-434 manager SMS discovery bugbot review (interim)

Reviewed target: `/private/tmp/axis-prp-434-20260908` against base `6f24d93b7`.

- Captured (UTC): `2026-09-09T01:45:45Z`
- Diff SHA-256: `3d6355e13758aabeb0c4806dcde322c173611823160a92062cf04192524acd55`
- Status: the target is an uncommitted, moving diff. Recheck this report against the final patch.

## Findings

### P2: FakeWriteQuery `.gte()` does not model SQL NULL behavior

The new test adapter predicate returns true when a row does not have the requested column:

```ts
!(col in r) || String(r[col] ?? "") >= String(val ?? "")
```

PostgREST/SQL `gte` does not match a NULL or absent column. This can let unit tests select rows that production would exclude, especially expiry-filtered pending actions, and weakens the new YES lifecycle test. Make the adapter return false for missing/null columns and seed required default fields explicitly. Add a small adapter test for missing, null, equal, lower, and greater values.

Resolution evidence (2026-09-09): resolved in the current uncommitted patch. The predicate is now `r[col] != null && String(r[col]) >= String(val ?? "")`, so missing and null values fail like SQL. Fake inserts now receive a `created_at` default before caller fields, preserving explicit fixture timestamps. Adapter-only diff SHA-256: `ce35c38f6cb7d8f36c916879926130192339b61bca7b2eed2ef65e4aa21d6b0f`. The manager SMS focused lifecycle suite previously passed with the corrected adapter; the final coordinator gate should retain that suite in its rerun.

## Checks with no source defect found in this snapshot

- Conversation order is deterministic: the server loader sorts each thread by `createdAt`, so the last three inbound messages and `lastInboundAt` are stable.
- Query matching examines bounded inbound snippets, property label, room context, identity fields, and normalized phone. It returns every match and the prompt instructs the model to ask which conversation when several match.
- List discovery makes no writes. Reply ownership and phone are revalidated during preview and execution, so read scope does not broaden write scope.
- The new manager-SMS wrapper test only mocks the agent loop and pending-action decision. It should not be described as proof that a real SMS was sent; it does verify proposal storage and YES routing to the decision boundary.

## Coordinator final verification

Final source/test inventory SHA-256: `fa497e55ba45cf10ff3732a71d97d6127d22c14650802140426704d0f5c0e7b1` (paths and bytes, including the new test). The coordinator rechecked the final source and resolved adapter change. No unresolved High/Critical finding. Full unit, TypeScript, lint and build all exited 0. Remaining actual SMS acceptance is explicitly pending in the validation report.
