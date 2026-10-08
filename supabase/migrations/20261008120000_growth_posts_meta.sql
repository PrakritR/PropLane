-- Growth engine Phase 2: render bookkeeping on the post (meta.rendered, meta.renderSignature, meta.renderedAt).
alter table public.growth_posts add column if not exists meta jsonb not null default '{}'::jsonb;
