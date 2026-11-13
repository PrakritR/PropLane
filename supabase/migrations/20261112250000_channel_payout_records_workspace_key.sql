-- Channel finance identity is per WORKSPACE, never per owner.
--
-- `channel_payout_records_key unique (manager_user_id, platform, confirmation_code, kind)` was owner-level, but every read
-- of the table is workspace-scoped (`FinanceScope` / `inScope`, src/lib/channel-finance/store.server.ts). One channel
-- account covering two of an owner's workspaces therefore had its row RE-POINTED by the next import: upserting the same
-- confirmation code while workspace B was active rewrote `workspace_id` from A to B and that income left workspace A's
-- Payments. The key now carries the workspace, so a row is only ever matched - and only ever updated - inside its own.
--
-- `workspace_id` is nullable (mail filed before a workspace was known), and a nullable column in a unique key would make
-- those rows non-idempotent, so the key uses a STORED generated column that folds NULL to the nil uuid: a real column, so
-- PostgREST's `on_conflict` can name it (the same reason as `profiles.email_lower`).
--
-- Additive and idempotent. The replaced constraint was strictly STRONGER than the new index, so no existing row can
-- conflict with it; no grant, policy or data change.

alter table public.channel_payout_records
  add column if not exists workspace_key uuid
    generated always as (coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored;

create unique index if not exists channel_payout_records_workspace_key_idx
  on public.channel_payout_records (manager_user_id, platform, confirmation_code, kind, workspace_key);

alter table public.channel_payout_records drop constraint if exists channel_payout_records_key;
