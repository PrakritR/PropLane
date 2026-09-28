-- W001: an API key / MCP OAuth connection had no workspace dimension at all,
-- so `resolveApiKeyContext` built an `AgentContext` with `workspace: undefined`
-- — the same shape `manager-workspace-scope.ts` reserves for "workspace
-- scoping does not apply here" — and every tool call made through a bearer
-- credential silently reached ALL of the manager's workspaces, wider than the
-- same account's own portal session. Additive, idempotent: existing keys and
-- tokens backfill to the owner's DEFAULT workspace (narrowing, never
-- widening what they could already reach as that owner).

alter table public.manager_api_keys
  add column if not exists workspace_id uuid references public.portal_workspaces(id) on delete set null;

alter table public.mcp_oauth_authorization_codes
  add column if not exists workspace_id uuid references public.portal_workspaces(id) on delete set null;

alter table public.mcp_oauth_tokens
  add column if not exists workspace_id uuid references public.portal_workspaces(id) on delete set null;

create index if not exists manager_api_keys_workspace_idx on public.manager_api_keys(workspace_id);
create index if not exists mcp_oauth_tokens_workspace_idx on public.mcp_oauth_tokens(workspace_id);

-- Backfill every existing key/token to its owner's default workspace.
-- `ensure_default_portal_workspace` is idempotent (creates the row only if
-- missing) and already used the same way by the property-workspace backfill
-- in `20260911230000_portal_workspaces.sql`.
do $$
declare r record;
begin
  for r in select id, user_id from public.manager_api_keys where workspace_id is null loop
    update public.manager_api_keys
      set workspace_id = public.ensure_default_portal_workspace(r.user_id)
      where id = r.id;
  end loop;

  for r in select id, user_id from public.mcp_oauth_tokens where workspace_id is null loop
    update public.mcp_oauth_tokens
      set workspace_id = public.ensure_default_portal_workspace(r.user_id)
      where id = r.id;
  end loop;

  -- Authorization codes are short-lived (5 minute TTL) and any row still
  -- present here at migration time is already expired/unusable — no live
  -- credential depends on this backfill, it exists only so the column is
  -- never null while a code is briefly in flight.
  for r in select id, user_id from public.mcp_oauth_authorization_codes where workspace_id is null loop
    update public.mcp_oauth_authorization_codes
      set workspace_id = public.ensure_default_portal_workspace(r.user_id)
      where id = r.id;
  end loop;
end $$;
