-- Production catalog review found inherited platform-default grants beyond RLS.
-- These account tables keep their existing owner-scoped browser SELECT access.
-- TRUNCATE and REFERENCES are not protected by row-level security.
revoke truncate, references, trigger on table
  public.profiles,
  public.profile_roles
from anon, authenticated, public;

-- Application records, co-signer identity and automation/OAuth settings are
-- accessed through permission-scoped server routes using service_role. Their
-- RLS is already enabled with no browser policies. Remove redundant table
-- privileges as a second boundary, including any grants inherited from PUBLIC.
-- REVOKE is idempotent; service_role grants and all data/policies are unchanged.
revoke all privileges on table
  public.manager_application_records,
  public.cosigner_submission_records,
  public.manager_automation_settings
from anon, authenticated, public;
