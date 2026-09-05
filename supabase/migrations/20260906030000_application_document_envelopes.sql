-- Preserve the 15 MB plaintext limit plus at most 4 KB of encryption framing.
-- Signed uploads carry encrypted binary bytes. The bucket remains PRIVATE and
-- existing default-deny Storage policies are unchanged. Apply before new code.
update storage.buckets
set public = false,
    file_size_limit = 15732736,
    allowed_mime_types = array[
      'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
      'application/pdf', 'application/octet-stream'
    ]
where id = 'application-documents';
