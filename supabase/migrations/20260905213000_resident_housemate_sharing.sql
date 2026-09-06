create table if not exists public.resident_housemate_sharing (
  user_id uuid primary key references auth.users(id) on delete cascade,
  preferences jsonb not null default '{"shareName":false,"shareRoom":false,"shareEmail":false,"sharePhone":false}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint resident_housemate_sharing_object check (jsonb_typeof(preferences) = 'object')
);
alter table public.resident_housemate_sharing enable row level security;
revoke all on public.resident_housemate_sharing from anon, authenticated;
grant all on public.resident_housemate_sharing to service_role;
comment on table public.resident_housemate_sharing is 'Resident-owned opt-in sharing; service routes pin user_id to authenticated context and redact non-consented fields before returning housemates.';
