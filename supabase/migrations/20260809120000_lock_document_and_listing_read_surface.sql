-- Security: close two client-reachable surfaces on the PostgREST-exposed
-- `public` schema (`supabase/config.toml`), both found by the full-project
-- review at 0dce6a8f.
--
-- Same root cause as 20260722123000_lock_role_grant_surface.sql: an RLS policy
-- constrains *which row* you may touch, never *which column or value*. A
-- `WITH CHECK` on an owner predicate is satisfied by an attacker naming
-- themselves, and a `USING` predicate with no column restriction hands back
-- every column of every matching row.
--
-- Every statement here is idempotent. Supabase records migrations under
-- APPLY-TIME versions rather than repo filenames, so this file's recorded
-- version will not match its name and a later `supabase db push --include-all`
-- may replay it.

-- ── manager_documents ───────────────────────────────────────────────────────
-- `manager_documents_owner` was FOR ALL with `WITH CHECK (manager_user_id =
-- auth.uid())`. That constrains only the owner column, so any authenticated
-- user could INSERT a row naming THEMSELVES as owner while pointing
-- `storage_path` at another manager's object.
--
-- The row then passes the download route's ownership check — it really is
-- their row — and `createManagerDocumentSignedUrl` signs the planted path with
-- the SERVICE-ROLE client, which bypasses the `manager_documents_owner_objects`
-- storage policy that was supposed to stop exactly this. `share-link` escalates
-- it to an unauthenticated public URL.
--
-- The original migration's own comment already says "real access goes through
-- the service-role API routes": every writer of this table is a server route on
-- the service-role client (which bypasses RLS and these grants), so revoking
-- client DML removes nothing a legitimate caller uses. Reads stay owner-scoped
-- as defence in depth alongside the resident/vendor share policies added in
-- 20260711130000_manager_documents_sharing.sql.
DROP POLICY IF EXISTS manager_documents_owner ON public.manager_documents;

CREATE POLICY manager_documents_owner ON public.manager_documents
  FOR SELECT USING (manager_user_id = auth.uid());

REVOKE INSERT, UPDATE, DELETE ON public.manager_documents FROM anon, authenticated;

-- ── manager_property_records ────────────────────────────────────────────────
-- `manager_property_records_select_live` was `USING (status = 'live')` with no
-- column restriction and no role restriction, so ANY holder of the shipped
-- public anon key could read the raw `row_data` / `property_data` JSONB for
-- every live listing:
--
--   curl '<project>.supabase.co/rest/v1/manager_property_records
--         ?status=eq.live&select=*'  -H 'apikey: <public anon key>'
--
-- That blob is exactly what `publicListingProjection`
-- (src/lib/public-listings.server.ts) exists to filter. Its own source comment
-- records the history: "that is how the manager's wifi password, their
-- resident-only house notes, and the URL of their uploaded lease template ended
-- up on an unauthenticated endpoint." The projection guards the API route while
-- the table sat open beside it. It also disclosed `manager_user_id` for every
-- manager in the product, which is the input the planted-path attack above
-- needs.
--
-- Both anonymous readers — `getPublicListings()` and
-- `/api/public/property-lead` — already go through the service-role client, as
-- does every other reader of this table (all 20 call sites are server routes),
-- so this policy has no legitimate consumer. `manager_property_records_select_own`
-- is kept so a signed-in manager can still read their own rows directly.
DROP POLICY IF EXISTS "manager_property_records_select_live" ON public.manager_property_records;
