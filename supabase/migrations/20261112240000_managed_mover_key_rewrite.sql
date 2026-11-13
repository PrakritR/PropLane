-- Managed mover: rewrite the TEXT KEYS that embed the old owner's user id (captain, Nov 12).
--
-- `move_managed_workspace_to_service_owner` re-points owner COLUMNS, but several stored keys are built from the owner id,
-- so after a move the app (which derives the same key from the NEW owner) no longer finds the history and mints a second
-- thread/conversation. This migration `create or replace`s the mover and the undo so the SAME transaction also rewrites, for
-- in-scope rows only:
--   * Team chat ids      `team-thread:<from>:ws:<ws>` (+ the two legacy forms `team-thread:<from>:<house>`, `team-thread:<from>`)
--                        src/lib/team-thread-id.ts:22,28            -> portal_inbox_thread_records.id (+ row_data.id)
--   * House chat ids     `house-thread:<from>:ws:<ws>:prop:<id>`    src/lib/house-thread-id.ts:34 -> same table/column
--   * SMS notice ids     `sms_notice_<sha256("<from>:<phone>")>`    src/lib/sms-inbox-notice.server.ts:38 -> same; rewritten only
--                        when the hash recomputes exactly from the row's own phone (otherwise left, never guessed)
--   * SMS conversation keys `<from>:<role>:<ref>` (and the older `smsv2:<from>:...`), src/lib/sms-conversation-identity.ts:72
--                        -> inbound_sms_log / manager_sms_messages / sms_outbox / manager_sms_conversation_houses /
--                           prospect_tour_scheduling_state / prospect_sms_tour_reminders `.conversation_key`;
--                           sms_projection_conversations `.conversation_key|legacy_conversation_key|identity_key`;
--                           sms_projection_aliases / sms_projection_ambiguous_aliases `.alias_value` (ACCOUNT tables: only
--                           when the client has no other live workspace, like every ACCOUNT row)
--   * Columns that REFERENCE a renamed inbox thread id follow it (aliases, provider refs, prospect_contexts, sms_reply_handles,
--     stay_message_sends, vendor_work_identity_reply_bindings, agent_sessions.inbox_thread_id).
-- NOT rewritten (reported only): KEEP tables (sms_consent_events, manager_tour_followup_controls), idempotency/dedupe keys
-- (action_events.event_key, *.idempotency_key, sms_projection_turns.source_namespace `twilio:<owner>:<sid>`, sms_reply_debounce),
-- and the client's own Assistant threads: `agent_notice_<user>[__<ws>]` are PER PERSON and now stay with the client (the scope
-- predicate for portal_inbox_thread_records excludes them, so the mover no longer re-points them to the admin).
-- A key that would collide with a row the service owner already has STOPS the run (dry run reports it, a real run raises and
-- writes nothing): never merged. Every old value is stashed so the undo restores it exactly. Additive, idempotent, service_role only.

create or replace function public.managed_move_rekey(p_value text, p_from uuid, p_to uuid)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_value is null then null
    when starts_with(p_value, p_from::text || ':') then p_to::text || substr(p_value, length(p_from::text) + 1)
    when starts_with(p_value, 'smsv2:' || p_from::text || ':') then 'smsv2:' || p_to::text || substr(p_value, length('smsv2:' || p_from::text) + 1)
    when p_value = 'team-thread:' || p_from::text or starts_with(p_value, 'team-thread:' || p_from::text || ':')
      then 'team-thread:' || p_to::text || substr(p_value, length('team-thread:' || p_from::text) + 1)
    when starts_with(p_value, 'house-thread:' || p_from::text || ':')
      then 'house-thread:' || p_to::text || substr(p_value, length('house-thread:' || p_from::text) + 1)
    else p_value
  end;
$$;
revoke all on function public.managed_move_rekey(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.managed_move_rekey(text, uuid, uuid) to service_role;

-- (table, column): every stored SMS conversation key / alias. Kept in step with tests/unit/managed-mover-key-rewrite.test.ts.
create or replace function public.managed_move_key_columns()
returns table (table_name text, column_name text)
language sql
immutable
set search_path = public
as $$
  select * from (values
    ('inbound_sms_log', 'conversation_key'),
    ('manager_sms_messages', 'conversation_key'),
    ('sms_outbox', 'conversation_key'),
    ('manager_sms_conversation_houses', 'conversation_key'),
    ('prospect_tour_scheduling_state', 'conversation_key'),
    ('prospect_sms_tour_reminders', 'conversation_key'),
    ('sms_projection_conversations', 'conversation_key'),
    ('sms_projection_conversations', 'legacy_conversation_key'),
    ('sms_projection_conversations', 'identity_key'),
    ('sms_projection_aliases', 'alias_value'),
    ('sms_projection_ambiguous_aliases', 'alias_value')
  ) as t(table_name, column_name);
$$;
revoke all on function public.managed_move_key_columns() from public, anon, authenticated;
grant execute on function public.managed_move_key_columns() to service_role;

-- (table, column): columns holding an INBOX THREAD ID, followed when a thread is renamed. The two FK children are renamed
-- inside managed_move_rename_inbox_thread and are not listed.
create or replace function public.managed_move_thread_ref_columns()
returns table (table_name text, column_name text)
language sql
immutable
set search_path = public
as $$
  select * from (values
    ('prospect_contexts', 'thread_id'),
    ('sms_reply_handles', 'thread_id'),
    ('stay_message_sends', 'thread_id'),
    ('vendor_work_identity_reply_bindings', 'thread_id'),
    ('agent_sessions', 'inbox_thread_id')
  ) as t(table_name, column_name);
$$;
revoke all on function public.managed_move_thread_ref_columns() from public, anon, authenticated;
grant execute on function public.managed_move_thread_ref_columns() to service_role;

-- The inbox threads whose ID embeds the old owner and belong to this workspace. `shape` is team | house | legacy_team_house |
-- legacy_team | sms_notice. A per-person Assistant thread (`agent_notice_*`) is never a candidate. `collision` is non-empty when the
-- new id (or the owner/workspace/scope/conversation_key slot) is already taken.
create or replace function public.managed_move_thread_plan(p_workspace uuid, p_from uuid, p_to uuid, p_house_ids text[], p_other_live integer)
returns table (old_id text, new_id text, shape text, collision text)
language sql
stable
set search_path = public
as $$
  with cand as (
    select t.id, t.scope, t.workspace_id, t.conversation_key,
      case
        when t.id = 'team-thread:' || p_from::text || ':ws:' || p_workspace::text then 'team'
        when starts_with(t.id, 'house-thread:' || p_from::text || ':ws:' || p_workspace::text || ':prop:') then 'house'
        when t.id = any (select 'team-thread:' || p_from::text || ':' || h from unnest(p_house_ids) h) then 'legacy_team_house'
        when p_other_live = 0 and t.id = 'team-thread:' || p_from::text then 'legacy_team'
      end as shape,
      public.managed_move_rekey(t.id, p_from, p_to) as new_id
    from public.portal_inbox_thread_records t
    where t.owner_user_id = p_from
      and left(t.id, 13) <> 'agent_notice_' and t.thread_type is distinct from 'agent_notice'
    union all
    select t.id, t.scope, t.workspace_id, t.conversation_key, 'sms_notice',
      'sms_notice_' || encode(sha256(convert_to(p_to::text || ':' || ph, 'UTF8')), 'hex')
    from public.portal_inbox_thread_records t
    cross join lateral (
      select public.axis_sms_phone_ref(x) as ph from unnest(array[t.row_data ->> 'from', t.row_data ->> 'smsNoticePhone']) x
      where x is not null and x <> ''
    ) p
    where t.owner_user_id = p_from and left(t.id, 11) = 'sms_notice_'
      and (t.workspace_id = p_workspace or (t.workspace_id is null and p_other_live = 0))
      and t.id = 'sms_notice_' || encode(sha256(convert_to(p_from::text || ':' || ph, 'UTF8')), 'hex')
  )
  select c.id, c.new_id, c.shape,
    case
      when exists (select 1 from public.portal_inbox_thread_records o where o.id = c.new_id) then 'id_exists'
      when c.conversation_key is not null and c.workspace_id is not null and exists (
        select 1 from public.portal_inbox_thread_records o
        where o.owner_user_id = p_to and o.workspace_id = c.workspace_id and o.scope = c.scope and o.conversation_key = c.conversation_key and o.id <> c.id
      ) then 'conversation_key_exists'
      else ''
    end
  from (select distinct on (id) * from cand where shape is not null order by id) c
  where c.new_id <> c.id;
$$;
revoke all on function public.managed_move_thread_plan(uuid, uuid, uuid, text[], integer) from public, anon, authenticated;
grant execute on function public.managed_move_thread_plan(uuid, uuid, uuid, text[], integer) to service_role;

-- Rename one inbox thread (its id is a primary key two tables reference with no ON UPDATE CASCADE): insert the copy under the
-- new id (conversation_key held back so the owner/workspace/scope/key unique slot is never doubled), relink the children,
-- delete the old row, restore the key. row_data.id follows the id (the thread JSON carries its own id).
create or replace function public.managed_move_rename_inbox_thread(p_old text, p_new text, p_owner uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.portal_inbox_thread_records%rowtype;
  v_data jsonb;
begin
  select * into r from public.portal_inbox_thread_records where id = p_old for update;
  if not found then
    raise exception 'managed move: inbox thread % not found', p_old using errcode = 'P0002';
  end if;
  v_data := case when r.row_data ->> 'id' = p_old then jsonb_set(r.row_data, '{id}', to_jsonb(p_new)) else r.row_data end;
  insert into public.portal_inbox_thread_records
    select (jsonb_populate_record(null::public.portal_inbox_thread_records,
      to_jsonb(r) || jsonb_build_object('id', p_new, 'owner_user_id', p_owner, 'conversation_key', null, 'row_data', v_data))).*;
  update public.portal_inbox_thread_aliases set thread_id = p_new where thread_id = p_old;
  if to_regclass('public.inbox_message_provider_refs') is not null then
    update public.inbox_message_provider_refs set thread_record_id = p_new where thread_record_id = p_old;
  end if;
  delete from public.portal_inbox_thread_records where id = p_old;
  if r.conversation_key is not null then
    update public.portal_inbox_thread_records set conversation_key = r.conversation_key where id = p_new;
  end if;
end;
$$;
revoke all on function public.managed_move_rename_inbox_thread(text, text, uuid) from public, anon, authenticated;
grant execute on function public.managed_move_rename_inbox_thread(text, text, uuid) to service_role;

-- The scope predicate again, with ONE addition: a PER-PERSON Assistant thread (`agent_notice_<user>[__<ws>]`) is the client's
-- own and never moves to the admin, even when it is stamped with the workspace.
drop function if exists public.managed_move_scope_predicate(text, text);
create or replace function public.managed_move_scope_predicate(p_table text, p_id_col text, p_residual boolean default false)
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  v_parts text[] := '{}';
  v_nulls text[] := '{}';
  v_pred text;
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = p_table and column_name = 'property_id') then
    v_parts := array_append(v_parts, 'property_id::text = any($4)'::text);
    v_nulls := array_append(v_nulls, 'property_id is null'::text);
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = p_table and column_name = 'assigned_property_id') then
    v_parts := array_append(v_parts, 'assigned_property_id::text = any($4)'::text);
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = p_table and column_name = 'workspace_id') then
    v_parts := array_append(v_parts, 'workspace_id = $3'::text);
    v_nulls := array_append(v_nulls, 'workspace_id is null'::text);
  end if;
  if p_residual and cardinality(v_nulls) > 0 then
    v_parts := array_append(v_parts, '(' || array_to_string(v_nulls, ' and ') || ')');
  end if;
  if cardinality(v_parts) = 0 then
    raise exception 'managed move classification error: % is MOVE but has no property_id, assigned_property_id or workspace_id', p_table using errcode = 'XX000';
  end if;
  v_pred := format('%I = $2 and (%s)', p_id_col, array_to_string(v_parts, ' or '));
  if p_table = 'portal_inbox_thread_records' then
    v_pred := v_pred || ' and left(id, 13) <> ''agent_notice_'' and thread_type is distinct from ''agent_notice''';
  end if;
  return v_pred;
end;
$$;
revoke all on function public.managed_move_scope_predicate(text, text, boolean) from public, anon, authenticated;
grant execute on function public.managed_move_scope_predicate(text, text, boolean) to service_role;

-- ------------------------------------------------------------------- mover --
create or replace function public.move_managed_workspace_to_service_owner(
  p_workspace uuid,
  p_expected_from uuid,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ws public.portal_workspaces%rowtype;
  v_from uuid := p_expected_from;
  v_to uuid;
  v_house_ids text[];
  v_stops text[] := '{}';
  v_other_live integer;
  v_move jsonb := '{}'::jsonb;
  v_account jsonb := '{}'::jsonb;
  v_keep jsonb := '{}'::jsonb;
  v_left jsonb := '{}'::jsonb;
  v_moved_rows jsonb := '{}'::jsonb;
  v_prior public.managed_workspace_ownership_moves%rowtype;
  r record;
  v_pred text;
  v_pk text[];
  v_pk_list text;
  v_n bigint;
  v_total bigint;
  v_rows jsonb;
  v_seats_before jsonb;
  v_seat_deleted jsonb := '[]'::jsonb;
  v_seat_reinvited jsonb := '[]'::jsonb;
  v_seat_inserted uuid;
  v_client_seat_exists boolean;
  v_other_owner_of_record boolean;
  v_other_seat_for_client boolean;
  v_owner_perms jsonb := jsonb_build_object(
    'ownerPerformance', jsonb_build_object('read', true, 'notification', true),
    'ownerStatements', jsonb_build_object('read', true, 'notification', true),
    'ownerDocuments', jsonb_build_object('read', true, 'notification', true),
    'ownerMessages', jsonb_build_object('read', true, 'notification', true)
  );
  v_house_map jsonb;
  v_numbers jsonb := '[]'::jsonb;
  v_emails jsonb := '[]'::jsonb;
  v_aliases jsonb := '[]'::jsonb;
  v_holds jsonb := '[]'::jsonb;
  v_number_values text[];
  v_cleared_profile text;
  v_houses integer;
  v_open_checkouts integer;
  v_stale_pending integer;
  v_inflight_withdrawals integer;
  v_unclassified jsonb := '{}'::jsonb;
  v_table_count integer := 0;
  v_key_counts jsonb := '{}'::jsonb;
  v_sms_counts jsonb := '{}'::jsonb;
  v_ref_counts jsonb := '{}'::jsonb;
  v_plan jsonb := '[]'::jsonb;
  v_keyrw jsonb := '{}'::jsonb;
  v_key_changes jsonb := '[]'::jsonb;
  v_thread_changes jsonb := '[]'::jsonb;
  v_ref_changes jsonb := '[]'::jsonb;
  v_before jsonb;
  v_pkjoin text;
  v_old_ids text[];
  v_cur_owner uuid;
  v_agent_kept bigint;
  v_unique boolean;
begin
  if p_workspace is null or p_expected_from is null then
    raise exception 'Workspace and expected current owner are required.' using errcode = '22023';
  end if;

  select owner_user_id into v_to from public.platform_service_settings where singleton = true;
  if v_to is null then
    raise exception 'The PropLane service owner is not configured.' using errcode = 'P0002';
  end if;

  if not p_dry_run then
    perform pg_advisory_xact_lock(723081447301::bigint);
    select * into v_ws from public.portal_workspaces where id = p_workspace for update;
  else
    select * into v_ws from public.portal_workspaces where id = p_workspace;
  end if;
  if not found then
    raise exception 'Workspace not found.' using errcode = 'P0002';
  end if;

  -- Idempotent: a workspace already moved returns the stored counts and writes nothing.
  select * into v_prior from public.managed_workspace_ownership_moves where workspace_id = p_workspace and undone_at is null;
  if found and v_ws.owner_user_id = v_to then
    return jsonb_build_object('status', 'already_moved', 'workspace', p_workspace, 'from', v_prior.from_user_id, 'to', v_prior.to_user_id,
                              'movedAt', v_prior.moved_at, 'counts', v_prior.counts);
  end if;

  -- ---- guards (stops: reported on a dry run, raised before anything is written on a real one)
  if v_ws.is_service is distinct from true then v_stops := array_append(v_stops, ('workspace_not_service')::text); end if;
  if v_ws.owner_user_id is distinct from v_from then v_stops := array_append(v_stops, ('owner_is_not_expected_from')::text); end if;
  if v_from = v_to then v_stops := array_append(v_stops, ('from_equals_service_owner')::text); end if;
  if not exists (select 1 from public.profile_roles where user_id = v_to and role = 'admin') then
    v_stops := array_append(v_stops, ('service_owner_lacks_admin_role')::text);
  end if;
  if not exists (select 1 from public.profiles where id = v_from) then v_stops := array_append(v_stops, ('from_profile_missing')::text); end if;

  select coalesce(array_agg(id::text order by id), '{}') into v_house_ids from public.manager_property_records where workspace_id = p_workspace;
  v_houses := cardinality(v_house_ids);
  if exists (select 1 from public.manager_property_records where workspace_id = p_workspace and manager_user_id is distinct from v_from) then
    v_stops := array_append(v_stops, ('house_not_owned_by_expected_from')::text);
  end if;

  select count(*) into v_other_live from public.portal_workspaces
    where owner_user_id = v_from and id <> p_workspace and archived_at is null;

  -- open checkout attempts (money in flight under the old manager id) and reserved withdrawals stop the run
  select count(*) into v_open_checkouts from public.resident_checkout_attempts
    where manager_user_id = v_from and status in ('pending', 'processing') and created_at > now() - interval '24 hours';
  if v_open_checkouts > 0 then v_stops := array_append(v_stops, (('open_checkout_attempts:' || v_open_checkouts))::text); end if;
  select count(*) into v_stale_pending from public.resident_checkout_attempts
    where manager_user_id = v_from and status in ('pending', 'processing') and created_at <= now() - interval '24 hours';
  select count(*) into v_inflight_withdrawals from public.party_withdrawals
    where workspace_id = p_workspace and status in ('reserved', 'unknown');
  if v_inflight_withdrawals > 0 then v_stops := array_append(v_stops, (('pending_withdrawals:' || v_inflight_withdrawals))::text); end if;

  -- the client's seat: refuse when another owner of record, or a different-role seat of the client, is already there
  select exists (select 1 from public.account_link_invites where workspace_id = p_workspace and is_owner_of_record = true
                   and status in ('accepted', 'pending') and invitee_user_id is distinct from v_from) into v_other_owner_of_record;
  if v_other_owner_of_record then v_stops := array_append(v_stops, ('another_owner_of_record_seated')::text); end if;
  select exists (select 1 from public.account_link_invites where workspace_id = p_workspace and invitee_user_id = v_from
                   and status in ('accepted', 'pending') and team_role = 'property_owner') into v_client_seat_exists;
  select exists (select 1 from public.account_link_invites where workspace_id = p_workspace and invitee_user_id = v_from
                   and status in ('accepted', 'pending') and team_role is distinct from 'property_owner') into v_other_seat_for_client;
  if v_other_seat_for_client then v_stops := array_append(v_stops, ('client_holds_a_non_owner_seat')::text); end if;

  -- ---- unclassified tables: any manager-identity column not on the allowlist that holds rows for the client
  for r in
    select c.table_name::text as table_name, c.column_name::text as column_name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.table_schema = 'public'
      and c.column_name in ('manager_user_id', 'owner_user_id', 'owner_manager_user_id', 'landlord_id')
      and not exists (select 1 from public.managed_move_classification() k where k.table_name = c.table_name)
  loop
    execute format('select count(*) from public.%I where %I = $1', r.table_name, r.column_name) into v_n using v_from;
    if v_n > 0 then
      v_unclassified := v_unclassified || jsonb_build_object(r.table_name, v_n);
      v_stops := array_append(v_stops, (('unclassified_table:' || r.table_name || ':' || v_n))::text);
    end if;
  end loop;

  -- ---- plan: counts for every MOVE / ACCOUNT / KEEP table
  for r in select * from public.managed_move_classification() where klass in ('move', 'account', 'keep') order by klass, table_name loop
    if to_regclass('public.' || quote_ident(r.table_name)) is null then continue; end if;
    v_table_count := v_table_count + 1;
    if r.klass = 'move' then
      v_pred := public.managed_move_scope_predicate(r.table_name, r.id_col, v_other_live = 0);
      execute format('select count(*) from public.%I where %s', r.table_name, v_pred) into v_n using v_to, v_from, p_workspace, v_house_ids;
      execute format('select count(*) from public.%I where %I = $2', r.table_name, r.id_col) into v_total using v_to, v_from;
      if v_n > 0 then v_move := v_move || jsonb_build_object(r.table_name, v_n); end if;
      if v_total - v_n > 0 then v_left := v_left || jsonb_build_object(r.table_name, v_total - v_n); end if;
    elsif r.klass = 'account' then
      execute format('select count(*) from public.%I where %I = $2', r.table_name, r.id_col) into v_n using v_to, v_from;
      if v_n > 0 then
        v_account := v_account || jsonb_build_object(r.table_name, v_n);
        if v_other_live > 0 then v_stops := array_append(v_stops, (('account_level_rows_with_another_live_workspace:' || r.table_name))::text); end if;
      end if;
    else
      execute format('select count(*) from public.%I where %I = $2', r.table_name, r.id_col) into v_n using v_to, v_from;
      if v_n > 0 then v_keep := v_keep || jsonb_build_object(r.table_name, v_n); end if;
    end if;
  end loop;

  -- ---- key rewrites: text keys that embed the old owner's user id (plan, counts and collisions; same on a dry run)
  for r in
    select k.table_name, k.column_name, c.klass, c.id_col
    from public.managed_move_key_columns() k join public.managed_move_classification() c on c.table_name = k.table_name
    order by k.table_name, k.column_name
  loop
    if to_regclass('public.' || quote_ident(r.table_name)) is null then continue; end if;
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = r.table_name and column_name = r.column_name) then continue; end if;
    if r.klass = 'move' then
      v_pred := public.managed_move_scope_predicate(r.table_name, r.id_col, v_other_live = 0);
    else
      v_pred := format('%I = $2', r.id_col);
    end if;
    execute format('select count(*) from public.%1$I where (%2$s) and %3$I is not null and public.managed_move_rekey(%3$I, $2, $1) <> %3$I',
                   r.table_name, v_pred, r.column_name) into v_n using v_to, v_from, p_workspace, v_house_ids;
    if v_n > 0 then
      v_sms_counts := v_sms_counts || jsonb_build_object(r.table_name || '.' || r.column_name, v_n);
      select exists (
        select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
        where i.indrelid = to_regclass('public.' || quote_ident(r.table_name)) and i.indisunique and a.attname = r.column_name
      ) into v_unique;
      if v_unique then
        execute format('select count(*) from public.%1$I t where (%2$s) and %3$I is not null and exists (select 1 from public.%1$I o where o.%3$I = public.managed_move_rekey(t.%3$I, $2, $1) and o.%4$I = $1 and o.%3$I <> t.%3$I)',
                       r.table_name, v_pred, r.column_name, r.id_col) into v_total using v_to, v_from, p_workspace, v_house_ids;
        if v_total > 0 then v_stops := array_append(v_stops, (('key_collision:' || r.table_name || '.' || r.column_name || ':' || v_total))::text); end if;
      end if;
    end if;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('oldId', p.old_id, 'newId', p.new_id, 'shape', p.shape, 'collision', p.collision) order by p.old_id), '[]'::jsonb)
    into v_plan from public.managed_move_thread_plan(p_workspace, v_from, v_to, v_house_ids, v_other_live) p;
  for r in select * from jsonb_to_recordset(v_plan) as x("oldId" text, "newId" text, shape text, collision text) where coalesce(collision, '') <> '' loop
    v_stops := array_append(v_stops, (('key_collision:' || r."oldId" || ':' || r.collision))::text);
  end loop;
  select coalesce(array_agg(x."oldId"), '{}') into v_old_ids from jsonb_to_recordset(v_plan) as x("oldId" text);
  for r in select to_regclass('public.' || quote_ident(c.table_name)) as reg, c.table_name, c.column_name from public.managed_move_thread_ref_columns() c loop
    if r.reg is null then continue; end if;
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = r.table_name and column_name = r.column_name) then continue; end if;
    execute format('select count(*) from public.%I where %I = any($1)', r.table_name, r.column_name) into v_n using v_old_ids;
    if v_n > 0 then v_ref_counts := v_ref_counts || jsonb_build_object(r.table_name || '.' || r.column_name, v_n); end if;
  end loop;
  select count(*) into v_agent_kept from public.portal_inbox_thread_records
    where owner_user_id = v_from and (left(id, 13) = 'agent_notice_' or thread_type is not distinct from 'agent_notice')
      and (workspace_id = p_workspace or (workspace_id is null and v_other_live = 0));
  v_key_counts := jsonb_build_object(
    'smsKeys', v_sms_counts,
    'inboxThreads', (select coalesce(jsonb_object_agg(s.shape, s.n), '{}'::jsonb) from (select x.shape, count(*) n from jsonb_to_recordset(v_plan) as x(shape text) group by x.shape) s),
    'inboxThreadIds', (select coalesce(jsonb_agg(x."oldId" order by x."oldId"), '[]'::jsonb) from (select * from jsonb_to_recordset(v_plan) as y("oldId" text) limit 25) x),
    'threadRefs', v_ref_counts,
    'agentNoticeThreadsKeptWithClient', v_agent_kept
  );

  if p_dry_run then
    return jsonb_build_object(
      'status', 'dry_run', 'workspace', p_workspace, 'workspaceName', v_ws.name, 'from', v_from, 'to', v_to,
      'houses', to_jsonb(v_house_ids), 'houseCount', v_houses, 'otherLiveWorkspacesOfClient', v_other_live,
      'move', v_move, 'account', v_account, 'keep', v_keep, 'leftBehind', v_left, 'unclassified', v_unclassified,
      'tablesScanned', v_table_count, 'openCheckouts', v_open_checkouts, 'stalePendingCheckouts', v_stale_pending,
      'pendingWithdrawals', v_inflight_withdrawals, 'clientSeatExists', v_client_seat_exists,
      'serviceOwnerOwnSeat', exists (select 1 from public.account_link_invites where workspace_id = p_workspace and inviter_user_id = v_from and invitee_user_id = v_to),
      'keyRewrites', v_key_counts,
      'stops', to_jsonb(v_stops)
    );
  end if;

  if cardinality(v_stops) > 0 then
    raise exception 'managed move refused, nothing written: %', array_to_string(v_stops, '; ') using errcode = 'P0001';
  end if;

  -- ---- apply. Held off for this transaction only, exactly like the ownership-transfer RPC.
  perform set_config('app.workspace_ownership_transfer', 'on', true);

  select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb) into v_seats_before from public.account_link_invites l where l.workspace_id = p_workspace;

  update public.portal_workspaces set owner_user_id = v_to, is_default = false where id = p_workspace;
  update public.manager_property_records set manager_user_id = v_to, updated_at = now()
    where workspace_id = p_workspace and manager_user_id = v_from;

  for r in select * from public.managed_move_classification() where klass in ('move', 'account') order by klass, table_name loop
    if to_regclass('public.' || quote_ident(r.table_name)) is null then continue; end if;
    v_pk := public.managed_move_pk_columns(r.table_name);
    if cardinality(v_pk) = 0 then
      raise exception 'managed move classification error: % has no primary key, so its move could not be undone', r.table_name using errcode = 'XX000';
    end if;
    select string_agg(format('%I', c), ', ') into v_pk_list from unnest(v_pk) as c;
    if r.klass = 'move' then
      v_pred := public.managed_move_scope_predicate(r.table_name, r.id_col, v_other_live = 0);
    else
      v_pred := format('%I = $2', r.id_col);
    end if;
    execute format('with m as (update public.%I set %I = $1 where %s returning %s) select count(*), coalesce(jsonb_agg(to_jsonb(m)), ''[]''::jsonb) from m',
                   r.table_name, r.id_col, v_pred, v_pk_list)
      into v_n, v_rows using v_to, v_from, p_workspace, v_house_ids;
    if v_n > 0 then v_moved_rows := v_moved_rows || jsonb_build_object(r.table_name, jsonb_build_object('idCol', r.id_col, 'pk', to_jsonb(v_pk), 'rows', v_rows)); end if;
  end loop;

  -- ---- text keys that embed the old owner id (same transaction; every old value stashed for the undo)
  for r in
    select k.table_name, k.column_name from public.managed_move_key_columns() k order by k.table_name, k.column_name
  loop
    if not (v_moved_rows ? r.table_name) then continue; end if;
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = r.table_name and column_name = r.column_name) then continue; end if;
    v_pk := public.managed_move_pk_columns(r.table_name);
    select string_agg(format('t.%1$I = k.%1$I', c), ' and ') into v_pkjoin from unnest(v_pk) as c;
    v_rows := v_moved_rows -> r.table_name -> 'rows';
    execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from public.%1$I t join jsonb_populate_recordset(null::public.%1$I, $1) k on %2$s where t.%3$I is not null and public.managed_move_rekey(t.%3$I, $2, $3) <> t.%3$I',
                   r.table_name, v_pkjoin, r.column_name) into v_before using v_rows, v_from, v_to;
    if jsonb_array_length(v_before) = 0 then continue; end if;
    begin
      execute format('update public.%1$I t set %3$I = public.managed_move_rekey(t.%3$I, $2, $3) from jsonb_populate_recordset(null::public.%1$I, $1) k where %2$s and t.%3$I is not null and public.managed_move_rekey(t.%3$I, $2, $3) <> t.%3$I',
                     r.table_name, v_pkjoin, r.column_name) using v_rows, v_from, v_to;
    exception when unique_violation then
      raise exception 'managed move refused, nothing written: key_collision:%.%', r.table_name, r.column_name using errcode = 'P0001';
    end;
    v_key_changes := v_key_changes || jsonb_build_array(jsonb_build_object('tbl', r.table_name, 'col', r.column_name, 'rows', v_before));
  end loop;

  -- inbox threads whose id embeds the old owner (Team chat, House chat, legacy Team ids, SMS notice). The owner column of a row
  -- the generic loop did not move (its workspace is only in the id) moves here; `ownerFixed` tells the undo which those are.
  for r in select * from jsonb_to_recordset(v_plan) as x("oldId" text, "newId" text, shape text) loop
    select owner_user_id into v_cur_owner from public.portal_inbox_thread_records where id = r."oldId";
    perform public.managed_move_rename_inbox_thread(r."oldId", r."newId", v_to);
    v_thread_changes := v_thread_changes || jsonb_build_array(jsonb_build_object('oldId', r."oldId", 'newId', r."newId", 'shape', r.shape, 'ownerFixed', v_cur_owner = v_from));
  end loop;
  for r in select to_regclass('public.' || quote_ident(c.table_name)) as reg, c.table_name, c.column_name from public.managed_move_thread_ref_columns() c loop
    if r.reg is null then continue; end if;
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = r.table_name and column_name = r.column_name) then continue; end if;
    for v_pk_list in select x."oldId" from jsonb_to_recordset(v_plan) as x("oldId" text) loop
      execute format('update public.%I set %I = public.managed_move_rekey($1, $2, $3) where %I = $1', r.table_name, r.column_name, r.column_name)
        using v_pk_list, v_from, v_to;
      get diagnostics v_n = row_count;
      if v_n > 0 then v_ref_changes := v_ref_changes || jsonb_build_array(jsonb_build_object('tbl', r.table_name, 'col', r.column_name, 'oldId', v_pk_list, 'newId', public.managed_move_rekey(v_pk_list, v_from, v_to))); end if;
    end loop;
  end loop;
  v_keyrw := jsonb_build_object('sms', v_key_changes, 'threads', v_thread_changes, 'threadRefs', v_ref_changes);

  -- memberships: the service owner's own seat goes (they own it now); every other live seat answers to the service owner;
  -- the client is seated as the Property owner of record (view-only: the four owner keys, no module key).
  with d as (delete from public.account_link_invites where workspace_id = p_workspace and inviter_user_id = v_from and invitee_user_id = v_to returning id)
    select coalesce(jsonb_agg(id), '[]'::jsonb) into v_seat_deleted from d;
  with u as (update public.account_link_invites set inviter_user_id = v_to
               where workspace_id = p_workspace and inviter_user_id = v_from and status in ('pending', 'accepted') returning id)
    select coalesce(jsonb_agg(id), '[]'::jsonb) into v_seat_reinvited from u;
  select coalesce(jsonb_object_agg(h, v_owner_perms), '{}'::jsonb) into v_house_map from unnest(v_house_ids) as h;
  if v_client_seat_exists then
    update public.account_link_invites set is_owner_of_record = true, is_service_seat = false
      where workspace_id = p_workspace and invitee_user_id = v_from and team_role = 'property_owner' and status in ('accepted', 'pending')
        and not exists (select 1 from public.account_link_invites o where o.workspace_id = p_workspace and o.is_owner_of_record = true and o.invitee_user_id <> v_from and o.status in ('accepted', 'pending'));
  else
    insert into public.account_link_invites (
      inviter_user_id, invitee_user_id, tab_kind, inviter_axis_id, invitee_axis_id, inviter_display_name, invitee_display_name,
      assigned_property_ids, payout_percent_for_manager, property_co_manager_permissions, co_manager_permissions,
      workspace_id, workspace_permissions, team_role, house_scope, invited_via, invited_at, responded_at, status,
      is_owner_of_record, is_service_seat
    )
    select v_to, v_from, 'manager', coalesce(pt.manager_id, ''), coalesce(pf.manager_id, ''),
           coalesce(pt.full_name, pt.email, 'PropLane'), coalesce(pf.full_name, pf.email, 'Owner'),
           to_jsonb(v_house_ids), 0, v_house_map, v_owner_perms,
           p_workspace, '{}'::jsonb, 'property_owner', 'selected', 'code', now(), now(), 'accepted', true, false
    from public.profiles pt, public.profiles pf where pt.id = v_to and pf.id = v_from
    returning id into v_seat_inserted;
  end if;

  -- work identity (as the ownership-transfer RPC does): numbers and emails follow the workspace; holds that would now cross
  -- owners are dropped; the client's cached default line is cleared when it just left them.
  with n as (update public.manager_sms_numbers set manager_user_id = v_to, updated_at = now()
               where workspace_id = p_workspace and manager_user_id = v_from returning id, phone_number)
    select coalesce(jsonb_agg(id), '[]'::jsonb), coalesce(array_agg(phone_number) filter (where phone_number is not null), '{}')
      into v_numbers, v_number_values from n;
  with e as (update public.manager_assistant_emails set manager_user_id = v_to
               where workspace_id = p_workspace and manager_user_id = v_from returning id)
    select coalesce(jsonb_agg(id), '[]'::jsonb) into v_emails from e;
  with a as (update public.manager_assistant_email_aliases set owner_user_id = v_to
               where owner_user_id = v_from and assistant_email_id in (select jsonb_array_elements_text(v_emails)::uuid) returning mailbox_local)
    select coalesce(jsonb_agg(mailbox_local), '[]'::jsonb) into v_aliases from a;
  with h as (delete from public.workspace_work_numbers h using public.manager_sms_numbers n
               where h.number_id = n.id and h.workspace_id = p_workspace and n.manager_user_id <> v_to returning h.*)
    select coalesce(jsonb_agg(to_jsonb(h)), '[]'::jsonb) into v_holds from h;
  with h2 as (delete from public.workspace_work_numbers h using public.manager_sms_numbers n, public.portal_workspaces w
               where h.number_id = n.id and w.id = h.workspace_id and n.workspace_id = p_workspace
                 and w.owner_user_id = v_from and h.workspace_id <> p_workspace returning h.*)
    select v_holds || coalesce(jsonb_agg(to_jsonb(h2)), '[]'::jsonb) into v_holds from h2;
  if array_length(v_number_values, 1) is not null then
    select sms_from_number into v_cleared_profile from public.profiles where id = v_from and sms_from_number = any (v_number_values);
    if v_cleared_profile is not null then
      update public.profiles set sms_from_number = null, updated_at = now() where id = v_from and sms_from_number = v_cleared_profile;
    end if;
  end if;

  insert into public.managed_workspace_ownership_moves (workspace_id, from_user_id, to_user_id, undo_until, counts, moved_rows, stash)
  values (
    p_workspace, v_from, v_to, now() + interval '2 hours',
    jsonb_build_object('houses', v_houses, 'move', v_move, 'account', v_account, 'keep', v_keep, 'leftBehind', v_left, 'keyRewrites', v_key_counts),
    v_moved_rows,
    jsonb_build_object(
      'wasDefault', v_ws.is_default, 'seatsBefore', v_seats_before, 'seatsDeleted', v_seat_deleted, 'seatsReinvited', v_seat_reinvited,
      'seatInserted', v_seat_inserted, 'clientSeatExisted', v_client_seat_exists, 'numbers', v_numbers, 'emails', v_emails,
      'aliases', v_aliases, 'holds', v_holds, 'clearedProfileLine', v_cleared_profile, 'houseIds', to_jsonb(v_house_ids), 'keyRewrites', v_keyrw
    )
  );

  perform set_config('app.workspace_ownership_transfer', 'off', true);

  return jsonb_build_object('status', 'moved', 'workspace', p_workspace, 'from', v_from, 'to', v_to, 'houses', v_houses,
                            'move', v_move, 'account', v_account, 'keep', v_keep, 'leftBehind', v_left, 'keyRewrites', v_key_counts, 'seatInserted', v_seat_inserted);
end;
$$;
revoke all on function public.move_managed_workspace_to_service_owner(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.move_managed_workspace_to_service_owner(uuid, uuid, boolean) to service_role;

-- -------------------------------------------------------------------- undo --
-- Valid only inside the read-back window (`undo_until`) and only once: restores exactly the rows the move recorded.
-- After new activity lands it is not a clean restore (design R7): forward-fix instead.
create or replace function public.undo_managed_workspace_move(p_workspace uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_move public.managed_workspace_ownership_moves%rowtype;
  r record;
  v_pk text[];
  v_pk_join text;
  v_restored bigint := 0;
  v_n bigint;
  v_stash jsonb;
  kr record;
begin
  perform pg_advisory_xact_lock(723081447301::bigint);
  select * into v_move from public.managed_workspace_ownership_moves where workspace_id = p_workspace and undone_at is null for update;
  if not found then
    raise exception 'No live ownership move to undo for this workspace.' using errcode = 'P0002';
  end if;
  if now() > v_move.undo_until then
    raise exception 'The undo window for this move has closed; forward-fix instead.' using errcode = 'P0001';
  end if;
  v_stash := v_move.stash;
  perform set_config('app.workspace_ownership_transfer', 'on', true);

  -- keys first (the owner columns are restored below by primary key, which a renamed inbox thread must have back)
  for kr in select * from jsonb_to_recordset(coalesce(v_stash #> '{keyRewrites,threadRefs}', '[]'::jsonb)) as y(tbl text, col text, "oldId" text, "newId" text) loop
    execute format('update public.%I set %I = $1 where %I = $2', kr.tbl, kr.col, kr.col) using kr."oldId", kr."newId";
  end loop;
  for kr in select * from jsonb_to_recordset(coalesce(v_stash #> '{keyRewrites,threads}', '[]'::jsonb)) as y("oldId" text, "newId" text, "ownerFixed" boolean) loop
    perform public.managed_move_rename_inbox_thread(kr."newId", kr."oldId", v_move.to_user_id);
    if kr."ownerFixed" is true then
      update public.portal_inbox_thread_records set owner_user_id = v_move.from_user_id where id = kr."oldId" and owner_user_id = v_move.to_user_id;
    end if;
  end loop;
  for kr in select * from jsonb_to_recordset(coalesce(v_stash #> '{keyRewrites,sms}', '[]'::jsonb)) as y(tbl text, col text, rows jsonb) loop
    v_pk := public.managed_move_pk_columns(kr.tbl);
    -- a key column that is itself part of the primary key (manager_sms_conversation_houses) matches on its rewritten value instead
    select string_agg(format('t.%1$I = k.%1$I', c), ' and ') into v_pk_join from unnest(v_pk) as c where c <> kr.col;
    v_pk_join := coalesce(v_pk_join, 'true');
    execute format('update public.%1$I t set %3$I = k.%3$I from jsonb_populate_recordset(null::public.%1$I, $1) k where %2$s and t.%3$I = public.managed_move_rekey(k.%3$I, $2, $3)',
                   kr.tbl, v_pk_join, kr.col) using kr.rows, v_move.from_user_id, v_move.to_user_id;
  end loop;

  update public.portal_workspaces set owner_user_id = v_move.from_user_id, is_default = coalesce((v_stash ->> 'wasDefault')::boolean, false)
    where id = p_workspace and owner_user_id = v_move.to_user_id;
  update public.manager_property_records set manager_user_id = v_move.from_user_id, updated_at = now()
    where workspace_id = p_workspace and manager_user_id = v_move.to_user_id;

  for r in select key as table_name, value as spec from jsonb_each(v_move.moved_rows) loop
    select array_agg(x) into v_pk from jsonb_array_elements_text(r.spec -> 'pk') as x;
    select string_agg(format('t.%1$I = k.%1$I', c), ' and ') into v_pk_join from unnest(v_pk) as c;
    execute format(
      'update public.%1$I t set %2$I = $1 from jsonb_populate_recordset(null::public.%1$I, $2) k where %3$s and t.%2$I = $3',
      r.table_name, r.spec ->> 'idCol', v_pk_join
    ) using v_move.from_user_id, r.spec -> 'rows', v_move.to_user_id;
    get diagnostics v_n = row_count;
    v_restored := v_restored + v_n;
  end loop;

  -- seats
  if (v_stash ->> 'seatInserted') is not null then
    delete from public.account_link_invites where id = (v_stash ->> 'seatInserted')::uuid;
  elsif (v_stash ->> 'clientSeatExisted')::boolean is true then
    null; -- the client's own seat existed and was only re-pointed; restored below with the others
  end if;
  update public.account_link_invites set inviter_user_id = v_move.from_user_id
    where id in (select (jsonb_array_elements_text(v_stash -> 'seatsReinvited'))::uuid);
  insert into public.account_link_invites
    select (jsonb_populate_record(null::public.account_link_invites, s)).*
    from jsonb_array_elements(v_stash -> 'seatsBefore') as s
    where (s ->> 'id')::uuid in (select (jsonb_array_elements_text(v_stash -> 'seatsDeleted'))::uuid)
    on conflict (id) do nothing;
  if (v_stash ->> 'clientSeatExisted')::boolean is true then
    update public.account_link_invites l set is_owner_of_record = (s ->> 'is_owner_of_record')::boolean, is_service_seat = (s ->> 'is_service_seat')::boolean
      from jsonb_array_elements(v_stash -> 'seatsBefore') as s where l.id = (s ->> 'id')::uuid;
  end if;

  -- work identity
  update public.manager_sms_numbers set manager_user_id = v_move.from_user_id, updated_at = now()
    where id in (select (jsonb_array_elements_text(v_stash -> 'numbers'))::uuid) and manager_user_id = v_move.to_user_id;
  update public.manager_assistant_emails set manager_user_id = v_move.from_user_id
    where id in (select (jsonb_array_elements_text(v_stash -> 'emails'))::uuid) and manager_user_id = v_move.to_user_id;
  update public.manager_assistant_email_aliases set owner_user_id = v_move.from_user_id
    where mailbox_local in (select jsonb_array_elements_text(v_stash -> 'aliases')) and owner_user_id = v_move.to_user_id;
  insert into public.workspace_work_numbers
    select (jsonb_populate_record(null::public.workspace_work_numbers, h)).* from jsonb_array_elements(v_stash -> 'holds') as h
    on conflict do nothing;
  if (v_stash ->> 'clearedProfileLine') is not null then
    update public.profiles set sms_from_number = v_stash ->> 'clearedProfileLine', updated_at = now()
      where id = v_move.from_user_id and sms_from_number is null;
  end if;

  update public.managed_workspace_ownership_moves set undone_at = now() where id = v_move.id;
  perform set_config('app.workspace_ownership_transfer', 'off', true);
  return jsonb_build_object('status', 'undone', 'workspace', p_workspace, 'restoredRows', v_restored);
end;
$$;
revoke all on function public.undo_managed_workspace_move(uuid) from public, anon, authenticated;
grant execute on function public.undo_managed_workspace_move(uuid) to service_role;
