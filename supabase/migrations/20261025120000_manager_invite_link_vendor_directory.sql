-- Vendor links: the manager's own vendor directory row a link claims on redemption
-- (null = a generic link, which creates a row). Checked against the link owner at mint and redeem.
alter table public.manager_invite_links
  add column if not exists vendor_directory_id text;
