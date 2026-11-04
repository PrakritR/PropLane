-- The private quote conversation is shared by response-page and native email ingress.
create or replace function public.append_vendor_quote_inbox(
 p_capability_id uuid,p_source_message_id text,p_body text,p_channel text,p_stamp text
) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.vendor_quote_contact_capabilities%rowtype; t public.portal_inbox_thread_records%rowtype; thread_id text; label text; contact_name text; owner_email text; message jsonb; messages jsonb;
begin
 select * into c from public.vendor_quote_contact_capabilities where id=p_capability_id;
 if not found or nullif(trim(p_source_message_id),'') is null or p_channel not in ('email','portal') or length(p_body)>6000 then raise exception 'quote conversation unavailable'; end if;
 thread_id:='vendor_quote_'||c.work_order_id||'_'||c.vendor_directory_id;
 perform pg_advisory_xact_lock(hashtextextended('vendor-quote-inbox:'||thread_id,0));
 select coalesce(row_data->>'reference',id) into label from public.portal_work_order_records where id=c.work_order_id and manager_user_id=c.manager_user_id;
 select coalesce(row_data->>'name','Vendor') into contact_name from public.manager_vendor_records where id=c.vendor_directory_id and manager_user_id=c.manager_user_id;
 select email into owner_email from public.profiles where id=c.manager_user_id;
 if label is null or contact_name is null or owner_email is null then raise exception 'quote conversation unavailable'; end if;
 select * into t from public.portal_inbox_thread_records where id=thread_id for update;
 messages:=coalesce(t.row_data->'messages','[]'::jsonb);
 if exists(select 1 from jsonb_array_elements(messages) m where m->>'id'=p_source_message_id) then return; end if;
 message:=jsonb_build_object('id',p_source_message_id,'from',contact_name||case when p_channel='email' then ' (email)' else '' end,'body',p_body,'at',p_stamp,'outbound',false,'channel',p_channel);
 insert into public.portal_inbox_thread_records(id,scope,owner_user_id,participant_email,thread_type,row_data,updated_at)
 values(thread_id,'axis_portal_inbox_manager_v1',c.manager_user_id,owner_email,'portal_message',
 coalesce(t.row_data,'{}'::jsonb)||jsonb_build_object('id',thread_id,'folder','inbox','from',contact_name,'email',c.recipient_email,'subject','Service quote - '||label,'preview',left(p_body,100),'time',p_stamp,'unread',true,'messages',messages||jsonb_build_array(message),'propertyId',(select property_id from public.portal_work_order_records where id=c.work_order_id),'recordRef',jsonb_build_object('kind','service','id',c.work_order_id,'label',label),'quoteCapabilityId',c.id),now())
 on conflict(id) do update set row_data=excluded.row_data,thread_type=excluded.thread_type,updated_at=excluded.updated_at;
 -- Manager/person conversation is distinct from the vendor-owned agent inbox.
end $$;
revoke all on function public.append_vendor_quote_inbox(uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.append_vendor_quote_inbox(uuid,text,text,text,text) to service_role;
