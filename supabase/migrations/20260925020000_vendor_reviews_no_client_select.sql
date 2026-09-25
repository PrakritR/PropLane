-- Security: RLS row predicates are not a column gate (AGENTS.md § "The
-- PostgREST surface is public"). vendor_reviews_vendor_read let a vendor
-- read manager_user_id and reviewer_user_id directly via PostgREST with the
-- public anon key, even though every application-level read already
-- redacts or omits those columns (the UI says "A PropLane manager" — the
-- API must not know better). No UI path ever queried this table with a
-- client-scoped Supabase client; both reads go through
-- /api/portal/vendor-reviews and /api/vendor/reviews, service-role only. An
-- RLS-enabled table with zero policies denies all direct client access,
-- which is exactly what this table needs.
drop policy if exists vendor_reviews_manager_read on public.vendor_reviews;
drop policy if exists vendor_reviews_vendor_read on public.vendor_reviews;
