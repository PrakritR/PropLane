-- DEV ONLY: emstjswhotsnyksqhqyf, after 20261018180000 and 20261018180001.
-- This transaction rolls back every fixture, audit row, and rollout flag.
-- No provider call, token mint, or SMS is performed.
begin;
set local statement_timeout = '30s';
update public.sms_runtime_config set line_mode='shared', shared_number_e164='+12025550180' where singleton;
do $$
declare
  manager_id uuid := gen_random_uuid(); stranger_id uuid := gen_random_uuid();
  resident_id uuid := gen_random_uuid(); vendor_id uuid := gen_random_uuid();
  workspace_id uuid := gen_random_uuid(); other_workspace_id uuid := gen_random_uuid();
  property_id text := 'w5-reset-property-' || gen_random_uuid()::text;
  application_id text := 'w5-reset-application-' || gen_random_uuid()::text;
  roster_id text := 'w5-reset-vendor-' || gen_random_uuid()::text;
  service_id text := 'w5-reset-service-' || gen_random_uuid()::text;
  operation uuid := gen_random_uuid(); vendor_operation uuid := gen_random_uuid();
  old_proof uuid := gen_random_uuid(); new_proof uuid := gen_random_uuid(); anonymous_proof uuid := gen_random_uuid();
  resident_phone text := '+12025550181'; vendor_phone text := '+12025550182';
  browser text := 'w5-reset-browser'; auth_providers jsonb;
begin
  if has_function_privilege('authenticated','public.phone_auth_reset(uuid,uuid,uuid,text,uuid)','EXECUTE')
    or has_function_privilege('anon','public.phone_auth_reset(uuid,uuid,uuid,text,uuid)','EXECUTE') then
    raise exception 'Reset function publicly callable';
  end if;
  if cardinality(public.phone_auth_owners(resident_phone)) > 0 or cardinality(public.phone_auth_owners(vendor_phone)) > 0 then
    raise exception 'Reset fixture phone already belongs to a dev account';
  end if;
  perform set_config('proplane.phone_auth_binding','yes',true);
  insert into auth.users(id,email,aud,role,phone,phone_confirmed_at,raw_app_meta_data)
    values
      (manager_id,manager_id::text || '@phone-test.invalid','authenticated','authenticated','12025550183',now(),'{"provider":"email","providers":["email"]}'),
      (stranger_id,stranger_id::text || '@phone-test.invalid','authenticated','authenticated','12025550184',now(),'{"provider":"email","providers":["email"]}'),
      (resident_id,resident_id::text || '@phone-test.invalid','authenticated','authenticated',ltrim(resident_phone,'+'),now(),'{"provider":"phone","providers":["phone","email"]}'),
      (vendor_id,vendor_id::text || '@phone-test.invalid','authenticated','authenticated',ltrim(vendor_phone,'+'),now(),'{"provider":"email","providers":["email","phone"]}');
  insert into public.profiles(id,role,phone,phone_verified_at)
    values(manager_id,'manager','+12025550183',now()),(stranger_id,'manager','+12025550184',now()),
      (resident_id,'resident',resident_phone,now()),(vendor_id,'vendor',vendor_phone,now());
  insert into public.profile_roles(user_id,role)
    values(manager_id,'manager'),(stranger_id,'manager'),(resident_id,'resident'),(vendor_id,'vendor') on conflict do nothing;
  insert into auth.identities(id,provider_id,user_id,identity_data,provider)
    values(gen_random_uuid(),resident_id::text,resident_id,jsonb_build_object('sub',resident_id::text,'phone',ltrim(resident_phone,'+'),'phone_verified',true),'phone'),
      (gen_random_uuid(),resident_id::text,resident_id,jsonb_build_object('sub',resident_id::text,'email',resident_id::text || '@phone-test.invalid'),'email'),
      (gen_random_uuid(),vendor_id::text,vendor_id,jsonb_build_object('sub',vendor_id::text,'phone',ltrim(vendor_phone,'+'),'phone_verified',true),'phone'),
      (gen_random_uuid(),vendor_id::text,vendor_id,jsonb_build_object('sub',vendor_id::text,'email',vendor_id::text || '@phone-test.invalid'),'email');
  perform set_config('proplane.phone_auth_binding','',true);
  insert into public.sms_phone_contacts(phone_e164,phone_key,user_id)
    values(resident_phone,'2025550181',resident_id),(vendor_phone,'2025550182',vendor_id);
  insert into public.portal_workspaces(id,owner_user_id,name,is_default)
    values(workspace_id,manager_id,'W5 reset fixture',true),(other_workspace_id,manager_id,'W5 other fixture',false);
  insert into public.manager_property_records(id,manager_user_id,status,row_data,property_data,workspace_id)
    values(property_id,manager_id,'unlisted','{}','{}',workspace_id);
  insert into public.manager_application_records(id,manager_user_id,resident_email,property_id,row_data)
    values(application_id,manager_id,resident_id::text || '@phone-test.invalid',property_id,'{}');

  if not public.phone_auth_claim_operation(operation,resident_phone,resident_id) then raise exception 'Resident lease failed'; end if;
  if public.phone_auth_reset(manager_id,resident_id,workspace_id,resident_phone,operation) then raise exception 'Manager-typed application granted reset'; end if;
  insert into public.resident_workspace_bindings(resident_user_id,manager_user_id,application_id)
    values(resident_id,manager_id,application_id);
  if public.phone_auth_reset(manager_id,resident_id,other_workspace_id,resident_phone,operation) then raise exception 'Cross-workspace reset'; end if;
  if public.phone_auth_reset(stranger_id,resident_id,workspace_id,resident_phone,operation) then raise exception 'Non-owner reset'; end if;
  if public.phone_auth_reset(manager_id,manager_id,workspace_id,'+12025550183',operation) then raise exception 'Self reset'; end if;
  if public.phone_auth_reset(manager_id,resident_id,workspace_id,resident_phone,gen_random_uuid()) then raise exception 'Wrong lease reset'; end if;
  insert into public.profile_roles(user_id,role) values(resident_id,'manager');
  if public.phone_auth_reset(manager_id,resident_id,workspace_id,resident_phone,operation) then raise exception 'Protected role reset'; end if;
  delete from public.profile_roles where user_id=resident_id and role='manager';
  update public.sms_runtime_config set line_mode='per_workspace' where singleton;
  if public.phone_auth_reset(manager_id,resident_id,workspace_id,resident_phone,operation) then raise exception 'Legacy-mode reset'; end if;
  update public.sms_runtime_config set line_mode='shared' where singleton;

  -- An old/new proof pair that predates reset must never restore the old
  -- account's identity. Also invalidate anonymous codes sent to that number.
  perform public.phone_auth_start(old_proof,resident_phone,'2025550181','change_number_old',resident_id,browser,'old','local');
  perform public.phone_auth_consume(old_proof,resident_id,browser,'old');
  perform public.phone_auth_start(new_proof,'+12025550185','2025550185','change_number_new',resident_id,browser,'new','local');
  perform public.phone_auth_consume(new_proof,resident_id,browser,'new');
  perform public.phone_auth_start(anonymous_proof,resident_phone,'2025550181','sign_in',null,browser,'anonymous','local');
  if not public.phone_auth_reset(manager_id,resident_id,workspace_id,resident_phone,operation) then raise exception 'Authorized resident reset refused'; end if;
  if exists(select 1 from public.profiles where id=resident_id and (phone is not null or phone_verified_at is not null)) then raise exception 'Profile still verified'; end if;
  if exists(select 1 from auth.users where id=resident_id and (phone is not null or phone_confirmed_at is not null or phone_change <> '' or phone_change_token <> '' or phone_change_sent_at is not null)) then raise exception 'Auth phone still verified or pending'; end if;
  if exists(select 1 from auth.identities where user_id=resident_id and provider='phone') then raise exception 'Phone identity retained'; end if;
  if not exists(select 1 from auth.identities where user_id=resident_id and provider='email') then raise exception 'Email identity removed'; end if;
  select raw_app_meta_data into auth_providers from auth.users where id=resident_id;
  if auth_providers->>'provider' <> 'email' or auth_providers->'providers' <> '["email"]'::jsonb then raise exception 'Provider metadata stale'; end if;
  if exists(select 1 from public.sms_phone_contacts where user_id=resident_id) then raise exception 'Contact still attached'; end if;
  if (select count(*) from public.phone_otp_challenges where id in(old_proof,new_proof,anonymous_proof)
      and consumed_at is not null and completed_at is not null and verified_at is null) <> 3 then raise exception 'Reset proofs survived'; end if;
  if (select count(*) from public.audit_log where action='phone_auth_reset' and actor_user_id=manager_id
      and input_summary->>'targetUserId'=resident_id::text and input_summary->>'workspaceId'=workspace_id::text) <> 1 then raise exception 'Reset audit missing or duplicated'; end if;
  perform public.phone_auth_release_operation(operation);
  perform public.phone_auth_claim_operation(operation,'+12025550185',resident_id);
  if public.phone_auth_bind(new_proof,resident_id,browser,old_proof,operation) then raise exception 'Old proof resurrected account'; end if;
  perform public.phone_auth_release_operation(operation);

  -- A roster is manager-writable; it is insufficient without an accepted
  -- invite or a bid submitted by the target vendor in this workspace.
  insert into public.manager_vendor_records(id,manager_user_id,vendor_user_id,row_data)
    values(roster_id,manager_id,vendor_id,jsonb_build_object('active',true,'propertyIds',jsonb_build_array(property_id)));
  perform public.phone_auth_claim_operation(vendor_operation,vendor_phone,vendor_id);
  if public.phone_auth_reset(manager_id,vendor_id,workspace_id,vendor_phone,vendor_operation) then raise exception 'Roster alone granted reset'; end if;
  insert into public.vendor_invites(manager_user_id,vendor_directory_id,vendor_email,status,accepted_user_id,accepted_at)
    values(manager_id,roster_id,vendor_id::text || '@phone-test.invalid','accepted',vendor_id,now());
  if public.phone_auth_reset(manager_id,vendor_id,other_workspace_id,vendor_phone,vendor_operation) then raise exception 'Vendor cross-workspace reset'; end if;
  if not public.phone_auth_reset(manager_id,vendor_id,workspace_id,vendor_phone,vendor_operation) then raise exception 'Authorized vendor reset refused'; end if;
  if exists(select 1 from auth.identities where user_id=vendor_id and provider='phone')
    or exists(select 1 from public.sms_phone_contacts where user_id=vendor_id) then raise exception 'Vendor identity survived'; end if;
  if (select count(*) from public.audit_log where action='phone_auth_reset' and actor_user_id=manager_id) <> 2 then raise exception 'Refused attempts wrote audits'; end if;
  perform public.phone_auth_release_operation(vendor_operation);

  -- A vendor who joined by submitting a bid needs no invite. Re-establish the
  -- fixture through the real OTP bind transition, then use that second proof.
  new_proof := gen_random_uuid(); vendor_operation := gen_random_uuid();
  perform public.phone_auth_start(new_proof,vendor_phone,'2025550182','sign_in',vendor_id,browser,'vendor','local');
  perform public.phone_auth_consume(new_proof,vendor_id,browser,'vendor');
  perform public.phone_auth_claim_operation(vendor_operation,vendor_phone,vendor_id);
  if not public.phone_auth_bind(new_proof,vendor_id,browser,null,vendor_operation) then raise exception 'Vendor fixture rebind'; end if;
  delete from public.vendor_invites where vendor_directory_id=roster_id and accepted_user_id=vendor_id;
  insert into public.portal_work_order_records(id,manager_user_id,property_id,row_data)
    values(service_id,manager_id,property_id,'{}');
  insert into public.work_order_bids(work_order_id,vendor_user_id,vendor_directory_id,manager_user_id,amount_cents,proposed_time,status)
    values(service_id,vendor_id,roster_id,manager_id,10000,now()+interval '1 day','submitted');
  if not public.phone_auth_reset(manager_id,vendor_id,workspace_id,vendor_phone,vendor_operation) then raise exception 'Vendor submitted-bid reset refused'; end if;
  if (select count(*) from public.audit_log where action='phone_auth_reset' and actor_user_id=manager_id) <> 3 then raise exception 'Submitted-bid reset audit'; end if;
  perform public.phone_auth_release_operation(vendor_operation);
end $$;
rollback;
select 'W5 reset scope, consent, proof invalidation and audit checks passed; all fixtures rolled back' as result;
