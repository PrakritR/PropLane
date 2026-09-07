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
  -- 10 MB and application/pdf, because THIS ROW is the real gate: the bucket's own
  -- limits refuse an upload the route would have accepted, and the statement below
  -- re-applies them on every replay (`db push --include-all`). Left at the old
  -- image-only 5 MB, a replay silently un-ships PDF attachments — which is exactly
  -- how production came to reject them. Keep in step with `MAX_PDF_BYTES` and
  -- `ALLOWED_MIME` in src/lib/inbox-attachments*.
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "portal_inbox_attachments_no_client_access" on storage.objects;
