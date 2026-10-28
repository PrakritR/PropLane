import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Opt-in rehearsal of `combine_portal_workspaces` (migration
 * `20261027030000_portal_workspaces_archived_combine.sql`) on a DISPOSABLE localhost PostgreSQL, because the only
 * other coverage of "Combine all into one" reimplements the RPC in JavaScript (`tests/helpers/service-fake-db.ts`),
 * so the SQL that actually runs in production is never executed by a test.
 *
 * It is the whole admin action, in SQL: an owner with three workspaces has the houses of the other two moved into the
 * one that stays, the emptied ones are archived (reversibly), the owner's DEFAULT workspace stays listed because a
 * house with no workspace lands there, and nothing but `manager_property_records.workspace_id` moves.
 *
 * It also pins the bug that made the shipped function unrunnable: `manager_property_records.id` is TEXT, so collecting
 * the moved ids into a `uuid[]` raised 42846 on every call, whatever the data.
 *
 *   PGDATA=$(mktemp -d)/pg && initdb -D "$PGDATA" -U postgres --auth=trust
 *   pg_ctl -D "$PGDATA" -o "-p 55432 -k $PGDATA" -l "$PGDATA/server.log" start
 *   psql -h 127.0.0.1 -p 55432 -U postgres -c "create database combine_rehearsal"
 *   COMBINE_RPC_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/combine_rehearsal \
 *     npx vitest run tests/integration/combine-portal-workspaces-postgres.test.ts
 *   pg_ctl -D "$PGDATA" stop && rm -rf "$PGDATA"
 *
 * Set EVIDENCE_DIR to also write the transcript a reviewer reads.
 */
const url = process.env.COMBINE_RPC_TEST_DATABASE_URL;
if (url && !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
  throw new Error("The combine rehearsal requires a disposable local database.");
}

const MIGRATION_PATH = "supabase/migrations/20261027030000_portal_workspaces_archived_combine.sql";
const migration = readFileSync(MIGRATION_PATH, "utf8");
/** The function exactly as it shipped before the fix: the moved house ids collected into a `uuid[]`. */
const preFixMigration = migration
  .replace("v_moved text[];", "v_moved uuid[];")
  .replace("coalesce(pg_catalog.array_agg(id), '{}'::text[]) into v_moved", "coalesce(pg_catalog.array_agg(id), '{}'::uuid[]) into v_moved");

const db = new Pool({ connectionString: url, max: 8 });
const suite = url ? describe : describe.skip;
const transcript: string[] = [];
const say = (line: string) => {
  transcript.push(line);
  console.log(`  · ${line}`);
};

type Combined = { moved: string[]; archived: string[]; kept: string[] };

async function combine(owner: string, target: string, sources: string[]): Promise<Combined> {
  const { rows } = await db.query<{ out: Combined }>("select public.combine_portal_workspaces($1,$2,$3) as out", [owner, target, sources]);
  return rows[0]!.out;
}

/** One owner, three workspaces (the first is their default) and the houses linked to each. */
async function seedOwner(houses: Record<string, string[]>): Promise<{ owner: string; workspaces: string[] }> {
  const owner = randomUUID();
  await db.query("insert into public.profiles (id) values ($1)", [owner]);
  const names = Object.keys(houses);
  const workspaces: string[] = [];
  for (const [index, name] of names.entries()) {
    const { rows } = await db.query<{ id: string }>(
      "insert into public.portal_workspaces (owner_user_id, name, is_default) values ($1,$2,$3) returning id",
      [owner, name, index === 0],
    );
    workspaces.push(rows[0]!.id);
    for (const house of houses[name]!) {
      await db.query("insert into public.manager_property_records (id, manager_user_id, workspace_id, status) values ($1,$2,$3,'active')", [
        house,
        owner,
        rows[0]!.id,
      ]);
    }
  }
  return { owner, workspaces };
}

suite("combine_portal_workspaces on local PostgreSQL", () => {
  beforeAll(async () => {
    // The rehearsal owns this disposable database: only the objects the reviewed migration touches, with
    // `manager_property_records.id` the TEXT column it really is, plus the roles the grants name.
    for (const role of ["anon", "authenticated", "service_role"]) {
      await db.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role}; end if; end $$`);
    }
    await db.query("create extension if not exists pgcrypto");
    await db.query(`
      create table if not exists public.profiles (id uuid primary key);
      create table if not exists public.portal_workspaces (
        id uuid primary key default gen_random_uuid(),
        owner_user_id uuid not null references public.profiles(id) on delete cascade,
        name text not null,
        is_default boolean not null default false,
        is_service boolean not null default false,
        city text,
        created_at timestamptz not null default now()
      );
      create table if not exists public.manager_property_records (
        id text primary key,
        manager_user_id uuid references public.profiles(id) on delete set null,
        workspace_id uuid references public.portal_workspaces(id) on delete restrict,
        status text not null
      );
    `);
    await db.query(migration);
  });

  afterAll(async () => {
    if (process.env.EVIDENCE_DIR && transcript.length) {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
      writeFileSync(
        `${process.env.EVIDENCE_DIR}/combine-portal-workspaces-postgres.txt`,
        [
          "Combine all into one — combine_portal_workspaces on a disposable local PostgreSQL",
          `migration: ${MIGRATION_PATH}`,
          "",
          ...transcript,
          "",
        ].join("\n"),
        "utf8",
      );
    }
    await db.end();
  });

  it("moves every house of the emptied workspaces into the one that stays, and archives them", async () => {
    // House ids are the real thing: the app's own text keys, not uuids.
    const { owner, workspaces } = await seedOwner({
      "Homes (default)": ["mgr-qa-house-brooklyn-5257-aa11bb22cc33"],
      "Beacon Hill homes": ["mgr-qa-house-beacon-hill-14th-dd44ee55", "mgr-qa-house-beacon-hill-15th-ff66gg77"],
      "Capitol Hill homes": ["mgr-qa-house-capitol-hill-pine-hh88ii99"],
    });
    const [defaultWs, beacon, capitol] = workspaces as [string, string, string];

    const answer = await combine(owner, beacon, [defaultWs, capitol]);

    expect([...answer.moved].sort()).toEqual(["mgr-qa-house-brooklyn-5257-aa11bb22cc33", "mgr-qa-house-capitol-hill-pine-hh88ii99"]);
    expect(answer.archived).toEqual([capitol]);
    // The owner's default workspace is where a house with no workspace lands, so it stays listed, emptied.
    expect(answer.kept).toEqual([defaultWs]);
    say(`combine → moved ${answer.moved.length} houses: ${answer.moved.join(", ")}`);
    say(`combine → archived "Capitol Hill homes"; kept "Homes (default)" listed and empty`);

    const links = await db.query<{ id: string; workspace_id: string }>(
      "select id, workspace_id from public.manager_property_records where manager_user_id = $1 order by id",
      [owner],
    );
    expect(links.rows.every((row) => row.workspace_id === beacon)).toBe(true);
    say(`every one of the owner's ${links.rows.length} houses now points at "Beacon Hill homes"`);

    const after = await db.query<{ name: string; archived: boolean }>(
      "select name, archived_at is not null as archived from public.portal_workspaces where owner_user_id = $1 order by created_at",
      [owner],
    );
    expect(after.rows).toEqual([
      { name: "Homes (default)", archived: false },
      { name: "Beacon Hill homes", archived: false },
      { name: "Capitol Hill homes", archived: true },
    ]);
    say(`workspace list afterwards: ${after.rows.map((r) => `${r.name}${r.archived ? " [archived — left out of every list]" : ""}`).join(" | ")}`);

    // Reversible: clearing archived_at puts the workspace back in every list.
    await db.query("update public.portal_workspaces set archived_at = null where id = $1", [capitol]);
    const restored = await db.query<{ archived: boolean }>("select archived_at is not null as archived from public.portal_workspaces where id = $1", [capitol]);
    expect(restored.rows[0]!.archived).toBe(false);
    say("archiving is reversible: clearing archived_at lists the workspace again");
  });

  it("moves nothing when a source is not an active unmanaged workspace of that owner", async () => {
    const { owner, workspaces } = await seedOwner({
      "Homes (default)": ["mgr-qa-house-refuse-default-jj11kk22"],
      "South Park homes": ["mgr-qa-house-refuse-south-park-ll33mm44"],
    });
    const [defaultWs, southPark] = workspaces as [string, string];
    const stranger = await seedOwner({ "Someone else's homes": ["mgr-qa-house-stranger-nn55oo66"] });

    // A workspace of a different owner, named in the request, refuses the whole move.
    await expect(combine(owner, southPark, [defaultWs, stranger.workspaces[0]!])).rejects.toMatchObject({ code: "23514" });
    // A workspace already managed by PropLane is not a source either.
    await db.query("update public.portal_workspaces set is_service = true where id = $1", [defaultWs]);
    await expect(combine(owner, southPark, [defaultWs])).rejects.toMatchObject({ code: "23514" });
    await db.query("update public.portal_workspaces set is_service = false where id = $1", [defaultWs]);
    // And the target cannot also be a source.
    await expect(combine(owner, southPark, [southPark])).rejects.toMatchObject({ code: "22023" });

    const links = await db.query<{ id: string; workspace_id: string }>(
      "select id, workspace_id from public.manager_property_records where manager_user_id = $1 order by id",
      [owner],
    );
    expect(links.rows.map((row) => row.workspace_id)).toEqual([defaultWs, southPark]);
    const archived = await db.query<{ count: string }>(
      "select count(*)::text as count from public.portal_workspaces where owner_user_id = $1 and archived_at is not null",
      [owner],
    );
    expect(archived.rows[0]!.count).toBe("0");
    say("a refused combine (another owner's workspace, an already-managed one, target = source) moves no house and archives nothing");
  });

  it("the moved house ids are TEXT: collecting them into a uuid[] refuses every call", async () => {
    const { owner, workspaces } = await seedOwner({
      "Homes (default)": ["mgr-qa-house-typecheck-default-pp77qq88"],
      "Rainier homes": ["mgr-qa-house-typecheck-rainier-rr99ss00"],
    });
    const [defaultWs, rainier] = workspaces as [string, string];

    await db.query(preFixMigration);
    const refused = await combine(owner, rainier, [defaultWs]).catch((error: { code?: string; message?: string }) => error);
    expect(refused).toMatchObject({ code: "42846" });
    say(`the pre-fix function (v_moved uuid[]) refuses unconditionally: 42846 ${String((refused as { message?: string }).message ?? "").split("\n")[0]}`);

    // Nothing was moved or archived by the refused call.
    const stillHome = await db.query<{ workspace_id: string }>("select workspace_id from public.manager_property_records where id = $1", [
      "mgr-qa-house-typecheck-default-pp77qq88",
    ]);
    expect(stillHome.rows[0]!.workspace_id).toBe(defaultWs);

    // The shipped migration, re-applied, carries the same call.
    await db.query(migration);
    const answer = await combine(owner, rainier, [defaultWs]);
    expect(answer.moved).toEqual(["mgr-qa-house-typecheck-default-pp77qq88"]);
    say("the shipped function (v_moved text[]) carries the same call and moves the house");
  });

  it("is reachable by service_role only", async () => {
    const grants = await db.query<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type from information_schema.routine_privileges
         where routine_name = 'combine_portal_workspaces' and specific_schema = 'public'`,
    );
    // The function's owner keeps its own grant on any database (here the local superuser); what matters is that no
    // client role can reach it.
    const grantees = grants.rows.map((row) => row.grantee);
    expect(grantees).toContain("service_role");
    expect(grantees.filter((grantee) => ["PUBLIC", "public", "anon", "authenticated"].includes(grantee))).toEqual([]);
    say("execute on combine_portal_workspaces is granted to service_role only (revoked from public, anon, authenticated)");
  });
});
