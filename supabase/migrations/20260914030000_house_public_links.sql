-- One opaque public token per property, behind the QR on a house's door card
-- and rules poster. The page it opens shows house rules and trash days only —
-- nothing from manager_property_access or the private house_info sections.
-- Service-role only: public reads resolve through the Next.js /h/[token] route.

create table if not exists public.manager_house_public_links (
  id uuid primary key default gen_random_uuid(),
  property_id text not null,
  manager_user_id uuid not null,
  token text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create unique index if not exists manager_house_public_links_token_idx
  on public.manager_house_public_links (token);

-- At most ONE live link per property: a reprint must carry the same QR as the
-- poster already on the wall, whatever the read before the insert saw.
create unique index if not exists manager_house_public_links_active_idx
  on public.manager_house_public_links (manager_user_id, property_id)
  where revoked_at is null;

alter table public.manager_house_public_links enable row level security;

revoke all on table public.manager_house_public_links from anon, authenticated;
