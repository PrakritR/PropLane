-- Incremental production → staging refresh: the apply half of `decideRowFate`.
--
-- Runs after a production dump has been restored into prod_import / prod_import_auth.
-- Three-way per row, keyed on the live table's primary key:
--
--   in prod, not in staging                      -> insert          (insert-prod)
--   in both, prod differs from snapshot          -> overwrite       (update-prod)
--   in both, prod matches snapshot               -> leave staging   (noop / keep-staging)
--   not in prod, in staging, WAS in snapshot     -> delete          (delete-staging)
--   not in prod, in staging, never in snapshot   -> leave staging   (keep-staging)
--
-- That last line is the one QA cares about: a row created on staging was never
-- in a production snapshot, so it survives every refresh. The row above it is
-- the other half — an edit QA makes to a production-origin row is kept as long
-- as production has not itself changed that row since the last refresh.
--
-- The merge and the snapshot rotation are one transaction. Either staging moves
-- forward and the new baseline is recorded together, or neither happens; a
-- committed merge with a stale snapshot would resurrect deleted rows next run.
SET ROLE postgres;

-- Foreign keys and triggers off: the dump is an internally consistent snapshot
-- of production, so ordering 136 tables by dependency buys nothing, and letting
-- application triggers fire would recompute columns production already decided.
SET session_replication_role = replica;

create temporary table staging_merge_stats (
  live_schema text,
  table_name  text,
  inserted    bigint,
  updated     bigint,
  deleted     bigint
);

begin;

do $merge$
declare
  pair     record;
  tbl      record;
  pk_cols  text[];
  ins_cols text[];
  upd_cols text[];
  join_sp  text;
  join_sq  text;
  join_pq  text;
  col_list text;
  sel_list text;
  assigns  text;
  n_ins bigint;
  n_upd bigint;
  n_del bigint;
begin
  for pair in
    select * from (values
      ('public', 'prod_import',      'prod_snapshot'),
      ('auth',   'prod_import_auth', 'prod_snapshot_auth')
    ) as v(live, imp, snap)
  loop
    -- First refresh has no baseline. An empty snapshot makes every production
    -- row "not in snapshot", which resolves to insert/update and never to a
    -- delete — the safe direction to be wrong in.
    if to_regnamespace(pair.snap) is null then
      execute format('create schema %I', pair.snap);
    end if;

    for tbl in
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = pair.live
        and c.relkind = 'r'
        and c.relname not in ('spatial_ref_sys', 'schema_migrations')
        and exists (select 1 from pg_index i where i.indrelid = c.oid and i.indisprimary)
        and to_regclass(format('%I.%I', pair.imp, c.relname)) is not null
      order by c.relname
    loop
      select array_agg(a.attname order by k.ord)
        into pk_cols
      from pg_index i
      cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
      where i.indrelid = format('%I.%I', pair.live, tbl.relname)::regclass
        and i.indisprimary;

      -- Generated columns are excluded exactly as pg_dump excludes them: they
      -- cannot be written, and the database recomputes them from what is.
      select array_agg(a.attname order by a.attnum)
        into ins_cols
      from pg_attribute a
      where a.attrelid = format('%I.%I', pair.live, tbl.relname)::regclass
        and a.attnum > 0
        and not a.attisdropped
        and a.attgenerated = '';

      if ins_cols is null or pk_cols is null then
        continue;
      end if;

      -- No snapshot row for this table: either the first refresh, or a table
      -- added to the schema since the last one. An empty stand-in makes every
      -- production row read as "not in snapshot", which is insert/update and
      -- never delete — a new table can never arrive by deleting staging rows.
      if to_regclass(format('%I.%I', pair.snap, tbl.relname)) is null then
        execute format(
          'create table %I.%I (like %I.%I)',
          pair.snap, tbl.relname, pair.live, tbl.relname
        );
      end if;

      select string_agg(format('s.%I = p.%I', c, c), ' and ') into join_sp from unnest(pk_cols) c;
      select string_agg(format('s.%I = q.%I', c, c), ' and ') into join_sq from unnest(pk_cols) c;
      select string_agg(format('p.%I = q.%I', c, c), ' and ') into join_pq from unnest(pk_cols) c;
      select string_agg(format('%I', c), ', ')      into col_list from unnest(ins_cols) c;
      select string_agg(format('p.%I', c), ', ')    into sel_list from unnest(ins_cols) c;

      upd_cols := array(select c from unnest(ins_cols) c where not (c = any (pk_cols)));
      select string_agg(format('%I = p.%I', c, c), ', ') into assigns from unnest(upd_cols) c;

      -- delete-staging: production dropped a row it had at the last refresh.
      execute format(
        'delete from %I.%I s
          where exists (select 1 from %I.%I q where %s)
            and not exists (select 1 from %I.%I p where %s)',
        pair.live, tbl.relname,
        pair.snap, tbl.relname, join_sq,
        pair.imp,  tbl.relname, join_sp
      );
      get diagnostics n_del = row_count;

      -- update-prod: production changed the row since the snapshot, so it wins.
      -- A LEFT JOIN makes "no snapshot row" compare as different, which is the
      -- !inSnapshot -> update-prod branch.
      if assigns is not null then
        execute format(
          'update %I.%I s set %s
             from %I.%I p
             left join %I.%I q on %s
            where %s
              and to_jsonb(p.*) is distinct from to_jsonb(q.*)',
          pair.live, tbl.relname, assigns,
          pair.imp,  tbl.relname,
          pair.snap, tbl.relname, join_pq,
          join_sp
        );
        get diagnostics n_upd = row_count;
      else
        n_upd := 0;
      end if;

      -- insert-prod: production has a row staging has never seen.
      execute format(
        'insert into %I.%I (%s)
         select %s from %I.%I p
          where not exists (select 1 from %I.%I s where %s)',
        pair.live, tbl.relname, col_list,
        sel_list, pair.imp, tbl.relname,
        pair.live, tbl.relname, join_sp
      );
      get diagnostics n_ins = row_count;

      insert into staging_merge_stats
        values (pair.live, tbl.relname, n_ins, n_upd, n_del);
    end loop;
  end loop;
end
$merge$;

-- Sequences are staging's own state, not production's, so the dump's setval
-- lines are dropped on import. Re-derive each one from the data that is now
-- actually there, and only ever upward: a staging-only row can hold an id above
-- anything production reached, and lowering the sequence would hand that id out
-- a second time.
do $sequences$
declare r record;
begin
  for r in
    select ns.nspname as seq_schema, s.relname as seq,
           tn.nspname as tbl_schema, t.relname as tbl, a.attname as col
    from pg_class s
    join pg_namespace ns on ns.oid = s.relnamespace
    join pg_depend d on d.objid = s.oid and d.classid = 'pg_class'::regclass and d.deptype in ('a', 'i')
    join pg_class t on t.oid = d.refobjid
    join pg_namespace tn on tn.oid = t.relnamespace
    join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
    where s.relkind = 'S' and tn.nspname in ('public', 'auth')
  loop
    execute format(
      'select setval(%L, greatest((select last_value from %I.%I), coalesce((select max(%I) from %I.%I), 1)))',
      format('%I.%I', r.seq_schema, r.seq),
      r.seq_schema, r.seq,
      r.col, r.tbl_schema, r.tbl
    );
  end loop;
end
$sequences$;

-- This refresh's production state becomes the next refresh's baseline.
drop schema if exists "prod_snapshot" cascade;
alter schema "prod_import" rename to "prod_snapshot";
drop schema if exists "prod_snapshot_auth" cascade;
alter schema "prod_import_auth" rename to "prod_snapshot_auth";

commit;

select live_schema, table_name, inserted, updated, deleted
from staging_merge_stats
where inserted + updated + deleted > 0
order by live_schema, table_name;
