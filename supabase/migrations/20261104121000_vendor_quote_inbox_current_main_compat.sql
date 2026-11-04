-- Keep service quote identity independent from the physical person conversation.
-- Historical migration bytes remain immutable; this replaces only the ingress RPC.
create or replace function public.append_vendor_quote_inbox(
 p_capability_id uuid,p_source_message_id text,p_body text,p_channel text,p_stamp text
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
 c public.vendor_quote_contact_capabilities%rowtype;
 t public.portal_inbox_thread_records%rowtype;
 logical_id text; storage_id text; alias_target text;
 service_label text; contact_name text; owner_email text;
 service_property text; service_workspace uuid;
 message jsonb; messages jsonb; service_ref jsonb; source_hint jsonb; hints jsonb; next_data jsonb;
 existing_thread boolean;
begin
 select * into c from public.vendor_quote_contact_capabilities where id=p_capability_id;
 if not found or nullif(trim(p_source_message_id),'') is null or p_body is null
   or p_channel not in ('email','portal') or length(p_body)>6000 then
   raise exception 'quote conversation unavailable';
 end if;
 logical_id:='vendor_quote_'||c.work_order_id||'_'||c.vendor_directory_id;
 perform pg_advisory_xact_lock(hashtextextended('vendor-quote-inbox:'||logical_id,0));
 select coalesce(w.row_data->>'reference',w.id),coalesce(nullif(w.assigned_property_id,''),nullif(w.property_id,''),nullif(w.row_data->>'propertyId','')),p.workspace_id
 into service_label,service_property,service_workspace
 from public.portal_work_order_records w join public.manager_property_records p
   on p.id=coalesce(nullif(w.assigned_property_id,''),nullif(w.property_id,''),nullif(w.row_data->>'propertyId','')) and p.manager_user_id=w.manager_user_id
 where w.id=c.work_order_id and w.manager_user_id=c.manager_user_id;
 select coalesce(row_data->>'name','Vendor') into contact_name from public.manager_vendor_records
 where id=c.vendor_directory_id and manager_user_id=c.manager_user_id;
 select email into owner_email from public.profiles where id=c.manager_user_id;
 if service_label is null or service_workspace is null or contact_name is null or owner_email is null
   or nullif(trim(c.recipient_email),'') is null then raise exception 'quote conversation unavailable'; end if;
 select a.thread_id into alias_target from public.portal_inbox_thread_aliases a
 where a.alias_id=logical_id for share;
 storage_id:=coalesce(alias_target,logical_id);
 select * into t from public.portal_inbox_thread_records where id=storage_id for update;
 existing_thread:=found;
 -- A concurrent fold publishes its alias before deleting the physical source.
 -- Recheck after observing a missing source, never recreate an absorbed row.
 if not existing_thread and alias_target is null then
   select a.thread_id into alias_target from public.portal_inbox_thread_aliases a
   where a.alias_id=logical_id for share;
   if alias_target is not null then
     storage_id:=alias_target;
     select * into t from public.portal_inbox_thread_records where id=storage_id for update;
     existing_thread:=found;
   end if;
 end if;
 if alias_target is not null and not existing_thread then raise exception 'quote conversation unavailable'; end if;
 if existing_thread and (t.scope is distinct from 'axis_portal_inbox_manager_v1'
   or t.owner_user_id is distinct from c.manager_user_id
   or lower(trim(coalesce(t.row_data->>'email',''))) is distinct from lower(trim(c.recipient_email))
   or (t.workspace_id is not null and t.workspace_id is distinct from service_workspace)) then
   raise exception 'quote conversation unavailable';
 end if;
 if alias_target is not null and t.workspace_id is null then
   if not exists(select 1 from public.manager_property_records p where p.manager_user_id=c.manager_user_id
     and p.id=coalesce(nullif(t.row_data->>'propertyId',''),t.row_data->>'rootHouseId')
     and p.workspace_id=service_workspace) then raise exception 'quote conversation unavailable'; end if;
 end if;
 service_ref:=jsonb_build_object('kind','service','id',c.work_order_id,'label',service_label);
 source_hint:=jsonb_build_object('threadId',logical_id,'recordRef',service_ref,'subject','Service quote - '||service_label);
 messages:=case when jsonb_typeof(t.row_data->'messages')='array' then t.row_data->'messages' else '[]'::jsonb end;
 if exists(select 1 from jsonb_array_elements(messages) m where m->>'id'=p_source_message_id) then return; end if;
 message:=jsonb_build_object('id',p_source_message_id,'from',contact_name||case when p_channel='email' then ' (email)' else '' end,
   'body',p_body,'at',p_stamp,'outbound',false,'channel',p_channel,
   'recordRef',service_ref,'houseId',service_property,'quoteCapabilityId',c.id);
 hints:=case when jsonb_typeof(t.row_data->'quoteReplySources')='array' then t.row_data->'quoteReplySources' else '[]'::jsonb end;
 select coalesce(jsonb_agg(h),'[]'::jsonb) into hints from jsonb_array_elements(hints) h where h->>'threadId' is distinct from logical_id;
 hints:=hints||jsonb_build_array(source_hint);
 if existing_thread then
   -- A canonical person's root, sender, subject, folder and first record remain theirs.
   next_data:=coalesce(t.row_data,'{}'::jsonb)||jsonb_build_object('preview',left(p_body,100),'time',p_stamp,
     'unread',true,'messages',messages||jsonb_build_array(message),'quoteReplySources',hints);
   if storage_id=logical_id then next_data:=next_data||jsonb_build_object('quoteCapabilityId',c.id); end if;
   update public.portal_inbox_thread_records set row_data=next_data,updated_at=now() where id=storage_id;
 else
   next_data:=jsonb_build_object('id',storage_id,'folder','inbox','from',contact_name,'email',c.recipient_email,
     'subject','Service quote - '||service_label,'preview',left(p_body,100),'time',p_stamp,'unread',true,
     'messages',jsonb_build_array(message),'propertyId',service_property,'recordRef',service_ref,
     'quoteCapabilityId',c.id,'quoteReplySources',hints);
   insert into public.portal_inbox_thread_records(id,scope,owner_user_id,participant_email,thread_type,workspace_id,row_data,updated_at)
   values(storage_id,'axis_portal_inbox_manager_v1',c.manager_user_id,owner_email,'portal_message',service_workspace,next_data,now());
 end if;
end $$;
revoke all on function public.append_vendor_quote_inbox(uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.append_vendor_quote_inbox(uuid,text,text,text,text) to service_role;
