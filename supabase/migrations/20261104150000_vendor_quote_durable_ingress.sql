-- Quote proof is sealed transport metadata, never provider params or consent authority.
alter table public.sms_ingress_envelopes
 add column if not exists quote_capsule jsonb,
 add column if not exists quote_capsule_expires_at timestamptz;
alter table public.sms_ingress_envelopes drop constraint if exists sms_ingress_quote_capsule_shape;
alter table public.sms_ingress_envelopes add constraint sms_ingress_quote_capsule_shape check (
 (quote_capsule is null and quote_capsule_expires_at is null) or
 coalesce((quote_capsule is not null and quote_capsule_expires_at is not null
  and jsonb_typeof(quote_capsule) = 'object' and octet_length(quote_capsule::text) <= 1024
  and quote_capsule->>'version' = '1'
  and coalesce(quote_capsule->>'nonce','') ~ '^[a-f0-9]{24}$'
  and coalesce(quote_capsule->>'ciphertext','') ~ '^[a-f0-9]{24}$'
  and coalesce(quote_capsule->>'tag','') ~ '^[a-f0-9]{32}$'
  and jsonb_typeof(quote_capsule->'issuedAt') = 'number'
  and jsonb_typeof(quote_capsule->'expiresAt') = 'number'
  and (quote_capsule->>'issuedAt')::numeric > 0
  and (quote_capsule->>'expiresAt')::numeric > (quote_capsule->>'issuedAt')::numeric
  and (quote_capsule->>'expiresAt')::numeric - (quote_capsule->>'issuedAt')::numeric <= 600000
  and extract(epoch from quote_capsule_expires_at)*1000 = (quote_capsule->>'expiresAt')::numeric
  and quote_capsule_expires_at <= received_at + interval '10 minutes'
  and params->>'Body' = 'QUOTE [redacted]' and params->>'PropLaneRedacted' = '1'),false)
);
create index if not exists sms_ingress_quote_capsule_expiry on public.sms_ingress_envelopes(quote_capsule_expires_at)
 where quote_capsule is not null;

-- Preserve the account/runtime, lease, horizon, backoff and three-attempt claim fences.
create or replace function public.sms_ingress_claim(p_id uuid, p_token uuid, p_runtime text, p_account text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare e public.sms_ingress_envelopes;
begin
 update sms_ingress_envelopes set status='executing', attempts=attempts+1, lease_token=p_token, lease_until=now()+interval '120 seconds', updated_at=now()
 where id=p_id and runtime=p_runtime and account_sid=p_account and status='accepted' and expires_at>now() and next_attempt_at<=now() and attempts<3 returning * into e;
 if not found then return null; end if;
 return jsonb_build_object('id',e.id,'params',e.params,'attempts',e.attempts,'checkpoint_stage',e.checkpoint_stage,'control_keyword',e.control_keyword,'delegated_sid',e.delegated_sid,
  'message_sid',e.message_sid,'wire_from',e.wire_from,'wire_to',e.wire_to,'payload_digest',e.payload_digest,'runtime',e.runtime,'account_sid',e.account_sid,
  'quote_capsule',e.quote_capsule,'quote_capsule_expires_at',e.quote_capsule_expires_at);
end $$;
revoke all on function public.sms_ingress_claim(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.sms_ingress_claim(uuid,uuid,text,text) to service_role;

create or replace function public.sms_ingress_clear_quote_capsule(p_id uuid,p_token uuid,p_runtime text,p_account text) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update public.sms_ingress_envelopes set quote_capsule=null,quote_capsule_expires_at=null,updated_at=now()
 where id=p_id and runtime=p_runtime and account_sid=p_account and status='executing' and lease_token=p_token and lease_until>now() and expires_at>now();
 return found;
end $$;
revoke all on function public.sms_ingress_clear_quote_capsule(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.sms_ingress_clear_quote_capsule(uuid,uuid,text,text) to service_role;

-- Terminal states erase ciphertext atomically, including delegated reconciliation.
create or replace function public.sms_ingress_erase_terminal_quote_capsule() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
 if new.status in ('completed','expired') then new.quote_capsule:=null; new.quote_capsule_expires_at:=null; end if;
 return new;
end $$;
revoke all on function public.sms_ingress_erase_terminal_quote_capsule() from public,anon,authenticated,service_role;
drop trigger if exists sms_ingress_erase_terminal_quote_capsule on public.sms_ingress_envelopes;
create trigger sms_ingress_erase_terminal_quote_capsule before insert or update on public.sms_ingress_envelopes
 for each row execute function public.sms_ingress_erase_terminal_quote_capsule();

-- Bounded maintenance includes needs_review but never changes its status.
create or replace function public.sms_ingress_purge_expired_quote_capsules(p_runtime text,p_account text) returns bigint
language plpgsql security definer set search_path=public,pg_temp as $$
declare n bigint;
begin
 with expired as (
  select id from public.sms_ingress_envelopes where runtime=p_runtime and account_sid=p_account
   and quote_capsule_expires_at<=now() order by quote_capsule_expires_at limit 1000 for update skip locked
 ) update public.sms_ingress_envelopes e set quote_capsule=null,quote_capsule_expires_at=null,updated_at=now()
 from expired where e.id=expired.id;
 get diagnostics n = row_count; return n;
end $$;
revoke all on function public.sms_ingress_purge_expired_quote_capsules(text,text) from public,anon,authenticated;
grant execute on function public.sms_ingress_purge_expired_quote_capsules(text,text) to service_role;
