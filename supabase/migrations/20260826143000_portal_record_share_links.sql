-- Tokenized public view links for a specific lease or application record.

CREATE TABLE IF NOT EXISTS portal_record_share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_kind text NOT NULL CHECK (record_kind IN ('lease', 'application')),
  record_id text NOT NULL,
  manager_user_id uuid NOT NULL,
  share_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  access_count integer NOT NULL DEFAULT 0,
  last_accessed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS portal_record_share_links_token_idx
  ON portal_record_share_links (share_token)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS portal_record_share_links_record_idx
  ON portal_record_share_links (record_kind, record_id);

ALTER TABLE portal_record_share_links ENABLE ROW LEVEL SECURITY;
