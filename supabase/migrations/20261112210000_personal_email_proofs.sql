-- Email proof for a phone-only account made from a personal account link (design-1112 §5).
-- Not a Supabase token_hash link: with secure email change on, an email_change needs a token sent to the account's
-- OLD address, which for a phone-only account is a non-deliverable placeholder. PropLane mints its own single-use proof:
-- only the SHA-256 of the token is stored, bound to one user and one email, expiring in 24 hours.
-- Additive and idempotent. Service role only: RLS on, no client grants.
create table if not exists public.personal_email_proofs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  email text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists personal_email_proofs_user_idx on public.personal_email_proofs (user_id);
alter table public.personal_email_proofs enable row level security;
revoke all on public.personal_email_proofs from anon, authenticated;
