-- Portal Communication message attachments (manager / resident / vendor inbox
-- images). Paths are `<uploader_user_id>/<timestamp>-<uuid>.<ext>`.
-- Default-deny (no client policy): uploaders, conversation participants, and
-- admins reach bytes only via `/api/portal/inbox-attachments`, which
-- re-authorizes every request with the service-role client — same shape as
-- `bug-feedback-attachments` and `application-documents`.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'portal-inbox-attachments',
  'portal-inbox-attachments',
  false,
  5242880, -- 5 MB — matches MAX_BYTES in the upload route
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "portal_inbox_attachments_no_client_access" on storage.objects;
