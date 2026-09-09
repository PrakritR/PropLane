# PRP-434 manager SMS discovery security review (interim)

Reviewed target: `/private/tmp/axis-prp-434-20260908` against base `6f24d93b7`.

- Captured (UTC): `2026-09-09T01:45:45Z`
- Diff SHA-256: `3d6355e13758aabeb0c4806dcde322c173611823160a92062cf04192524acd55`
- Status: the target is an uncommitted, moving diff. Recheck this report against the final patch.

## Result

No material security regression was found in the captured source change.

- Discovery calls use the server-resolved read scope. For an SMS turn, `smsInboxOwnerIds` intersects Communication grants with the work-number data owners; the fetched rows are filtered again to those ids.
- Reply preview and execution independently reload the conversation with edit scope. The lower-level send path also re-resolves co-manager edit access, pins the server-resolved conversation phone, and retains the existing consent and opt-out gates.
- Recent inbound bodies are bounded to three 240-character snippets, wrapped as `untrustedContent` with explicit external-SMS delimiters. The updated manager-SMS prompt explicitly treats tool-returned texts as untrusted and requires clarification for ambiguous matches.
- The list tool remains read-only. A reply remains a `defineWriteTool` preview and needs the existing pending-action YES confirmation before its handler can call the outbox path.
- The changed modules are server-side tool/prompt code; no new client import of a `.server` module was found.

## Residual verification limit

`manager-sms-prospect-turn.test.ts` mocks both the agent loop and `decidePendingAction`. It proves the wrapper stores a proposed action and routes a later YES to the decision function. It is not evidence that the real tool handler, consent/opt-out check, audit, outbox enqueue, or provider dispatch ran. The existing tool tests cover those components separately, but an integration-style confirmation test would provide stronger end-to-end assurance.

## Coordinator final verification

Final source/test inventory SHA-256: `fa497e55ba45cf10ff3732a71d97d6127d22c14650802140426704d0f5c0e7b1` (paths and bytes, including the new test). The coordinator rechecked the final source and resolved adapter change. No unresolved High/Critical finding. Full unit, TypeScript, lint and build all exited 0. Remaining actual SMS acceptance is explicitly pending in the validation report.
