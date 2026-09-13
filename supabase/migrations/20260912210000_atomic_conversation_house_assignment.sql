-- Service-only compare-and-replace. Permission normalization stays in the
-- shared TypeScript resolver; a revision binds its decision to the same data
-- used by this transaction, so concurrent revocation/transfer fails closed.
create or replace function public.conversation_house_access_revision(p_actor uuid)
returns text language sql stable security definer set search_path = public as $$
  with links as (
    select * from public.account_link_invites where invitee_user_id = p_actor
  ), owners as (
    select p_actor as id union select inviter_user_id from links
  )
  select md5(jsonb_build_array(
    coalesce((select jsonb_agg(to_jsonb(l) order by l.id) from links l), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_array(p.id, p.manager_user_id) order by p.id)
      from public.manager_property_records p where p.manager_user_id in (select id from owners)), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_array(p.id, p.email) order by p.id)
      from public.profiles p where p.id in (select id from owners)), '[]'::jsonb)
  )::text);
$$;
revoke all on function public.conversation_house_access_revision(uuid) from public, anon, authenticated;
grant execute on function public.conversation_house_access_revision(uuid) to service_role;

create or replace function public.replace_conversation_houses(
  p_owner uuid, p_actor uuid, p_key text, p_member_keys text[], p_next text[],
  p_expected_tags jsonb, p_access_revision text
) returns boolean language plpgsql security definer set search_path = public as $$
declare actual_tags jsonb;
begin
  -- These rare manual writes serialize against automatic tagging too. All
  -- deletes/inserts roll back together; a provider or UI retry cannot clear
  -- tags authorized against an older snapshot.
  lock table public.account_link_invites, public.manager_property_records, public.profiles in share mode;
  lock table public.manager_sms_conversation_houses in share row exclusive mode;
  if p_access_revision is distinct from public.conversation_house_access_revision(p_actor) then return false; end if;
  if p_owner is null or p_actor is null or p_key is null or btrim(p_key) = ''
    or p_member_keys is null or (p_key = any(p_member_keys)) is not true
    or p_next is null or cardinality(p_next) > 20
    or exists (select 1 from unnest(p_next) wanted(id) where wanted.id is null or btrim(wanted.id) = '')
  then return false; end if;
  if exists (select 1 from unnest(p_next) wanted(id) where not exists (
    select 1 from public.manager_property_records p where p.id = wanted.id and p.manager_user_id = p_owner
  )) then return false; end if;
  select coalesce(jsonb_agg(jsonb_build_object('conversation_key', conversation_key, 'property_id', property_id)
    order by conversation_key, property_id), '[]'::jsonb) into actual_tags
    from public.manager_sms_conversation_houses where manager_user_id = p_owner and conversation_key = any(p_member_keys);
  if actual_tags is distinct from p_expected_tags then return false; end if;
  delete from public.manager_sms_conversation_houses where manager_user_id = p_owner and conversation_key = any(p_member_keys);
  insert into public.manager_sms_conversation_houses(manager_user_id, conversation_key, property_id, source, tagged_by_user_id)
    select p_owner, p_key, id, 'manual', p_actor from unnest(p_next) id;
  return true;
end;
$$;
revoke all on function public.replace_conversation_houses(uuid, uuid, text, text[], text[], jsonb, text) from public, anon, authenticated;
grant execute on function public.replace_conversation_houses(uuid, uuid, text, text[], text[], jsonb, text) to service_role;
