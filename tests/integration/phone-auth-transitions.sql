-- Run only against emstjswhotsnyksqhqyf after W5 migrations. Every fixture and
-- the shared-mode switch are transaction-local and rolled back. No SMS sent.
begin;
set local statement_timeout = '30s';
update public.sms_runtime_config set line_mode = 'shared', shared_number_e164 = '+12025550190' where singleton;
do $$
declare u uuid := gen_random_uuid(); other_u uuid := gen_random_uuid();
  c uuid; old_c uuid; new_c uuid; superseded uuid; operation uuid := gen_random_uuid();
  test_phone text := '+12025550191'; next_phone text := '+12025550192';
  browser text := 'w5-transaction-browser'; initial_user uuid := gen_random_uuid();
begin
  insert into auth.users(id,email,aud,role) values(u, u::text || '@phone-test.invalid','authenticated','authenticated'),
    (other_u, other_u::text || '@phone-test.invalid','authenticated','authenticated');
  insert into public.profiles(id,role) values(u,'resident'),(other_u,'resident');
  if has_function_privilege('authenticated','public.phone_auth_bind(uuid,uuid,text,uuid,uuid)','EXECUTE') then raise exception 'Public bind grant'; end if;
  if has_table_privilege('authenticated','public.phone_auth_operation_locks','SELECT') then raise exception 'Public lease grant'; end if;

  c := gen_random_uuid();
  if not public.phone_auth_start(c,test_phone,'2025550191','sign_in',u,browser,'good','local') then raise exception 'Start'; end if;
  if public.phone_auth_consume(c,u,'other-browser','good') is not null then raise exception 'Browser isolation'; end if;
  if public.phone_auth_consume(c,other_u,browser,'good') is not null then raise exception 'Actor isolation'; end if;
  for i in 1..5 loop
    if public.phone_auth_consume(c,u,browser,'wrong') is not null then raise exception 'Wrong accepted'; end if;
  end loop;
  if public.phone_auth_consume(c,u,browser,'good') is not null then raise exception 'Attempt limit'; end if;
  c := gen_random_uuid();
  perform public.phone_auth_start(c,test_phone,'2025550191','sign_in',u,browser,'good','local');
  update public.phone_otp_challenges set expires_at = now() - interval '1 second' where id = c;
  if public.phone_auth_consume(c,u,browser,'good') is not null then raise exception 'Expiry'; end if;
  c := gen_random_uuid();
  perform public.phone_auth_start(c,test_phone,'2025550191','sign_in',u,browser,'good','local');
  if public.phone_auth_start(gen_random_uuid(),test_phone,'2025550191','change_number_old',u,browser,'good','local') then raise exception 'Three sends per hour'; end if;
  if public.phone_auth_consume(c,u,browser,'good') is null then raise exception 'Correct rejected'; end if;
  if public.phone_auth_consume(c,u,browser,'good') is not null then raise exception 'Proof replay'; end if;
  if public.phone_auth_bind(c,u,browser,null,operation) then raise exception 'Missing operation lease'; end if;
  if not public.phone_auth_claim_operation(operation,test_phone,u) then raise exception 'Lease'; end if;
  if public.phone_auth_claim_operation(gen_random_uuid(),test_phone,u) then raise exception 'Concurrent lease'; end if;
  if not public.phone_auth_bind(c,u,browser,null,operation) then raise exception 'Bind'; end if;
  if public.phone_auth_bind(c,u,browser,null,operation) then raise exception 'Bind replay'; end if;
  if not exists(select 1 from public.sms_phone_contacts where phone_e164=test_phone and user_id=u) then raise exception 'Contact attach'; end if;
  if not exists(select 1 from auth.users a where a.id=u and a.phone=ltrim(test_phone,'+') and a.phone_confirmed_at is not null) then raise exception 'Auth bind not atomic'; end if;
  if not exists(select 1 from auth.identities where user_id=u and provider='phone' and identity_data->>'phone'=ltrim(test_phone,'+')) then raise exception 'Phone identity'; end if;
  perform public.phone_auth_release_operation(operation);

  -- The row can be consumed because a newer request superseded it; that is
  -- never proof of control of the old number.
  update public.phone_otp_challenges set created_at=now()-interval '2 hours' where phone_key='2025550191';
  superseded := gen_random_uuid(); old_c := gen_random_uuid(); new_c := gen_random_uuid();
  perform public.phone_auth_start(superseded,test_phone,'2025550191','change_number_old',u,browser,'old','local');
  perform public.phone_auth_start(old_c,test_phone,'2025550191','change_number_old',u,browser,'old','local');
  perform public.phone_auth_start(new_c,next_phone,'2025550192','change_number_new',u,browser,'new','local');
  perform public.phone_auth_consume(new_c,u,browser,'new');
  perform public.phone_auth_claim_operation(operation,next_phone,u);
  if public.phone_auth_bind(new_c,u,browser,null,operation) then raise exception 'Missing old proof accepted'; end if;
  if public.phone_auth_bind(new_c,u,browser,superseded,operation) then raise exception 'Superseded old proof accepted'; end if;
  if public.phone_auth_consume(old_c,u,browser,'old') is null then raise exception 'Old code'; end if;
  if not public.phone_auth_bind(new_c,u,browser,old_c,operation) then raise exception 'Both codes'; end if;
  if exists(select 1 from public.sms_phone_contacts where phone_e164=test_phone and user_id=u) then raise exception 'Old contact still owned'; end if;
  if (select a.phone from auth.users a where a.id=u) <> ltrim(next_phone,'+') then raise exception 'Auth change'; end if;
  perform public.phone_auth_release_operation(operation);

  -- Another signed-in account proving this phone cannot attach it.
  c := gen_random_uuid();
  perform public.phone_auth_start(c,next_phone,'2025550192','sign_in',other_u,browser,'good','local');
  perform public.phone_auth_consume(c,other_u,browser,'good');
  perform public.phone_auth_claim_operation(operation,next_phone,other_u);
  if public.phone_auth_bind(c,other_u,browser,null,operation) then raise exception 'Taken phone accepted'; end if;
  perform public.phone_auth_release_operation(operation);

  -- Signed provider retries must claim an app reservation once; unrelated
  -- local challenges and invalidated native challenges are not send permits.
  c := gen_random_uuid();
  perform public.phone_auth_start(c,'+12025550195','2025550195','sign_in',null,browser,'native','supabase');
  if not public.phone_auth_claim_hook_delivery('+12025550195') then raise exception 'Native hook claim'; end if;
  if public.phone_auth_claim_hook_delivery('+12025550195') then raise exception 'Hook replay'; end if;
  c := gen_random_uuid();
  perform public.phone_auth_start(c,'+12025550195','2025550195','sign_in',null,browser,'native','supabase');
  update public.phone_otp_challenges set expires_at=now()-interval '1 second' where id=c;
  if public.phone_auth_claim_hook_delivery('+12025550195') then raise exception 'Expired hook permit'; end if;

  -- GoTrue's admin-create confirmation uses UPDATE after INSERT. Its trusted
  -- phone-only marker is insufficient without the post-code operation lease.
  insert into auth.users(id,email,aud,role,phone,raw_app_meta_data)
    values(initial_user,initial_user::text || '@phone-test.invalid','authenticated','authenticated','12025550196','{"phone_only":true}'::jsonb);
  begin
    update auth.users set phone_confirmed_at=now() where id=initial_user;
    raise exception 'Initial confirmation without lease' using errcode='ZX003';
  exception when sqlstate 'ZX003' then raise; when others then null; end;
  perform public.phone_auth_claim_operation(operation,'+12025550196',null);
  update auth.users set phone_confirmed_at=now() where id=initial_user;
  if not exists(select 1 from auth.users a where a.id=initial_user and a.phone_confirmed_at is not null) then raise exception 'Trusted initial confirmation'; end if;
  perform public.phone_auth_release_operation(operation);

  begin
    update public.profiles set phone='+12025550193', phone_verified_at=null where id=u;
    raise exception 'Profile bypass accepted' using errcode='ZX001';
  exception when sqlstate 'ZX001' then raise; when others then null; end;
  begin
    update auth.users set phone='12025550193', phone_confirmed_at=now() where id=u;
    raise exception 'Auth bypass accepted' using errcode='ZX002';
  exception when sqlstate 'ZX002' then raise; when others then null; end;
end $$;
rollback;
select 'W5 phone transition checks passed; all fixtures rolled back' as result;
