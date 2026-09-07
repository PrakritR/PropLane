-- Shareable RESIDENT invite links, for migrating an existing portfolio onto
-- PropLane.
--
-- WHY THIS IS NOT THE ACCOUNT-SETUP LINK. The resident setup token
-- (`/auth/resident-setup?token=…`) is a claim capability: whoever holds it
-- becomes that resident. `api/auth/resident-setup-link` therefore never returns
-- it to a browser — it leaves only by email, to the address on the application.
-- A manager who wants a link to paste into a building group chat cannot be
-- given that one. So this is a different object: it carries a PROPERTY, not a
-- person, and binds nobody until the manager says so.
--
-- WHY A CLAIM AND NOT A GRANT. A paste-able link is held by whoever it reaches.
-- Redeeming one therefore grants NOTHING: it records that some signed-in
-- account says it lives at one of the link's properties, and a manager approves
-- or dismisses it. That is also why the claim is never auto-matched to a
-- resident row by email — matching an untrusted self-asserted address against
-- `resident_email` is exactly the drift this codebase has shipped bugs from,
-- and here it would hand a stranger someone else's tenancy. The manager picks.
--
-- Idempotent throughout, per AGENTS.md: Supabase records migrations under
-- apply-time versions rather than repo filenames, so this gets replayed.

-- 1. The links table already exists; a resident link is a third kind on it, so
--    the use budget, expiry, revocation and one-time-token machinery are shared
--    rather than reimplemented. Only the CHECK has to widen.
alter table public.manager_invite_links
  drop constraint if exists manager_invite_links_kind_check,
  add constraint manager_invite_links_kind_check check (kind in ('manager', 'vendor', 'resident'));

-- A resident link may narrow to a single room. Null = the whole property, which
-- is the normal case for a building-wide link.
alter table public.manager_invite_links
  add column if not exists assigned_room_id text;

comment on column public.manager_invite_links.assigned_room_id is
  'Optional room the resident link narrows to. Null = any room in the assigned property. A bound on what the claim may say, never an authorization.';

-- 2. Where a redeemed resident link lands.
--
-- Deliberately NOT `account_link_invites`: that table means one relationship,
-- co-manager, and its `tab_kind` CHECK says so. A resident claim is a different
-- object with a different lifecycle, and widening that CHECK would have made a
-- resident link capable of producing manager access.
create table if not exists public.resident_invite_claims (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.manager_invite_links(id) on delete cascade,
  -- Denormalized so a manager can list claims without joining through a link
  -- they may have since revoked. Set from the LINK's owner at redeem time,
  -- never from the claimant's request body.
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  claimant_user_id uuid not null references auth.users(id) on delete cascade,
  -- The claimant's own verified account email, copied at redeem time. This is
  -- what the manager reads; it is never matched against an existing resident
  -- row automatically.
  claimant_email text not null,
  claimant_name text,
  -- What the claimant says about where they live. Self-asserted, and shown to
  -- the manager as an assertion rather than acted on.
  property_id text,
  room_id text,
  note text,
  status text not null default 'pending',
  -- Set only when a manager approves and names the resident record it belongs
  -- to. Absent on every pending claim.
  linked_application_id text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.resident_invite_claims
  drop constraint if exists resident_invite_claims_status_check,
  add constraint resident_invite_claims_status_check
    check (status in ('pending', 'approved', 'rejected'));

-- Re-opening a link you already claimed shows you the claim you already have,
-- rather than filing a second one or spending another use.
create unique index if not exists resident_invite_claims_unique_idx
  on public.resident_invite_claims (link_id, claimant_user_id);

create index if not exists resident_invite_claims_owner_idx
  on public.resident_invite_claims (owner_user_id, status, created_at desc);

-- 3. Service-role only, exactly like the links table it hangs off.
--
-- PostgREST exposes the `public` schema, so any privilege `anon` or
-- `authenticated` holds here is reachable from a browser console with the
-- shipped anon key. RLS on with NO policy denies the client roles outright
-- rather than depending on a policy being written correctly, and the grants are
-- revoked as well so a future `for all` policy cannot quietly re-open it.
alter table public.resident_invite_claims enable row level security;
revoke all on public.resident_invite_claims from anon, authenticated;

comment on table public.resident_invite_claims is
  'A signed-in account asserting it lives at a property, via a shareable resident invite link. Grants nothing: a manager approves it onto a resident record. Service-role only.';
comment on column public.resident_invite_claims.claimant_email is
  'The claimant own account email, copied at redeem time. Shown to the manager as an assertion; never auto-matched against manager_application_records.resident_email.';
comment on column public.resident_invite_claims.linked_application_id is
  'The resident record a manager attached this claim to on approval. Null while pending — a claim carries no tenancy of its own.';
