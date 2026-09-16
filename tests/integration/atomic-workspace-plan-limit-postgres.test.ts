import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Opt-in rehearsal for the new workspace RPC. The URL must point at a
 * disposable localhost database; the suite never falls back to a configured
 * Supabase or application database.
 */
const url = process.env.WORKSPACE_RPC_TEST_DATABASE_URL;
if (url && !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
  throw new Error("Workspace RPC rehearsal requires a disposable local database.");
}

const db = new Pool({ connectionString: url, max: 12 });
const suite = url ? describe : describe.skip;
// The delete-any migration replaces the create routine, so both run in order,
// as they do on every real target.
const migrations = [
  readFileSync("supabase/migrations/20260913001000_atomic_workspace_plan_limit.sql", "utf8"),
  readFileSync("supabase/migrations/20260916030000_workspace_delete_any.sql", "utf8"),
];
const createdRoles: string[] = [];

suite("atomic workspace plan-limit RPC on local PostgreSQL", () => {
  beforeAll(async () => {
    // The rehearsal owns this disposable database. Create only the minimal
    // objects the reviewed migration needs, plus the same owner lock trigger
    // that already protects portal_workspaces in production.
    await db.query("create extension if not exists pgcrypto");
    await db.query(`
      create table if not exists public.profiles (
        id uuid primary key
      );
      create table if not exists public.portal_workspaces (
        id uuid primary key default gen_random_uuid(),
        owner_user_id uuid not null references public.profiles(id) on delete cascade,
        name text not null check (length(btrim(name)) between 1 and 80),
        is_default boolean not null default false,
        created_at timestamptz not null default now()
      );
      create unique index if not exists portal_workspaces_default_owner
        on public.portal_workspaces(owner_user_id) where is_default;
      create table if not exists public.manager_property_records (
        id text primary key,
        manager_user_id uuid references public.profiles(id) on delete set null,
        workspace_id uuid references public.portal_workspaces(id) on delete restrict
      );
    `);
    await db.query(`
      create or replace function public.enforce_portal_workspace_limit()
      returns trigger language plpgsql security definer set search_path = public as $$
      begin
        perform pg_advisory_xact_lock(hashtextextended('workspace-owner:' || new.owner_user_id::text, 0));
        if (select count(*) from public.portal_workspaces where owner_user_id = new.owner_user_id) >= 10 then
          raise exception 'You can own up to 10 workspaces.' using errcode = '23514';
        end if;
        return new;
      end;
      $$;
      drop trigger if exists portal_workspace_limit on public.portal_workspaces;
      create trigger portal_workspace_limit before insert or update of owner_user_id
        on public.portal_workspaces for each row execute function public.enforce_portal_workspace_limit();
    `);

    // Supabase's client roles are present in the real target. A disposable
    // plain PostgreSQL cluster may not have them, so create only these named
    // ACL principals inside the opt-in local rehearsal.
    for (const role of ["anon", "authenticated", "service_role"]) {
      const existing = await db.query("select 1 from pg_roles where rolname = $1", [role]);
      if (!existing.rowCount) {
        await db.query(`create role ${role} nologin noinherit`);
        createdRoles.push(role);
      }
    }
    for (const migration of migrations) await db.query(migration);
  });

  afterAll(async () => {
    await db.query("drop function if exists public.delete_portal_workspace(uuid,uuid,uuid)");
    await db.query("drop function if exists public.create_portal_workspace_with_limit(uuid,text,integer)");
    await db.query("drop table if exists public.manager_property_records");
    await db.query("drop trigger if exists portal_workspace_limit on public.portal_workspaces");
    await db.query("drop function if exists public.enforce_portal_workspace_limit()");
    await db.query("drop table if exists public.portal_workspaces");
    await db.query("drop table if exists public.profiles");
    for (const role of createdRoles.reverse()) await db.query(`drop role if exists ${role}`);
    await db.end();
  });

  it("exposes the RPC to service_role and no client role", async () => {
    const signature = "public.create_portal_workspace_with_limit(uuid,text,integer)";
    const rows = await db.query(
      "select has_function_privilege($1,$2,'execute') as can_execute",
      ["anon", signature],
    );
    const authenticated = await db.query(
      "select has_function_privilege($1,$2,'execute') as can_execute",
      ["authenticated", signature],
    );
    const service = await db.query(
      "select has_function_privilege($1,$2,'execute') as can_execute",
      ["service_role", signature],
    );
    expect(rows.rows[0].can_execute).toBe(false);
    expect(authenticated.rows[0].can_execute).toBe(false);
    expect(service.rows[0].can_execute).toBe(true);
  });

  it("admits exactly one concurrent creator for the final plan slot", async () => {
    const owner = randomUUID();
    await db.query("insert into public.profiles(id) values ($1)", [owner]);
    await db.query(
      "insert into public.portal_workspaces(owner_user_id,name,is_default) values ($1,$2,true),($1,$3,false)",
      [owner, "My workspace", "Existing team"],
    );

    const calls = Array.from({ length: 12 }, (_, i) =>
      db.query(
        "select public.create_portal_workspace_with_limit($1,$2,$3) as id",
        [owner, `Concurrent team ${i}`, 3],
      ),
    );
    const results = await Promise.all(calls);
    expect(results.filter((result) => result.rows[0].id !== null)).toHaveLength(1);
    expect(
      (await db.query("select count(*)::integer as count from public.portal_workspaces where owner_user_id=$1", [owner])).rows[0].count,
    ).toBe(3);
  });

  it("makes the first named workspace the default instead of seeding one beside it", async () => {
    const owner = randomUUID();
    await db.query("insert into public.profiles(id) values ($1)", [owner]);

    const result = await db.query(
      "select public.create_portal_workspace_with_limit($1,$2,$3) as id",
      [owner, "Named team", 1],
    );
    expect(result.rows[0].id).not.toBeNull();
    expect(
      (await db.query(
        "select name,is_default from public.portal_workspaces where owner_user_id=$1",
        [owner],
      )).rows,
    ).toEqual([{ name: "Named team", is_default: true }]);
  });

  it("deletes the default workspace, moves its houses, and promotes the oldest remaining one", async () => {
    const owner = randomUUID();
    await db.query("insert into public.profiles(id) values ($1)", [owner]);
    const first = (await db.query("select public.create_portal_workspace_with_limit($1,$2,$3) as id", [owner, "First", 3])).rows[0].id;
    const second = (await db.query("select public.create_portal_workspace_with_limit($1,$2,$3) as id", [owner, "Second", 3])).rows[0].id;
    await db.query("insert into public.manager_property_records(id,manager_user_id,workspace_id) values ($1,$2,$3)", ["house-1", owner, first]);

    // Houses left behind refuse the delete atomically.
    await expect(db.query("select public.delete_portal_workspace($1,$2,null)", [owner, first])).rejects.toMatchObject({ code: "23503" });

    const moved = await db.query("select public.delete_portal_workspace($1,$2,$3) as ok", [owner, first, second]);
    expect(moved.rows[0].ok).toBe(true);
    expect((await db.query("select workspace_id from public.manager_property_records where id=$1", ["house-1"])).rows[0].workspace_id).toBe(second);
    expect(
      (await db.query("select name,is_default from public.portal_workspaces where owner_user_id=$1", [owner])).rows,
    ).toEqual([{ name: "Second", is_default: true }]);

    // A stranger's id is not authorization: nothing is deleted for another owner.
    expect((await db.query("select public.delete_portal_workspace($1,$2,null) as ok", [randomUUID(), second])).rows[0].ok).toBe(false);
    // The last workspace can go too.
    await db.query("delete from public.manager_property_records where id=$1", ["house-1"]);
    expect((await db.query("select public.delete_portal_workspace($1,$2,null) as ok", [owner, second])).rows[0].ok).toBe(true);
    expect((await db.query("select count(*)::integer as count from public.portal_workspaces where owner_user_id=$1", [owner])).rows[0].count).toBe(0);
  });

  it("rejects invalid caps and names in the database function", async () => {
    const owner = randomUUID();
    await db.query("insert into public.profiles(id) values ($1)", [owner]);
    for (const limit of [0, 11]) {
      await expect(
        db.query(
          "select public.create_portal_workspace_with_limit($1,$2,$3)",
          [owner, "Valid name", limit],
        ),
      ).rejects.toMatchObject({ code: "22023" });
    }
    for (const name of ["", "x".repeat(81)]) {
      await expect(
        db.query(
          "select public.create_portal_workspace_with_limit($1,$2,$3)",
          [owner, name, 2],
        ),
      ).rejects.toMatchObject({ code: "22023" });
    }
  });
});
