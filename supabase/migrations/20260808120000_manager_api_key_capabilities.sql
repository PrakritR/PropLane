-- API keys originally shipped with broad read/write scopes. Keep those rows
-- usable as MCP credentials, while new keys carry an explicit connection type
-- and an exact allowlist that the public gateway enforces on every request.
alter table if exists public.manager_api_keys
  add column if not exists transport text not null default 'mcp',
  add column if not exists allowed_tools text[] not null default array[]::text[];

alter table if exists public.manager_api_keys
  drop constraint if exists manager_api_keys_transport_check;

alter table if exists public.manager_api_keys
  add constraint manager_api_keys_transport_check check (transport in ('mcp', 'api'));
