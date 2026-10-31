create or replace function public.account_recovery_finish_archival(p_request uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.account_recovery_requests; remaining text;
begin
  perform pg_advisory_xact_lock(723081447301::bigint);
  select * into a from public.account_recovery_requests where id=p_request for update;
  if a.state='retained' then return; end if;
  if not found or a.state<>'archiving' or not a.snapshot_complete then raise exception 'Retention request unavailable'; end if;
  if exists(select 1 from public.account_recovery_holds h join public.account_recovery_records r on r.id=h.record_id where h.request_id=a.id and h.kind='delete' and not r.archived) then raise exception 'Personal record cleanup incomplete'; end if;
  if exists(select 1 from public.account_recovery_holds h where h.request_id=a.id and h.kind in ('reference','business') and h.identity_patch is null) then raise exception 'Identity detachment incomplete'; end if;
  if exists(select 1 from public.account_recovery_object_holds h join public.account_recovery_objects o on o.id=h.object_id where h.request_id=a.id and o.state='copying') then raise exception 'File retention incomplete'; end if;
  perform set_config('proplane.account_recovery_internal','on',true);
  delete from public.profile_roles where user_id=a.user_id and (role=a.portal or (a.portal='manager' and role in ('manager','owner','pro')));
  select role into remaining from public.profile_roles where user_id=a.user_id order by role limit 1;
  if remaining is null then delete from public.profiles where id=a.user_id;
  else update public.profiles set role=remaining where id=a.user_id; end if;
  update auth.users set raw_user_meta_data=case when remaining is null then '{}'::jsonb else raw_user_meta_data-'role' end where id=a.user_id;
  with recursive revoked(id) as (
    select r.id from public.account_recovery_records r join public.account_recovery_holds h on h.record_id=r.id
      where h.request_id=a.id and r.archived and not r.recoverable
    union select d.child_id from public.account_recovery_dependencies d join revoked parent on parent.id=d.parent_id
  ) update public.account_recovery_records set erased=true,payload=null,row_key=null where id in(select id from revoked);
  update public.account_recovery_requests set state='retained' where id=a.id;
end $$;
revoke all on function public.account_recovery_finish_archival(uuid) from public, anon, authenticated;
grant execute on function public.account_recovery_finish_archival(uuid) to service_role;
