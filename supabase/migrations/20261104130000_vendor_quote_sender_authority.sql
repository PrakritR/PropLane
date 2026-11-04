-- Canonical TypeScript sender authority, fenced against database policy changes and time transitions.
-- No number entitlement policy is reproduced in SQL. Only service callers may present a fresh proof.
create table if not exists public.vendor_quote_sender_authority_revision (
 singleton boolean primary key default true check(singleton),
 revision bigint not null default 1 check(revision>0)
);
insert into public.vendor_quote_sender_authority_revision(singleton) values(true) on conflict do nothing;
alter table public.vendor_quote_sender_authority_revision enable row level security;
revoke all on public.vendor_quote_sender_authority_revision from public,anon,authenticated,service_role;
grant select on public.vendor_quote_sender_authority_revision to service_role;

create or replace function public.invalidate_vendor_quote_sender_authority()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare before_values jsonb; after_values jsonb;
begin
 if tg_op='UPDATE' then
   select jsonb_object_agg(k,to_jsonb(old)#>string_to_array(k,'.')) into before_values from unnest(tg_argv) k;
   select jsonb_object_agg(k,to_jsonb(new)#>string_to_array(k,'.')) into after_values from unnest(tg_argv) k;
   if before_values is not distinct from after_values then return null; end if;
 end if;
 -- Row/source locks may already be held by an unrelated writer. Never wait here behind a proof's lifecycle lock.
 perform 1 from public.vendor_quote_sender_authority_revision where singleton for update nowait;
 update public.vendor_quote_sender_authority_revision set revision=revision+1 where singleton;
 if not found then raise exception 'sender authority revision missing'; end if;
 return null;
exception when lock_not_available then
 raise exception 'sender authority busy' using errcode='40001';
end $$;
revoke all on function public.invalidate_vendor_quote_sender_authority() from public,anon,authenticated,service_role;

-- Validate exact dependency columns rather than installing a silently incomplete fence.
do $$
declare dep record; dependency_column text; args text;
begin
 for dep in select * from (values
 ('public','sms_runtime_config',array['mode','pilot_manager_user_ids','line_mode','shared_number_e164','shared_messaging_service_sid','shared_pilot_workspace_ids']),
 ('public','manager_sms_numbers',array['id','manager_user_id','workspace_id','phone_number','phone_number_sid','messaging_service_sid','campaign_sid','provision_state','registration_state','registration_ref','released_at','provisioned_at','requested_at','attachment_state','number_registration_state','grace_started_at','grace_expires_at','quarantined_at','quarantine_reason']),
 ('public','workspace_work_numbers',array['workspace_id','number_id','is_primary']),
 ('public','portal_workspaces',array['id','owner_user_id','is_default','is_service']),
 ('public','platform_service_settings',array['owner_user_id','singleton']),
 ('public','manager_purchases',array['id','tier','billing','stripe_subscription_id','stripe_checkout_session_id','stripe_customer_id','promo_code','apple_original_transaction_id','paid_at','user_id','email','promo_ends_at']),
 ('public','number_subscriptions',array['owner_user_id','status']),
 ('public','manager_promo_code_policies',array['code','expires_at']),
 ('auth','users',array['id','email','email_confirmed_at']),
 ('public','vendor_outreach_workspace_profiles',array['manager_user_id','mode','version','managed_display_name','managed_legal_name','managed_email','managed_work_phone','managed_messaging_service_sid']),
 ('public','manager_assistant_emails',array['manager_user_id','workspace_id','inbox_token','mailbox_local','provision_state']),
 ('public','profiles',array['id','full_name']),
 ('public','portal_work_order_records',array['id','manager_user_id','assigned_property_id','property_id','row_data.propertyId']),
 ('public','manager_property_records',array['id','manager_user_id','workspace_id'])
 ) x(schema_name,table_name,columns) loop
   foreach dependency_column in array dep.columns loop
     if not exists(select 1 from information_schema.columns c where c.table_schema=dep.schema_name and c.table_name=dep.table_name and c.column_name=split_part(dependency_column,'.',1)) then
       raise exception 'sender authority dependency missing: %.%.%',dep.schema_name,dep.table_name,dependency_column;
     end if;
   end loop;
   select string_agg(quote_literal(k),',') into args from unnest(dep.columns) k;
   execute format('drop trigger if exists vendor_quote_sender_authority_changed on %I.%I',dep.schema_name,dep.table_name);
   execute format('create trigger vendor_quote_sender_authority_changed after insert or update or delete on %I.%I for each row execute function public.invalidate_vendor_quote_sender_authority(%s)',dep.schema_name,dep.table_name,args);
 end loop;
end $$;

create or replace function public.read_vendor_quote_sender_authority_revision()
returns table(revision text,evaluated_at timestamptz) language sql security definer set search_path=public,pg_temp as $$
 select r.revision::text,clock_timestamp() from public.vendor_quote_sender_authority_revision r where r.singleton;
$$;
revoke all on function public.read_vendor_quote_sender_authority_revision() from public,anon,authenticated;
grant execute on function public.read_vendor_quote_sender_authority_revision() to service_role;

-- Read only inside proof-bearing wrappers. The transaction-local value never survives connection reuse.
create or replace function public.vendor_quote_sender_is_current(p_capability_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.vendor_quote_contact_capabilities%rowtype; proof jsonb; snap jsonb; sender_key text;
begin
 proof:=nullif(current_setting('proplane.vendor_quote_sender_proof',true),'')::jsonb;
 if proof is null then return false; end if;
 select * into c from public.vendor_quote_contact_capabilities where id=p_capability_id;
 if not found then return false; end if;
 snap:=proof->'senderSnapshot';
 sender_key:=encode(sha256(convert_to(concat_ws('|',snap->>'managerUserId',snap->>'workspaceId',snap->>'mode',snap->>'version',
   lower(trim(snap->>'email')),snap->>'displayName',snap->>'legalName',coalesce(snap->>'workPhone',''),coalesce(snap->>'messagingServiceSid',''),
   coalesce(snap->>'transportKind',''),coalesce(snap->>'selectedLineId',''),coalesce(snap->>'providerMessagingServiceSid','')),'UTF8')),'hex');
 return proof->>'capabilityId'=c.id::text and snap=c.sender_snapshot and proof->>'senderKey'=sender_key
   and snap->>'managerUserId'=c.manager_user_id::text and snap->>'mode'=c.sender_mode and snap->>'version'=c.sender_version::text
   and proof->>'channel' in ('email','sms')
   and (proof->>'revision')::bigint=(select r.revision from public.vendor_quote_sender_authority_revision r where r.singleton)
   and (proof->>'evaluatedAt')::timestamptz<=clock_timestamp()
   and (proof->>'validUntil')::timestamptz<=((proof->>'evaluatedAt')::timestamptz+interval '5 seconds')
   and clock_timestamp()<(proof->>'validUntil')::timestamptz;
end $$;
revoke all on function public.vendor_quote_sender_is_current(uuid) from public,anon,authenticated,service_role;

create or replace function public.require_vendor_quote_sender_proof(p_proof jsonb,p_capability_id uuid,p_channel text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare current_revision bigint;
begin
 -- Lock before service/directory/consent locks. Writers changing policy cannot commit until consent commits.
 select r.revision into current_revision from public.vendor_quote_sender_authority_revision r where r.singleton for update nowait;
 if current_revision is null or p_proof is null or p_proof->>'channel' is distinct from p_channel
    or p_proof->>'revision' is distinct from current_revision::text then raise exception 'sender authority changed'; end if;
 perform set_config('proplane.vendor_quote_sender_proof',p_proof::text,true);
 if not coalesce(public.vendor_quote_sender_is_current(p_capability_id),false) then raise exception 'sender authority changed'; end if;
exception when lock_not_available then
 raise exception 'sender authority busy' using errcode='40001';
end $$;
revoke all on function public.require_vendor_quote_sender_proof(jsonb,uuid,text) from public,anon,authenticated,service_role;

create or replace function public.consume_vendor_quote_sms_challenge(
 p_challenge_id uuid,p_code_digest text,p_from_phone text,p_to_phone text,p_messaging_service_sid text,p_inbound_event_id text
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare ch public.vendor_quote_sms_consent_challenges%rowtype; c public.vendor_quote_contact_capabilities%rowtype; d public.manager_vendor_records%rowtype; v_contact jsonb; v_proposal public.vendor_coordination_proposals%rowtype; v_phone_key text; v_conversation text; v_latest_event text;
begin
 -- Match directory attachment and enrollment: directory before service, then row/consent locks.
 perform public.lock_vendor_directory((select vendor_directory_id from public.vendor_quote_sms_consent_challenges where id=p_challenge_id));
 perform public.lock_vendor_service((select cap.work_order_id from public.vendor_quote_sms_consent_challenges x join public.vendor_quote_contact_capabilities cap on cap.id=x.capability_id where x.id=p_challenge_id));
 select * into ch from public.vendor_quote_sms_consent_challenges where id=p_challenge_id for update;
 if ch.consumed_at is not null then return ch.inbound_event_id=p_inbound_event_id and ch.requested_phone=p_from_phone and ch.work_phone=p_to_phone; end if;
 if not found or ch.revoked_at is not null or ch.expires_at<=now() or ch.attempts>=5 then return false; end if;
 update public.vendor_quote_sms_consent_challenges set attempts=attempts+1 where id=ch.id;
 if ch.code_digest<>p_code_digest or ch.requested_phone<>p_from_phone or ch.work_phone<>p_to_phone or ch.messaging_service_sid<>p_messaging_service_sid or ch.inbound_event_id is not null then return false; end if;
 perform pg_advisory_xact_lock(hashtextextended('sms-consent-phone:'||ch.requested_phone,0));
 select * into c from public.vendor_quote_contact_capabilities where id=ch.capability_id and revoked_at is null and expires_at>now() for update;
 if not found or c.manager_user_id<>ch.manager_user_id or c.candidate_id<>ch.candidate_id or c.vendor_directory_id<>ch.vendor_directory_id or c.proposal_id<>ch.proposal_id then return false; end if;
 if c.consumed_at is not null or not public.vendor_quote_sender_is_current(c.id) then return false; end if;
 if coalesce((select i.mode from public.vendor_outreach_workspace_profiles i where i.manager_user_id=ch.manager_user_id),'software')<>c.sender_mode or coalesce((select i.version from public.vendor_outreach_workspace_profiles i where i.manager_user_id=ch.manager_user_id),1)<>ch.sender_version then return false; end if;
 if c.sender_mode='managed' and not exists(select 1 from public.vendor_outreach_workspace_profiles i where i.manager_user_id=ch.manager_user_id and i.managed_work_phone=ch.work_phone and i.managed_messaging_service_sid=ch.messaging_service_sid and i.managed_email=c.sender_snapshot->>'email') then return false; end if;
 if c.sender_snapshot->>'workPhone' is distinct from ch.work_phone or c.sender_snapshot->>'messagingServiceSid' is distinct from ch.messaging_service_sid then return false; end if;
 if not exists(select 1 from public.vendor_sourcing_jobs j where j.id=c.job_id and j.manager_user_id=ch.manager_user_id and j.work_order_id=c.work_order_id and j.state in ('queued','sourcing','waiting','quote_collected','needs_attention')) then return false; end if;
 if not exists(select 1 from public.vendor_sourcing_candidates x where x.id=ch.candidate_id and x.job_id=c.job_id and x.manager_user_id=ch.manager_user_id and x.local_directory_id=ch.vendor_directory_id and x.proposal_id=ch.proposal_id and x.expires_at>now()) then return false; end if;
 if not exists(select 1 from public.work_order_vendor_offers o where o.work_order_id=c.work_order_id and o.manager_user_id=ch.manager_user_id and o.vendor_directory_id=ch.vendor_directory_id and o.status='sent' and o.expires_at>now()) then return false; end if;
 select * into v_proposal from public.vendor_coordination_proposals p where p.id=ch.proposal_id and p.work_order_id=c.work_order_id and p.manager_user_id=ch.manager_user_id and p.vendor_directory_id=ch.vendor_directory_id for update;
 if not found or v_proposal.version<>ch.proposal_version or v_proposal.manager_takeover or v_proposal.accepted_bid_id is not null or v_proposal.status in ('approved','declined','cancelled') then return false; end if;
 if not exists(select 1 from public.portal_work_order_records w where w.id=c.work_order_id and w.manager_user_id=ch.manager_user_id and coalesce(w.row_data->>'bucket','')='open' and nullif(w.row_data->>'vendorId','') is null and w.row_data->>'selfAssigned' is distinct from 'true') then return false; end if;
 v_phone_key:=regexp_replace(ch.requested_phone,'[^0-9]','','g');
 if length(v_phone_key)=11 and left(v_phone_key,1)='1' then v_phone_key:=substring(v_phone_key from 2); end if;
 -- Synchronize with canonical STOP/START, which upserts sms_consent(phone).
 -- Both grants and controls now contend on the same row before reading state.
 insert into public.sms_consent(phone) values(v_phone_key) on conflict(phone) do nothing;
 perform 1 from public.sms_consent where phone=v_phone_key for update;
 if exists(select 1 from public.sms_consent s where s.phone=v_phone_key and s.opted_out_at is not null and (s.opted_in_at is null or s.opted_out_at>=s.opted_in_at)) then return false; end if;
 if exists(select 1 from public.profiles p where right(regexp_replace(coalesce(p.phone,''),'[^0-9]','','g'),length(v_phone_key))=v_phone_key and p.sms_opt_out_at is not null and (p.sms_consent_at is null or p.sms_opt_out_at>=p.sms_consent_at)) then return false; end if;
 v_conversation:=ch.manager_user_id::text||':vendor:'||coalesce((select d0.vendor_user_id::text from public.manager_vendor_records d0 where d0.id=ch.vendor_directory_id),ch.requested_phone);
 select event_type into v_latest_event from public.sms_consent_events e where e.recipient_phone_key=v_phone_key and e.manager_user_id=ch.manager_user_id and e.purpose='vendor_quote_request' and e.send_class='automated' and e.messaging_service_sid=ch.messaging_service_sid and e.conversation_key=v_conversation order by e.occurred_at desc,e.created_at desc limit 1;
 if v_latest_event='revoked' then return false; end if;
 select * into d from public.manager_vendor_records where id=ch.vendor_directory_id and manager_user_id=ch.manager_user_id for update;
 if not found or (d.vendor_user_id is not null and exists(select 1 from public.profiles p where p.id=d.vendor_user_id and p.phone_verified_at is not null and p.phone is distinct from ch.requested_phone)) then return false; end if;
 if exists(select 1 from public.vendor_coordination_phone_bindings b where b.manager_user_id=ch.manager_user_id and b.vendor_directory_id=ch.vendor_directory_id and b.revoked_at is null and b.phone_e164<>ch.requested_phone) then return false; end if;
  select sc.contact into v_contact from public.vendor_sourcing_candidates sc where sc.id=ch.candidate_id and sc.job_id=c.job_id and sc.manager_user_id=c.manager_user_id for update;
 if v_contact is null then return false; end if;
 -- clock_timestamp, not transaction now(): cross-boundary failures roll back even the provisional sms_consent row.
 if not coalesce(public.vendor_quote_sender_is_current(c.id),false) then raise exception 'sender authority changed'; end if;
 v_contact:=jsonb_set(v_contact,'{phone}',to_jsonb(ch.requested_phone),true);
 update public.vendor_sourcing_candidates sc set contact=v_contact,updated_at=now() where sc.id=ch.candidate_id;
 update public.manager_vendor_records set row_data=jsonb_set(row_data,'{phone}',to_jsonb(ch.requested_phone),true),updated_at=now() where id=ch.vendor_directory_id and manager_user_id=ch.manager_user_id;
 if not found then raise exception 'vendor identity unavailable'; end if;
 insert into public.vendor_coordination_phone_bindings(manager_user_id,vendor_directory_id,vendor_user_id,phone_e164,verified_at,revoked_at)
 values(ch.manager_user_id,ch.vendor_directory_id,d.vendor_user_id,ch.requested_phone,now(),null)
 on conflict(manager_user_id,vendor_directory_id) do update set vendor_user_id=excluded.vendor_user_id,phone_e164=excluded.phone_e164,verified_at=now(),revoked_at=null;
 insert into public.agent_sessions(landlord_id,user_id,kind,vendor_user_id,vendor_directory_id,work_order_id,vendor_phone_e164,status,updated_at)
 values(ch.manager_user_id,d.vendor_user_id,'vendor_work_order',d.vendor_user_id,ch.vendor_directory_id,c.work_order_id,ch.requested_phone,'active',now())
 on conflict(work_order_id,vendor_directory_id) do update set landlord_id=excluded.landlord_id,user_id=excluded.user_id,
   kind='vendor_work_order',vendor_user_id=excluded.vendor_user_id,vendor_phone_e164=excluded.vendor_phone_e164,status='active',updated_at=now();
 insert into public.vendor_quote_sms_consent_events(capability_id,challenge_id,manager_user_id,candidate_id,vendor_directory_id,proposal_id,phone_e164,work_phone,messaging_service_sid,wording_version,source_event_id)
 values(ch.capability_id,ch.id,ch.manager_user_id,ch.candidate_id,ch.vendor_directory_id,ch.proposal_id,ch.requested_phone,ch.work_phone,ch.messaging_service_sid,ch.wording_version,p_inbound_event_id);
 insert into public.sms_consent_events(recipient_phone_key,manager_user_id,messaging_service_sid,purpose,send_class,conversation_key,event_type,source,wording_version,evidence)
 values(v_phone_key,ch.manager_user_id,ch.messaging_service_sid,'vendor_quote_request','automated',v_conversation,'granted','verified_vendor_quote_inbound_challenge',ch.wording_version,jsonb_build_object('challengeId',ch.id,'candidateId',ch.candidate_id,'inboundEventId',p_inbound_event_id));
 update public.vendor_quote_sms_consent_challenges set consumed_at=now(),inbound_event_id=p_inbound_event_id where id=ch.id;
 update public.vendor_sourcing_jobs set state='queued',next_run_at=now(),lease_token=null,lease_until=null,updated_at=now() where id=c.job_id and state in ('waiting','needs_attention');
 return true;
end $$;

-- The historical response body shares the same directory/service fence. Preserve its lifecycle
-- and response semantics while correcting only the inherited inverted lock statements.
do $$
declare definition text;
 old_order text := E'  perform public.lock_vendor_service(c.work_order_id);\n  perform public.lock_vendor_directory(c.vendor_directory_id);';
 canonical_order text := E'  perform public.lock_vendor_directory(c.vendor_directory_id);\n  perform public.lock_vendor_service(c.work_order_id);';
begin
 select pg_get_functiondef('public.vendor_quote_submit_response(text,integer,jsonb)'::regprocedure) into definition;
 if strpos(definition,old_order)>0 then
   execute replace(definition,old_order,canonical_order);
 elsif strpos(definition,canonical_order)=0 then
   raise exception 'quote response lock-order prerequisite changed';
 end if;
end $$;

-- Old overloads are callable only as implementation details of their security-definer wrappers.
revoke all on function public.consume_vendor_quote_sms_challenge(uuid,text,text,text,text,text) from public,anon,authenticated,service_role;
revoke all on function public.vendor_quote_capability_action(text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.vendor_quote_submit_response(text,integer,jsonb) from public,anon,authenticated,service_role;

create or replace function public.vendor_quote_capability_action(p_session_digest text,p_action jsonb,p_sender_proof jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare capability uuid;
begin
 select capability_id into capability from public.vendor_quote_contact_sessions where session_digest=p_session_digest;
 perform public.require_vendor_quote_sender_proof(p_sender_proof,capability,'email');
 return public.vendor_quote_capability_action(p_session_digest,p_action);
end $$;
revoke all on function public.vendor_quote_capability_action(text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.vendor_quote_capability_action(text,jsonb,jsonb) to service_role;

create or replace function public.vendor_quote_submit_response(p_session_digest text,p_expected_version integer,p_response jsonb,p_sender_proof jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare capability uuid;
begin
 select capability_id into capability from public.vendor_quote_contact_sessions where session_digest=p_session_digest;
 perform public.require_vendor_quote_sender_proof(p_sender_proof,capability,'email');
 return public.vendor_quote_submit_response(p_session_digest,p_expected_version,p_response);
end $$;
revoke all on function public.vendor_quote_submit_response(text,integer,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.vendor_quote_submit_response(text,integer,jsonb,jsonb) to service_role;

create or replace function public.consume_vendor_quote_sms_challenge(
 p_challenge_id uuid,p_code_digest text,p_from_phone text,p_to_phone text,p_messaging_service_sid text,p_inbound_event_id text,p_sender_proof jsonb
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare ch public.vendor_quote_sms_consent_challenges%rowtype; c public.vendor_quote_contact_capabilities%rowtype;
 granted boolean; phone_key text; receipt public.sms_inbound_receipts%rowtype; vendor_id uuid; conversation text;
begin
 select * into ch from public.vendor_quote_sms_consent_challenges where id=p_challenge_id;
 if not found then return false; end if;
 if ch.consumed_at is not null then
   return ch.inbound_event_id=p_inbound_event_id and ch.requested_phone=p_from_phone and ch.work_phone=p_to_phone;
 end if;
 perform public.require_vendor_quote_sender_proof(p_sender_proof,ch.capability_id,'sms');
 if p_inbound_event_id !~ '^SM[a-zA-Z0-9]+$' then return false; end if;
 granted:=public.consume_vendor_quote_sms_challenge(p_challenge_id,p_code_digest,p_from_phone,p_to_phone,p_messaging_service_sid,p_inbound_event_id);
 if not granted then return false; end if;
 -- Grant and durable redacted originals commit together. The projection retry spine consumes this receipt/log pair.
 select * into c from public.vendor_quote_contact_capabilities where id=ch.capability_id;
 select vendor_user_id into vendor_id from public.manager_vendor_records where id=ch.vendor_directory_id and manager_user_id=ch.manager_user_id;
 phone_key:=regexp_replace(p_from_phone,'[^0-9]','','g');
 if length(phone_key)=11 and left(phone_key,1)='1' then phone_key:=substring(phone_key from 2); end if;
 conversation:=ch.manager_user_id::text||':vendor:'||coalesce(vendor_id::text,p_from_phone);
 insert into public.sms_inbound_receipts(message_sid,manager_user_id,recipient_phone_key,status,attempt_count,workspace_id,inbound_payload)
 values(p_inbound_event_id,ch.manager_user_id,phone_key,'processing',1,(c.sender_snapshot->>'workspaceId')::uuid,
   jsonb_build_object('signedTwilio',true,'fromPhone',p_from_phone,'toPhone',p_to_phone,'body','QUOTE [redacted]','workspaceId',c.sender_snapshot->>'workspaceId'))
 on conflict(message_sid) do nothing;
 select * into receipt from public.sms_inbound_receipts where message_sid=p_inbound_event_id for update;
 if receipt.manager_user_id is distinct from ch.manager_user_id or receipt.recipient_phone_key is distinct from phone_key then raise exception 'quote receipt conflict'; end if;
 if exists(select 1 from public.inbound_sms_log l where l.message_sid=p_inbound_event_id and
   (l.manager_user_id is distinct from ch.manager_user_id or l.from_phone is distinct from p_from_phone or l.to_phone is distinct from p_to_phone or l.body<>'QUOTE [redacted]')) then raise exception 'quote receipt conflict'; end if;
 insert into public.inbound_sms_log(manager_user_id,from_phone,to_phone,body,message_sid,created_at,workspace_id,counterparty_role,conversation_key,matched_sender_user_id)
 select ch.manager_user_id,p_from_phone,p_to_phone,'QUOTE [redacted]',p_inbound_event_id,receipt.first_received_at,(c.sender_snapshot->>'workspaceId')::uuid,'vendor',conversation,vendor_id
 where not exists(select 1 from public.inbound_sms_log where message_sid=p_inbound_event_id);
 update public.sms_inbound_receipts set status='completed',completed_at=clock_timestamp(),updated_at=clock_timestamp(),lease_owner=null,lease_expires_at=null where message_sid=p_inbound_event_id;
 return true;
end $$;
revoke all on function public.consume_vendor_quote_sms_challenge(uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.consume_vendor_quote_sms_challenge(uuid,text,text,text,text,text,jsonb) to service_role;
