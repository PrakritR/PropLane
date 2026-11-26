-- A remote MCP connection is now either a MANAGER connection (one workspace,
-- `workspace_id` set) or a RESIDENT connection (the signed-in resident's own
-- residency, `workspace_id` null). `portal` is what the bearer resolver reads to
-- pick the one registry + context resolver for the connection; it is chosen at
-- consent and never changes. Additive and idempotent: every existing row is a
-- manager connection.
alter table public.mcp_oauth_authorization_codes
  add column if not exists portal text not null default 'manager';

alter table public.mcp_oauth_tokens
  add column if not exists portal text not null default 'manager';

alter table public.mcp_oauth_authorization_codes
  drop constraint if exists mcp_oauth_authorization_codes_portal_check;
alter table public.mcp_oauth_authorization_codes
  add constraint mcp_oauth_authorization_codes_portal_check check (portal in ('manager', 'resident'));

alter table public.mcp_oauth_tokens
  drop constraint if exists mcp_oauth_tokens_portal_check;
alter table public.mcp_oauth_tokens
  add constraint mcp_oauth_tokens_portal_check check (portal in ('manager', 'resident'));
