-- Outbound webhooks — the push half of the public API. A manager registers an
-- HTTPS endpoint, PropLane POSTs an HMAC-signed, ID-and-status-only event to it.
--
-- Security posture, deliberately identical to `manager_api_keys`:
--   * RLS enabled with NO policies, plus an explicit DML revoke for
--     anon/authenticated. `public` is exposed through PostgREST, so a
--     browser-reachable write grant here would let anyone point a victim
--     manager's events at their own server, or read the signing secret.
--   * The signing secret is stored ENCRYPTED (`secret_ciphertext`, the
--     `proplane:v1:` envelope from src/lib/security/data-encryption.ts), never
--     in the clear and never as a bare hash: unlike an API key, PropLane has to
--     reproduce this value to sign every delivery, so a one-way digest cannot
--     work. The plaintext is returned exactly once, from the create/rotate
--     response body.
--   * `webhook_deliveries` is the attempt journal. `payload` carries ids and
--     statuses only (see src/lib/webhooks/events.ts) — no names, emails, phone
--     numbers or free text ever reach it.
--
-- Idempotent: re-running this file is a no-op.

create table if not exists public.webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  manager_user_id uuid not null references auth.users (id) on delete cascade,
  -- Validated as https:// on a public host at subscribe time AND again at
  -- delivery time (DNS can be re-pointed at 127.0.0.1 after a row is stored).
  url text not null,
  -- Allowlisted event types; an unknown type is rejected before it is stored.
  events text[] not null default array[]::text[],
  secret_ciphertext text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  disabled_at timestamptz,
  -- Consecutive failed deliveries. Reset to 0 by any success; the subscription
  -- is auto-disabled once it crosses the threshold in deliver.server.ts.
  failure_count integer not null default 0
);

create index if not exists webhook_subscriptions_manager_idx
  on public.webhook_subscriptions (manager_user_id, created_at desc);

create table if not exists public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.webhook_subscriptions (id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  attempt integer not null default 0,
  -- pending | delivered | failed | exhausted
  status text not null default 'pending',
  response_status integer,
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create index if not exists webhook_deliveries_due_idx
  on public.webhook_deliveries (status, next_attempt_at);
create index if not exists webhook_deliveries_subscription_idx
  on public.webhook_deliveries (subscription_id, created_at desc);

alter table public.webhook_subscriptions enable row level security;
alter table public.webhook_deliveries enable row level security;

-- No policies on purpose: PostgREST default-deny for anon/authenticated is the
-- gate. Every read and write goes through a service-role route that has already
-- authorized the manager's session. The explicit revoke is the second,
-- migration-visible barrier so a later policy cannot make a credential store
-- browser-writable by accident.
revoke insert, update, delete on table public.webhook_subscriptions from anon, authenticated;
revoke insert, update, delete on table public.webhook_deliveries from anon, authenticated;
