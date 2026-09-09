# PRP-446 final security review

- Review date: 2026-09-08
- Worktree: `/private/tmp/axis-prp-446-20260908`
- Base: `6f24d93b712f140d16af5f10e14b1fd88edd61aa`
- Reviewed source diff SHA-256: `d5389429c927c418bd2f7a10e41f4e85e79d8a42d74b2c06b79b0a4aa3d39497`
- Review mode: source, migration, and test inspection only; no provider send, database write, or schema application
- Verdict: **Pass. Prior P1 findings are resolved.**

## Resolution evidence

- Repair inventory and claim errors now return explicit `inventory_unavailable` and `claim_unavailable` results. The cron health gate maps both to stable alerts and HTTP 503. A claimed projection failure also returns HTTP 503 through `conversation_log_repair_failed`.
- Initial projection and retry finalization use compare-and-set predicates over provider SID, projection status, and the exact due timestamp owned by that attempt. An expired worker cannot downgrade a newer persisted result. The adversarial stale-finalizer test preserves the newer marker.
- Conversation-key validation distinguishes absent, valid, and explicitly invalid keys. An invalid explicit key is compare-and-set into terminal `blocked` with `invalid_conversation_key`, receives no next retry time, and never calls the message logger. Legacy absent keys retain the documented trusted-identity fallback.
- The provider sender is snapshotted before submission. Repair requires that immutable sender and the provider SID, excludes unknown outcomes, never invokes transport, and leaves delivery status unchanged.
- Stored application identity, role, owner, approved state, recipient, current work number, and existing-thread message evidence are server-derived. SMS-only approval copy does not claim an email was selected. A notification failure after approval is reported without undoing or disguising the committed approval.

## Migration compatibility

The additive migration extends the existing service-role-only `sms_outbox` table and partial repair index. It adds no client grants, RLS policies, resend procedure, or production action. `blocked` is included in the new projection-status check and excluded from the retry index.

This migration must precede deployment of the source because the dispatcher reads and writes its five new columns. Apply it through the normal dev migration ladder only after `supabase migration list --linked` confirms the worktree is linked to dev project `emstjswhotsnyksqhqyf` and the pending list contains no unrelated worktree migrations.
