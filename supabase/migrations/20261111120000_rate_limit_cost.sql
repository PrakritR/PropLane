-- All-or-nothing multi-token consume on the SAME bucket `consume_rate_limit` uses.
-- A caller that needs several tokens at once (one per new typed address in a send)
-- must not spend the tokens it was granted when a later one is refused: without
-- this, a refused request still ate the day's remaining budget. Additive: the
-- three-argument function keeps its own signature, so nothing deployed changes
-- behaviour and there is no overload ambiguity.
create or replace function public.consume_rate_limit_cost(
  p_bucket_key text, p_limit integer, p_window_ms integer, p_cost integer
)
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
     p_window_ms is null or p_window_ms < 1 or p_window_ms > 86400000 or
     p_cost is null or p_cost < 1 then
    raise exception 'Invalid rate limit configuration';
  end if;

  -- A request asking for more than the whole window's budget can never be served,
  -- and must never be stored as an over-limit bucket.
  if p_cost > p_limit then
    return false;
  end if;

  insert into public.rate_limit_buckets as b (bucket_key, request_count, reset_at)
  values (p_bucket_key, p_cost, v_now + p_window_ms * interval '1 millisecond')
  on conflict (bucket_key) do update
  set request_count = case when b.reset_at <= v_now then p_cost else b.request_count + p_cost end,
      reset_at = case when b.reset_at <= v_now
        then v_now + p_window_ms * interval '1 millisecond' else b.reset_at end
  where b.reset_at <= v_now or b.request_count + p_cost <= p_limit
  returning true into v_allowed;

  -- Same bounded opportunistic cleanup as `consume_rate_limit`, on the same table.
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
revoke all on function public.consume_rate_limit_cost(text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit_cost(text, integer, integer, integer) to service_role;
