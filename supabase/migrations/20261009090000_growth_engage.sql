-- Growth engine Phase 3: engage list. The engine never follows, likes, DMs or posts for the admin;
-- it builds a daily list of threads/accounts with a drafted comment and the admin acts by hand.
-- Same access model as growth_engine: RLS on, no policies, client roles revoked, service role only.

create table if not exists public.growth_watchlist (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('instagram','tiktok','linkedin','youtube','x','reddit','facebook')),
  handle text not null,
  url text,
  topic text,
  kind text not null default 'engage' check (kind in ('engage','follow','collab')),
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, handle)
);

create table if not exists public.growth_engage_items (
  id uuid primary key default gen_random_uuid(),
  for_date date not null,
  source text not null check (source in ('reddit','watchlist','manual')),
  platform text not null,
  target text not null,
  url text not null,
  why text,
  draft text,
  status text not null default 'open' check (status in ('open','done','skipped')),
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists growth_engage_items_date_status_idx on public.growth_engage_items(for_date, status);
create unique index if not exists growth_engage_items_date_url_idx on public.growth_engage_items(for_date, url);

create table if not exists public.growth_keywords (
  id uuid primary key default gen_random_uuid(),
  keyword text not null unique,
  reply text,
  link text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['growth_watchlist','growth_engage_items'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.growth_touch_updated_at()', t || '_touch', t);
  end loop;
  foreach t in array array['growth_watchlist','growth_engage_items','growth_keywords'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
