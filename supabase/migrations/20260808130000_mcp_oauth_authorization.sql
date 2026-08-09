-- OAuth 2.1 state for the remote MCP server. These are credentials and grants,
-- so PostgREST is default-deny: service-role routes are the only access path.
create table if not exists public.mcp_oauth_clients (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  client_name text,
  redirect_uris text[] not null,
  created_at timestamptz not null default now()
);

create table if not exists public.mcp_oauth_authorization_codes (
  id uuid primary key default gen_random_uuid(),
  code_sha256 text not null unique,
  user_id uuid not null references auth.users (id) on delete cascade,
  client_id text not null references public.mcp_oauth_clients (client_id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  scopes text[] not null default array['mcp:tools'],
  expires_at timestamptz not null,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.mcp_oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  access_token_sha256 text not null unique,
  refresh_token_sha256 text not null unique,
  user_id uuid not null references auth.users (id) on delete cascade,
  client_id text not null references public.mcp_oauth_clients (client_id) on delete cascade,
  scopes text[] not null default array['mcp:tools'],
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists mcp_oauth_tokens_user_created_idx on public.mcp_oauth_tokens (user_id, created_at desc);
create index if not exists mcp_oauth_codes_user_created_idx on public.mcp_oauth_authorization_codes (user_id, created_at desc);

alter table public.mcp_oauth_clients enable row level security;
alter table public.mcp_oauth_authorization_codes enable row level security;
alter table public.mcp_oauth_tokens enable row level security;

revoke all on public.mcp_oauth_clients from anon, authenticated;
revoke all on public.mcp_oauth_authorization_codes from anon, authenticated;
revoke all on public.mcp_oauth_tokens from anon, authenticated;
