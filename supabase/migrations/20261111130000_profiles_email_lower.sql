-- Case-insensitive recipient lookup that an index can answer.
--
-- `profiles.email` is stored as the user typed it, so every "does this address have an account?"
-- read has to be case-insensitive. Done with `ilike` (or `lower(email) = ...`) Postgres cannot use an
-- index at all: each read is a sequential scan of `profiles`, once per chunk of addresses, on the
-- send path. A STORED generated column is indexable AND reachable through PostgREST's `in` filter,
-- which an expression index alone is not.
--
-- Additive and idempotent: no existing column, grant or policy changes. The column is derived, so it
-- carries nothing `email` did not already disclose to the same reader.

alter table public.profiles
  add column if not exists email_lower text generated always as (lower(email)) stored;

create index if not exists profiles_email_lower_idx on public.profiles (email_lower);
