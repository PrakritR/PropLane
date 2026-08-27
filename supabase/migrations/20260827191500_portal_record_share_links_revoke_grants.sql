-- portal_record_share_links is service-role only; public reads go through Next.js routes.

REVOKE ALL ON TABLE portal_record_share_links FROM anon, authenticated;
