-- Growth engine (PropLane's own social content pipeline). Admin-only; see docs/agents/growth-engine.md.
-- All access is through admin-gated routes and crons using the service role. RLS is ON with NO
-- policies and the client roles hold no privileges (the PostgREST surface is public).

create or replace function public.growth_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.growth_ideas (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  angle text not null check (angle in ('positioning','feature','tips','local','founder')),
  format text not null check (format in ('reel','carousel','image','text')),
  notes text,
  weight numeric not null default 1 check (weight >= 0),
  source text not null default 'seed' check (source in ('seed','learned','manual')),
  used_count integer not null default 0 check (used_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.growth_posts (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid references public.growth_ideas(id) on delete set null,
  status text not null default 'idea' check (status in
    ('idea','drafted','review','approved','scheduled','publishing','published','failed','archived')),
  format text not null check (format in ('reel','carousel','image','text')),
  title text not null,
  hook text,
  script text,
  scenes jsonb not null default '[]'::jsonb,
  captions jsonb not null default '{}'::jsonb,
  platforms text[] not null default '{}',
  scheduled_for timestamptz,
  approved_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  published_at timestamptz,
  created_by text not null default 'claude' check (created_by in ('claude','admin')),
  review_note text,
  learned_from text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists growth_posts_status_scheduled_idx on public.growth_posts(status, scheduled_for);

create table if not exists public.growth_assets (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.growth_posts(id) on delete cascade,
  kind text not null check (kind in ('image','video','voice','clip','shot')),
  storage_path text not null,
  public_url text not null,
  width integer,
  height integer,
  duration_ms integer,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists growth_assets_post_idx on public.growth_assets(post_id);

create table if not exists public.growth_accounts (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('instagram','tiktok','youtube','linkedin','x','threads','facebook')),
  handle text not null,
  publisher text not null default 'log' check (publisher in ('log','late','upload_post','meta')),
  vendor_account_id text,
  status text not null default 'connected' check (status in ('connected','expiring','disconnected','paused')),
  token_expires_at timestamptz,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists growth_accounts_platform_idx on public.growth_accounts(platform);

create table if not exists public.growth_publications (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.growth_posts(id) on delete cascade,
  platform text not null check (platform in ('instagram','tiktok','youtube','linkedin','x','threads','facebook')),
  account_id uuid references public.growth_accounts(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','published','failed','paused')),
  publisher text not null default 'log' check (publisher in ('log','late','upload_post','meta')),
  vendor_post_id text,
  platform_post_id text,
  platform_url text,
  error text,
  attempts integer not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (post_id, platform)
);
create index if not exists growth_publications_status_idx on public.growth_publications(status);

create table if not exists public.growth_metrics (
  id uuid primary key default gen_random_uuid(),
  publication_id uuid not null references public.growth_publications(id) on delete cascade,
  captured_at timestamptz not null default now(),
  views integer,
  likes integer,
  comments integer,
  shares integer,
  saves integer,
  followers_snapshot integer,
  raw jsonb not null default '{}'::jsonb
);
create index if not exists growth_metrics_publication_idx on public.growth_metrics(publication_id, captured_at desc);

create table if not exists public.growth_learned (
  id uuid primary key default gen_random_uuid(),
  line text not null,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['growth_ideas','growth_posts','growth_accounts','growth_publications'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.growth_touch_updated_at()', t || '_touch', t);
  end loop;
  foreach t in array array['growth_ideas','growth_posts','growth_assets','growth_accounts','growth_publications','growth_metrics','growth_learned'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- Public bucket: published media must be fetchable by the social platforms. Writes are service-role only
-- (no storage.objects policies are added for it).
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('growth', 'growth', true, 524288000,
  array['image/png','image/jpeg','image/webp','video/mp4','video/quicktime','audio/mpeg','audio/wav'])
on conflict(id) do nothing;
