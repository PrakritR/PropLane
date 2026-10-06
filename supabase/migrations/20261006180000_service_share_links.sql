-- Vendor work share (vendor-work-share-1006): hashed-token links to ONE service, texted to a
-- vendor's phone and opened at the public /s/<token> page.
--
-- Additive and idempotent: one new table, indexes, and an RLS lock. Nothing existing is altered.
-- The token itself is never stored - only its SHA-256 (`token_hash`) - so a leaked table or backup
-- cannot mint a working link. The table is service-role only, like portal_record_share_links:
-- public reads go through a Next.js route that re-derives everything.

create table if not exists public.service_share_links (
  id uuid primary key default gen_random_uuid(),
  work_order_id text not null,
  manager_user_id uuid not null,
  created_by uuid,
  token_hash text not null,
  recipient_phone text not null,
  recipient_name text,
  share_photos boolean not null default false,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  access_count integer not null default 0,
  last_accessed_at timestamptz,
  texted_at timestamptz,
  redeemed_by_user_id uuid,
  redeemed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists service_share_links_token_hash_idx
  on public.service_share_links (token_hash);

create index if not exists service_share_links_work_order_idx
  on public.service_share_links (work_order_id);

create index if not exists service_share_links_manager_idx
  on public.service_share_links (manager_user_id);

alter table public.service_share_links enable row level security;

revoke all on table public.service_share_links from anon, authenticated;
grant all on table public.service_share_links to service_role;

-- The vendor work board reads "published" services by this jsonb flag
-- (row_data->>'published' = 'true'). A partial expression index keeps that list cheap without
-- touching the table's shape.
create index if not exists portal_work_order_records_published_idx
  on public.portal_work_order_records ((row_data->>'publishRef'))
  where (row_data->>'published') = 'true';

-- Rollback (trialed on a scratch Postgres, both directions, applied twice to prove idempotence):
--   drop index if exists public.portal_work_order_records_published_idx;
--   drop table if exists public.service_share_links;
