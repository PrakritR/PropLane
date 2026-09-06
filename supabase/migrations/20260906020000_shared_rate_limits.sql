-- One atomic bucket across Vercel instances. Only the server service role may
-- consume capacity; browser roles cannot exhaust another user's bucket by RPC.
create table if not exists public.rate_limit_buckets (
  bucket_key text primary key check (bucket_key ~ '^[a-f0-9]{64}$'),
  request_count integer not null check (request_count > 0),
  reset_at timestamptz not null
);
create index if not exists rate_limit_buckets_reset_at_idx on public.rate_limit_buckets (reset_at);
alter table public.rate_limit_buckets enable row level security;
revoke all on public.rate_limit_buckets from public, anon, authenticated;
grant select, insert, update, delete on public.rate_limit_buckets to service_role;

create or replace function public.consume_rate_limit(p_bucket_key text, p_limit integer, p_window_ms integer)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_allowed boolean;
begin
  if p_bucket_key is null or p_bucket_key !~ '^[a-f0-9]{64}$' or
     p_limit is null or p_limit < 1 or p_limit > 100000 or
     p_window_ms is null or p_window_ms < 1 or p_window_ms > 86400000 then
    raise exception 'Invalid rate limit configuration';
  end if;

  insert into public.rate_limit_buckets as b (bucket_key, request_count, reset_at)
  values (p_bucket_key, 1, v_now + p_window_ms * interval '1 millisecond')
  on conflict (bucket_key) do update
  set request_count = case when b.reset_at <= v_now then 1 else b.request_count + 1 end,
      reset_at = case when b.reset_at <= v_now
        then v_now + p_window_ms * interval '1 millisecond' else b.reset_at end
  where b.reset_at <= v_now or b.request_count < p_limit
  returning true into v_allowed;

  -- Bounded opportunistic cleanup, independent of a paid scheduler. About 1/16
  -- of pseudonymous bucket keys clean up at most 100 already-expired rows,
  -- enough capacity to keep pace with continually arriving distinct buckets.
  -- Idle installations retain old pseudonymous rows until traffic resumes.
  if left(p_bucket_key, 1) = '0' then
    delete from public.rate_limit_buckets where bucket_key in (
      select bucket_key from public.rate_limit_buckets
      where reset_at < v_now - interval '1 day'
      order by reset_at limit 100 for update skip locked
    );
  end if;
  return coalesce(v_allowed, false);
end;
$$;
revoke all on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;
