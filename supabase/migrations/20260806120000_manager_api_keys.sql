-- Manager API keys — the credential a third-party agent harness uses to reach
-- the MCP server (`/api/mcp`) and the public tool API (`/api/v1/tools`).
--
-- Security posture, deliberately identical to every other trust table here:
--   * RLS enabled with NO policies. This table decides who may call the tool
--     layer, so the PostgREST default-deny for anon/authenticated IS the gate.
--     A client-reachable write grant would let anyone mint themselves a key.
--   * The plaintext token is NEVER stored. `token_sha256` is the lookup key and
--     `token_prefix` exists only so the UI can name a key the manager already
--     copied. (Do not copy `document_share_links`, which stores its token in
--     the clear — that is a known wart, not the pattern.)
--   * `scopes` is advisory storage only. The gateway re-checks it on every
--     call, and a key never carries a role: the manager/owner role is
--     re-derived from `profile_roles` per request, so revoking the role
--     revokes every key with it.

create table if not exists public.manager_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  -- Display-only leading segment, e.g. "pl_live_a3f9". Not unique, not secret.
  token_prefix text not null,
  -- sha256 hex of the full token. Unique so a lookup is a single index probe.
  token_sha256 text not null unique,
  scopes text[] not null default array['read'],
  -- manager | resident | vendor. Only 'manager' is served today; the column is
  -- here so adding a portal later is additive rather than a migration on a
  -- table that already holds live credentials.
  portal text not null default 'manager',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);

create index if not exists manager_api_keys_user_idx
  on public.manager_api_keys (user_id, created_at desc);

alter table public.manager_api_keys enable row level security;
-- No policies on purpose: default-deny for anon/authenticated PostgREST.
-- Every read and write goes through a service-role route that has already
-- authorized the session.
-- RLS is the immediate gate, but Supabase's platform defaults can grant DML
-- to PostgREST roles. Revoke it explicitly as a second, migration-visible
-- barrier so a future policy cannot accidentally make this credential store
-- browser-writable.
revoke insert, update, delete on table public.manager_api_keys from anon, authenticated;
