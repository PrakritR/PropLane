-- WS4(shared-avail): a DB-level guard so exactly ONE manager wins a given
-- pending tour request. `confirmTourInquiry` does a non-atomic read-modify-write
-- on the shared JSON singletons `axis_admin_partner_inquiries_v1` /
-- `axis_admin_planned_events_v1`, so two co-managers approving the SAME pending
-- request concurrently could both pass their (stale) double-book check and both
-- upsert — last writer wins, silently dropping the other manager's booking even
-- though both callers were told "ok: true".
--
-- The primary key below is the guard: two concurrent INSERTs for the same
-- `inquiry_id` can only ever leave one row behind, so exactly one caller's
-- insert succeeds and the other gets a 23505 unique-violation — mapped to a
-- clean 409 in `confirmTourInquiry`. The row is deleted again once that confirm
-- attempt finishes (success or failure), so it is a short-lived mutex, not a
-- permanent record — nothing downstream reads this table.
create table if not exists public.tour_inquiry_claims (
  inquiry_id text primary key,
  claimed_by uuid not null,
  claimed_at timestamptz not null default now()
);

comment on table public.tour_inquiry_claims is
  'Short-lived mutex: one row per pending tour inquiry currently being confirmed. Deleted when the confirm attempt finishes. See confirmTourInquiry (tour-inquiry-confirm.server.ts).';

-- The PostgREST surface is public (anon/authenticated reach every table with
-- SELECT/INSERT/DELETE privileges via RLS row predicates), so this claims
-- table is service-role only, same posture as the other server-owned RPCs in
-- this migration set. No client role gets any grant on it.
alter table public.tour_inquiry_claims enable row level security;
revoke all on table public.tour_inquiry_claims from public, anon, authenticated;
grant select, insert, delete on table public.tour_inquiry_claims to service_role;
