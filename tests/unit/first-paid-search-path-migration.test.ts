import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(process.cwd(), "supabase", "migrations");
const read = (name: string) => readFileSync(join(dir, name), "utf8");
const fnOf = (sql: string) => sql.slice(sql.indexOf("create or replace function public.managed_read_only_owned_locked_ids"));

describe("20261020190100_first_paid_search_path", () => {
  const next = read("20261020190100_first_paid_search_path.sql");
  const prev = read("20261020140000_manager_purchase_first_paid.sql");

  it("re-creates the security definer function with pg_temp pinned last", () => {
    expect(next).toMatch(/security definer\s+set search_path = public, pg_temp\s+as \$\$/);
    expect(next).not.toMatch(/set search_path = public\s*\n/);
  });

  it("keeps the body and the revoke identical to the applied migration", () => {
    expect(fnOf(next).replace("public, pg_temp", "public")).toBe(fnOf(prev));
    expect(next).toContain("revoke all on function public.managed_read_only_owned_locked_ids(uuid) from public, anon, authenticated;");
  });

  it("leaves the applied migration untouched", () => {
    expect(prev).toContain("set search_path = public\n");
    expect(prev).not.toContain("pg_temp");
  });
});

describe("20261021090000_managed_read_only_search_path_siblings", () => {
  const next = read("20261021090000_managed_read_only_search_path_siblings.sql");
  const prev = read("20261019120000_managed_read_only_v2.sql");
  /** One `create or replace function ... $$;` block by name. */
  const bodyOf = (sql: string, name: string) => {
    const at = sql.indexOf(`create or replace function public.${name}`);
    const end = sql.indexOf("$$;", at);
    return sql.slice(at, end + 3);
  };

  it("pins pg_temp last on BOTH siblings of the family", () => {
    for (const name of ["managed_read_only_workspace_ids", "managed_read_only_owner_locked"]) {
      expect(bodyOf(next, name)).toContain("set search_path = public, pg_temp");
    }
    expect(next).not.toMatch(/set search_path = public\s*\n/);
  });

  it("keeps each body and its grants identical to the applied definition", () => {
    for (const name of ["managed_read_only_workspace_ids", "managed_read_only_owner_locked"]) {
      expect(bodyOf(next, name).replace("public, pg_temp", "public")).toBe(bodyOf(prev, name));
      expect(next).toContain(`revoke all on function public.${name}() from public, anon;`);
      expect(next).toContain(`grant execute on function public.${name}() to authenticated;`);
    }
  });
});

describe("20261021090100_service_seat_and_move_memory", () => {
  const sql = read("20261021090100_service_seat_and_move_memory.sql");

  const statements = () =>
    sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");

  it("adds both columns idempotently, with a default, and drops nothing", () => {
    expect(sql).toContain("alter table public.account_link_invites\n  add column if not exists is_service_seat boolean not null default false;");
    expect(sql).toContain(
      "alter table public.external_calendar_connections\n  add column if not exists released_identities jsonb not null default '{}'::jsonb;",
    );
    expect(statements()).not.toMatch(/\b(delete from|drop column|drop table)\b/i);
  });

  it("backfills an operator seat PropLane itself issued - accepted or still pending - and nothing else", () => {
    const backfill = statements().slice(statements().indexOf("update public.account_link_invites"));
    expect(backfill).toContain("set is_service_seat = true");
    // Re-runnable, and never widens: only unmarked operator-role seats on a service workspace. A seat a
    // helper has not accepted yet is still one PropLane issued, so `pending` is marked with `accepted`.
    expect(backfill).toContain("l.is_service_seat = false");
    expect(backfill).toContain("l.status in ('accepted', 'pending')");
    expect(backfill).toContain("in ('admin', 'full')");
    expect(backfill).toContain("from public.portal_workspaces w");
    expect(backfill).toContain("w.is_service");
    // The ONE provenance an already-written row carries: the admin Service route's own audit entry naming
    // that invitee on that workspace. The holder being a platform admin or the service owner is
    // deliberately not a reason - they are staff through their own rule at read time, and a seat the
    // client granted herself must stay false.
    expect(backfill).toContain("'admin_service_team_invite', 'admin_service_team_add'");
    expect(backfill).not.toContain("from public.profile_roles");
    expect(backfill).not.toContain("from public.platform_service_settings");
    expect(backfill).toContain("a.input_summary ->> 'inviteeUserId' = l.invitee_user_id::text");
    expect(backfill).toContain("a.input_summary ->> 'workspaceId' = l.workspace_id::text");
    // Only one write, and it only ever sets the flag TRUE: a client's own seat is left as it is.
    expect(statements().match(/\bupdate\b/gi)).toHaveLength(1);
    expect(backfill).not.toContain("is_service_seat = false;");
  });

  it("documents what each column is for, so neither reads as a spare field", () => {
    expect(sql).toContain("comment on column public.account_link_invites.is_service_seat is");
    expect(sql).toContain("comment on column public.external_calendar_connections.released_identities is");
  });
});
