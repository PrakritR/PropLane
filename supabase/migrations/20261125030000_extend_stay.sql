-- Extensions are operational amendments; the executed document and its evidence stay byte-identical.
create table if not exists public.lease_stay_extensions (
  id text primary key,
  lease_id text not null references public.portal_lease_pipeline_records(id) on delete cascade,
  manager_user_id uuid not null,
  resident_user_id uuid,
  resident_email text not null,
  actor_user_id uuid,
  row_data jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists lease_stay_extensions_owner on public.lease_stay_extensions(manager_user_id, lease_id);
alter table public.lease_stay_extensions enable row level security;
revoke all on public.lease_stay_extensions from anon, authenticated;
grant all on public.lease_stay_extensions to service_role;

-- Make a preview's property revision cover channel/calendar changes too. A no-op read/sync
-- does not bump the revision. Taking the same property lock serializes with placement writes.
create or replace function public.bump_stay_availability_revision()
returns trigger language plpgsql security definer set search_path = '' as $$
declare house text;
begin
  if tg_op = 'UPDATE' then
    if tg_table_name = 'external_calendar_connections' then
      if (to_jsonb(new)->'imported_ranges', new.property_id, to_jsonb(new)->'room_id')
        is not distinct from (to_jsonb(old)->'imported_ranges', old.property_id, to_jsonb(old)->'room_id') then return new; end if;
    elsif (to_jsonb(new)->'row_data', new.property_id, to_jsonb(new)->'record_type')
      is not distinct from (to_jsonb(old)->'row_data', old.property_id, to_jsonb(old)->'record_type') then return new; end if;
  end if;
  house := case when tg_op = 'DELETE' then old.property_id else new.property_id end;
  if house is not null then
    update public.manager_property_records set occupancy_revision = occupancy_revision + 1 where id = house;
  end if;
  if tg_op = 'UPDATE' and old.property_id is distinct from new.property_id then
    update public.manager_property_records set occupancy_revision = occupancy_revision + 1 where id = old.property_id;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists stay_calendar_revision on public.portal_schedule_records;
create trigger stay_calendar_revision before insert or update or delete on public.portal_schedule_records
for each row execute function public.bump_stay_availability_revision();
drop trigger if exists stay_channel_revision on public.external_calendar_connections;
create trigger stay_channel_revision before insert or update or delete on public.external_calendar_connections
for each row execute function public.bump_stay_availability_revision();
revoke all on function public.bump_stay_availability_revision() from public, anon, authenticated;

create or replace function public.commit_stay_extension(
  p_owner uuid, p_actor uuid, p_property text, p_revision bigint,
  p_application_id text, p_expected_application jsonb, p_lease_id text, p_expected_lease jsonb,
  p_extension jsonb, p_expected_charges jsonb, p_charges jsonb
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare l public.portal_lease_pipeline_records%rowtype; a public.manager_application_records%rowtype;
  saved jsonb; existing_charges jsonb; charge jsonb; ending date; previous_end date; resident text;
begin
  select row_data into saved from public.lease_stay_extensions
    where id = p_extension->>'id' and manager_user_id = p_owner and lease_id = p_lease_id;
  if found then return saved; end if;
  perform 1 from public.manager_property_records where id = p_property and manager_user_id = p_owner
    and occupancy_revision = p_revision for update;
  if not found then raise exception using errcode='40001', message='Availability changed. Review the extension again.'; end if;
  -- Re-check after the lock: simultaneous retries return the one immutable result.
  select row_data into saved from public.lease_stay_extensions where id = p_extension->>'id' and manager_user_id=p_owner and lease_id=p_lease_id;
  if found then return saved; end if;
  select * into l from public.portal_lease_pipeline_records where id=p_lease_id and manager_user_id=p_owner for update;
  if not found or l.row_data is distinct from p_expected_lease or l.property_id is distinct from p_property then
    raise exception using errcode='40001', message='Lease changed. Review the extension again.';
  end if;
  select * into a from public.manager_application_records where id=p_application_id and manager_user_id=p_owner for update;
  if not found or a.row_data is distinct from p_expected_application or a.row_data->>'bucket' is distinct from 'approved'
    or public.room_placement_property(a.row_data) is distinct from p_property
    or public.room_placement_application_key(l.row_data->>'axisId') is distinct from public.room_placement_application_key(a.id) then
    raise exception using errcode='40001', message='Resident changed. Review the extension again.';
  end if;
  ending := (p_extension->>'newEnd')::date;
  previous_end := (p_extension->>'previousEnd')::date;
  if ending is null or previous_end is null or ending <= previous_end or p_extension->>'leaseId' is distinct from p_lease_id then
    raise exception 'Invalid extension dates.';
  end if;
  resident := lower(l.resident_email);
  perform 1 from public.portal_household_charge_records where manager_user_id=p_owner and property_id=p_property and lower(resident_email)=resident order by id for update;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'row_data',row_data) order by id), '[]'::jsonb) into existing_charges
    from public.portal_household_charge_records where manager_user_id=p_owner and property_id=p_property and lower(resident_email)=resident;
  if existing_charges is distinct from p_expected_charges then raise exception using errcode='40001', message='Charges changed. Review the extension again.'; end if;
  -- The existing capacity trigger refuses any concurrent approved placement, atomically.
  update public.manager_application_records set row_data=jsonb_set(jsonb_set(a.row_data,
    '{application}', coalesce(a.row_data->'application','{}'::jsonb)||jsonb_build_object('leaseEnd',ending::text)),
    '{manualResidentDetails}', coalesce(a.row_data->'manualResidentDetails','{}'::jsonb)||jsonb_build_object('moveOutDate',ending::text)), updated_at=now() where id=a.id;
  -- Only operational date metadata changes. No status, body, PDF, hash or signature assignment.
  update public.portal_lease_pipeline_records set row_data=jsonb_set(l.row_data,
    '{application}', coalesce(l.row_data->'application','{}'::jsonb)||jsonb_build_object('leaseEnd',ending::text)),updated_at=now() where id=l.id;
  for charge in select value from jsonb_array_elements(p_charges) loop
    if charge->>'managerUserId' is distinct from p_owner::text or charge->>'propertyId' is distinct from p_property
      or lower(charge->>'residentEmail') is distinct from resident or charge->>'status' is distinct from 'pending'
      or charge->>'kind' not in ('rent','prorated_rent','utilities','other_cost','stay_total')
      or charge#>>'{stayExtension,extensionId}' is distinct from p_extension->>'id' then raise exception 'Invalid extension charge.'; end if;
    insert into public.portal_household_charge_records(id,manager_user_id,resident_user_id,resident_email,property_id,kind,status,row_data,updated_at)
      values(charge->>'id',p_owner,nullif(charge->>'residentUserId','')::uuid,resident,p_property,charge->>'kind','pending',charge,now());
  end loop;
  update public.portal_recurring_rent_profile_records set row_data=row_data||jsonb_build_object('leaseEnd',ending::text,'updatedAt',now()),updated_at=now()
    where manager_user_id=p_owner and property_id=p_property and lower(resident_email)=resident and active;
  insert into public.lease_stay_extensions(id,lease_id,manager_user_id,resident_user_id,resident_email,actor_user_id,row_data)
    values(p_extension->>'id',p_lease_id,p_owner,nullif(l.row_data->>'residentUserId','')::uuid,resident,p_actor,p_extension);
  return p_extension;
end $$;
revoke all on function public.commit_stay_extension(uuid,uuid,text,bigint,text,jsonb,text,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.commit_stay_extension(uuid,uuid,text,bigint,text,jsonb,text,jsonb,jsonb,jsonb,jsonb) to service_role;
