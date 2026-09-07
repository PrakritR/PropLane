-- Build the throwaway schemas a fresh production dump is restored into.
--
-- The incremental refresh is a three-way merge and needs all three sides
-- addressable as tables: `public`/`auth` (staging, live), `prod_import*` (the
-- dump that just came off production), and `prod_snapshot*` (production as of
-- the previous refresh, which is last run's import schema, renamed).
--
-- Restoring into an import schema rather than straight over live is the whole
-- safety property: a dump that fails to load leaves staging untouched, instead
-- of the --full-replace failure mode where the wipe succeeds, the restore dies
-- under ON_ERROR_STOP=1, and staging is left empty.
SET ROLE postgres;

drop schema if exists "prod_import" cascade;
create schema "prod_import";
drop schema if exists "prod_import_auth" cascade;
create schema "prod_import_auth";

do $setup$
declare
  pair record;
  tbl  record;
  col  record;
begin
  for pair in
    select * from (values ('public', 'prod_import'), ('auth', 'prod_import_auth')) as v(live, imp)
  loop
    for tbl in
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = pair.live
        and c.relkind = 'r'
        and c.relname not in ('spatial_ref_sys', 'schema_migrations')
    loop
      -- Plain LIKE on purpose: columns and nothing else. Constraints, defaults,
      -- indexes and identity would all be dead weight on a table that exists
      -- only to be compared and read from.
      execute format('create table %I.%I (like %I.%I)', pair.imp, tbl.relname, pair.live, tbl.relname);

      -- pg_dump omits GENERATED columns from its COPY lists, so the import copy
      -- of such a column is never populated. LIKE still carried its NOT NULL
      -- across, which would fail the COPY on a column the dump cannot supply.
      -- The import schema is a data carrier, so drop every NOT NULL.
      for col in
        select a.attname
        from pg_attribute a
        where a.attrelid = format('%I.%I', pair.imp, tbl.relname)::regclass
          and a.attnum > 0
          and not a.attisdropped
          and a.attnotnull
      loop
        execute format(
          'alter table %I.%I alter column %I drop not null',
          pair.imp, tbl.relname, col.attname
        );
      end loop;
    end loop;
  end loop;
end
$setup$;
