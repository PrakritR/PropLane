-- Atomic 24h Messenger reply claim: one conditional upsert, so two concurrent
-- deliveries for the same (page, sender) cannot both win. Returns the claimed row,
-- or no row when a reply already went out inside the window.
create or replace function public.claim_meta_messenger_reply(
  p_page_id text,
  p_sender_psid text,
  p_listing_id text,
  p_manager_user_id uuid,
  p_workspace_id uuid,
  p_now timestamptz default now()
)
returns setof public.meta_messenger_replies
language sql
security definer
set search_path = public
as $$
  insert into public.meta_messenger_replies as r
    (page_id, sender_psid, replied_at, listing_id, manager_user_id, workspace_id)
  values (p_page_id, p_sender_psid, p_now, p_listing_id, p_manager_user_id, p_workspace_id)
  on conflict (page_id, sender_psid) do update
    set replied_at = excluded.replied_at,
        listing_id = excluded.listing_id
    where r.replied_at < p_now - interval '24 hours'
  returning r.*;
$$;

revoke all on function public.claim_meta_messenger_reply(text, text, text, uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_meta_messenger_reply(text, text, text, uuid, uuid, timestamptz) to service_role;
