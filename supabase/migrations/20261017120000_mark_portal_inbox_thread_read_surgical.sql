begin;

-- Flip ONE conversation's `unread` to false without rewriting `row_data`.
--
-- `mark_portal_inbox_source_read` (20260913170000) already does this for the manager
-- scope, under a compare-and-set on the whole stored row. The merged-conversation
-- read-settle needs the same surgery for the resident / vendor / admin scopes, where the
-- row can also be owner-less (a manager's notice addressed to an email that has no account
-- yet), so neither of that function's two hard gates applies.
--
-- It touches the one jsonb key, so a turn appended between the caller's read and this write
-- survives: there is no snapshot of `messages` to put back. That is the difference from the
-- read-modify-write it replaces, and it is why this needs no retry loop.
--
-- Authorization stays with the caller: the route lists the sibling ids through the viewer's
-- own scope filter and passes only ids that read returned. This never widens what a caller
-- can see, and it can only ever clear `unread` — never set it, never touch anything else.
create or replace function public.mark_portal_inbox_thread_read_surgical(
  p_id text, p_scope text
) returns boolean
language sql volatile security invoker set search_path = '' as $$
  with changed as (
    update public.portal_inbox_thread_records
    set row_data = pg_catalog.jsonb_set(row_data, '{unread}', 'false'::jsonb, true),
        updated_at = greatest(pg_catalog.clock_timestamp(), updated_at + interval '1 microsecond')
    where p_id <> '' and id = p_id
      and p_scope <> '' and scope = p_scope
      and row_data->'unread' = 'true'::jsonb
    returning id
  ) select exists(select 1 from changed);
$$;

revoke all on function public.mark_portal_inbox_thread_read_surgical(text,text) from public, anon, authenticated;
grant execute on function public.mark_portal_inbox_thread_read_surgical(text,text) to service_role;

commit;
