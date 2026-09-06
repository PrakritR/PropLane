/**
 * Real PostgreSQL transaction evidence. Opt in against a disposable LOCAL cluster:
 * ROOM_CAPACITY_TEST_PORT=55439 npx vitest run tests/integration/database/shared-room-capacity.test.ts
 *
 * The host is always 127.0.0.1; DATABASE_URL and PGHOST are never read. Creates and
 * drops only its own randomly named database, never the connection's database or
 * an existing schema. The local cluster must already contain the Supabase roles
 * anon/authenticated/service_role and the connecting user must have CREATEDB.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const configuredPort = process.env.ROOM_CAPACITY_TEST_PORT;
const owner = "11111111-1111-4111-8111-111111111111";
const database = `room_capacity_test_${randomUUID().replaceAll("-", "")}`;

describe.skipIf(!configuredPort)("shared-room PostgreSQL transaction guard", () => {
  let admin: Client;
  let db: Client;
  let created = false;
  const connections = new Set<Client>();
  const connect = async (name = database) => {
    const client = new Client({ host: "127.0.0.1", port: Number(configuredPort),
      database: name, user: process.env.ROOM_CAPACITY_TEST_USER || userInfo().username,
      password: process.env.ROOM_CAPACITY_TEST_PASSWORD || "", connectionTimeoutMillis: 3_000,
      options: "-c statement_timeout=10000 -c lock_timeout=5000" });
    await client.connect(); connections.add(client); return client;
  };
  beforeAll(async () => {
    if (!configuredPort || !/^\d+$/.test(configuredPort) || Number(configuredPort) < 1024 || Number(configuredPort) > 65535) {
      throw new Error("ROOM_CAPACITY_TEST_PORT must explicitly name a local test cluster port (1024..65535).");
    }
    admin = await connect("postgres");
    const roles = await admin.query("select rolname from pg_roles where rolname in ('anon','authenticated','service_role')");
    if (roles.rowCount !== 3) throw new Error("The local test cluster needs the existing Supabase roles anon/authenticated/service_role.");
    await admin.query(`create database "${database}"`); created = true;
    db = await connect();
    // Minimum schema matching the columns read/written by the real migration.
    await db.query(`
      create table public.manager_property_records(id text primary key, manager_user_id uuid, property_data jsonb, row_data jsonb);
      create table public.manager_application_records(id text primary key, manager_user_id uuid, resident_email text,
        property_id text, assigned_property_id text, row_data jsonb, created_at timestamptz default now(), updated_at timestamptz default now());
      create table public.portal_lease_pipeline_records(id text primary key, manager_user_id uuid, property_id text, row_data jsonb, status text, updated_at timestamptz default now());
      create table public.application_document_storage_aliases(application_id text);
      create table public.cosigner_submission_records(signer_app_id text, row_data jsonb, updated_at timestamptz);
      create table public.screening_orders(application_id text);
      create table public.application_fee_waiver_redemptions(application_id text);
    `);
    await db.query(await readFile("supabase/migrations/20260906070000_shared_room_capacity.sql", "utf8"));
  });
  afterAll(async () => {
    for (const client of connections) {
      if (client === admin) continue;
      await client.query("rollback").catch(() => undefined);
      await client.end();
    }
    if (created) await admin.query(`drop database "${database}"`);
    if (admin) await admin.end();
  });
  const fixture = async (capacity = 2) => {
    const propertyId = `test-${randomUUID()}`;
    await db.query("insert into manager_property_records(id,manager_user_id,property_data,row_data) values($1,$2,$3,$4)",
      [propertyId, owner, { listingSubmission: { rooms: [{ id: "r", name: "Room 1", occupancyCapacity: capacity }] } }, {}]);
    const application = (suffix: string, start = "2030-10-01", end = "2030-10-31") => ({
      id: `AXIS-${propertyId}-${suffix}`, managerUserId: owner, bucket: "approved", propertyId,
      assignedRoomChoice: `${propertyId}::r`, application: { leaseStart: start, leaseEnd: end },
    });
    return { propertyId, application };
  };
  type Application = ReturnType<Awaited<ReturnType<typeof fixture>>["application"]>;
  const insert = (client: Client, row: Application) => client.query(
    "insert into manager_application_records(id,manager_user_id,row_data) values($1,$2,$3)", [row.id, owner, row]);
  const waitForLock = async (client: Client) => {
    const pid = (await client.query("select pg_backend_pid() pid")).rows[0].pid as number;
    return async () => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const result = await db.query("select wait_event_type from pg_stat_activity where pid=$1", [pid]);
        if (result.rows[0]?.wait_event_type === "Lock") return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error("Second transaction never reached the property lock wait.");
    };
  };

  it("allows exactly one last-bed winner after a verified concurrent lock wait", async () => {
    const { application, propertyId } = await fixture();
    await insert(db, application("base"));
    const a = await connect(), b = await connect(); const blocked = await waitForLock(b);
    try {
      await a.query("begin isolation level read committed"); await b.query("begin isolation level read committed");
      await insert(a, application("winner"));
      const waiting = insert(b, application("loser")).then(() => "succeeded", (error: { code: string }) => error.code);
      await blocked(); await a.query("commit");
      expect(await waiting).toBe("P4001"); await b.query("rollback");
      expect((await db.query("select count(*)::int n from manager_application_records where row_data->>'propertyId'=$1", [propertyId])).rows[0].n).toBe(2);
    } finally { await a.query("rollback"); await b.query("rollback"); }
  });

  it("aborts a stale repeatable-read snapshot instead of admitting a second resident", async () => {
    const { application } = await fixture(1);
    const a = await connect(), b = await connect(); const blocked = await waitForLock(b);
    try {
      await a.query("begin"); await b.query("begin isolation level repeatable read");
      await b.query("select count(*) from manager_application_records");
      await insert(a, application("winner"));
      const waiting = insert(b, application("loser")).then(() => "succeeded", (error: { code: string }) => error.code);
      await blocked(); await a.query("commit"); expect(await waiting).toBe("40001");
    } finally { await a.query("rollback"); await b.query("rollback"); }
  });

  it("rejects capacity reduction below committed occupancy", async () => {
    const { application, propertyId } = await fixture();
    await insert(db, application("a")); await insert(db, application("b"));
    await expect(db.query("update manager_property_records set property_data=jsonb_set(property_data,'{listingSubmission,rooms,0,occupancyCapacity}','1') where id=$1", [propertyId]))
      .rejects.toMatchObject({ code: "P4001" });
  });

  it("admits a spanning resident alongside two disjoint stays", async () => {
    const { application } = await fixture();
    await insert(db, application("first", "2030-10-01", "2030-10-15"));
    await insert(db, application("second", "2030-10-16", "2030-10-31"));
    await expect(insert(db, application("spanning"))).resolves.toBeDefined();
  });

  it("allows metadata UPSERT after a later block without admitting a new placement", async () => {
    const { application, propertyId } = await fixture(); const row = application("existing");
    await insert(db, row);
    await db.query("update manager_property_records set property_data=jsonb_set(property_data,'{listingSubmission,rooms,0,manualUnavailableRanges}',$2::jsonb) where id=$1",
      [propertyId, JSON.stringify([{ start: "2030-10-10", end: "2030-10-11" }])]);
    await expect(db.query("insert into manager_application_records(id,manager_user_id,row_data) values($1,$2,$3) on conflict(id) do update set row_data=excluded.row_data",
      [row.id, owner, { ...row, name: "Updated contact" }])).resolves.toBeDefined();
    await expect(insert(db, application("new"))).rejects.toMatchObject({ code: "P4001" });
  });

  it("commits extension dates together and leaves both records unchanged on refusal", async () => {
    const { application, propertyId } = await fixture(1);
    const row = application("resident", "2030-10-01", "2030-10-10");
    await insert(db, row); await insert(db, application("future", "2030-11-01", "2030-11-30"));
    const lease = { id: `lease-${propertyId}`, axisId: row.id, residentEmail: "resident@example.test",
      roomChoice: row.assignedRoomChoice, application: row.application };
    await db.query("insert into portal_lease_pipeline_records(id,manager_user_id,property_id,row_data,status) values($1,$2,$3,$4,$5)", [lease.id, owner, propertyId, lease, "signed"]);
    const extend = (end: string) => db.query("select commit_room_lease_extension($1,$2,$3,$4,$5,$6,$7)",
      [owner, row.id, row, lease.id, lease, { ...lease, application: { ...row.application, leaseEnd: end } }, end]);
    const dates = async () => (await db.query("select row_data#>>'{application,leaseEnd}' d from manager_application_records where id=$1 union all select row_data#>>'{application,leaseEnd}' from portal_lease_pipeline_records where id=$2", [row.id, lease.id])).rows.map((r: { d: string }) => r.d);
    await expect(extend("2030-11-20")).rejects.toMatchObject({ code: "P4001" });
    expect(await dates()).toEqual(["2030-10-10", "2030-10-10"]);
    await extend("2030-10-20"); expect(await dates()).toEqual(["2030-10-20", "2030-10-20"]);
  });

  it("rolls back the final renewal signature when its requested bed has been taken", async () => {
    const { application, propertyId } = await fixture(1);
    const row = application("renewing", "2030-10-01", "2030-10-31");
    await insert(db, row); await insert(db, application("next", "2030-11-01", "2030-11-30"));
    const lease = { id: `renewal-${propertyId}`, axisId: row.id, residentEmail: "resident@example.test",
      roomChoice: row.assignedRoomChoice, application: { leaseStart: "2030-11-01", leaseEnd: "2030-11-30" },
      pendingRenewal: { leaseStart: "2030-11-01", leaseEnd: "2030-11-30", leaseTerm: "1 month" },
      residentSignature: { name: "Resident", signedAtIso: "2030-09-01T00:00:00Z" }, managerSignature: null };
    await db.query("insert into portal_lease_pipeline_records(id,manager_user_id,property_id,row_data,status) values($1,$2,$3,$4,$5)", [lease.id, owner, propertyId, lease, "manager"]);
    await expect(db.query("update portal_lease_pipeline_records set row_data=$2 where id=$1", [lease.id,
      { ...lease, managerSignature: { name: "Manager", signedAtIso: "2030-09-02T00:00:00Z" } }]))
      .rejects.toMatchObject({ code: "P4001" });
    expect((await db.query("select row_data from portal_lease_pipeline_records where id=$1", [lease.id])).rows[0].row_data.managerSignature).toBeNull();
    expect((await db.query("select row_data from manager_application_records where id=$1", [row.id])).rows[0].row_data.application).toEqual(row.application);
  });

  it("does not finalize renewal dates for empty signature objects", async () => {
    const { application, propertyId } = await fixture(1); const row = application("unsigned");
    await insert(db, row);
    const lease = { id: `unsigned-${propertyId}`, axisId: row.id, residentEmail: "resident@example.test",
      roomChoice: row.assignedRoomChoice, application: { leaseStart: "2030-11-01", leaseEnd: "2030-11-30" },
      pendingRenewal: { leaseStart: "2030-11-01", leaseEnd: "2030-11-30", leaseTerm: "1 month" },
      residentSignature: {}, managerSignature: {} };
    await db.query("insert into portal_lease_pipeline_records(id,manager_user_id,property_id,row_data,status) values($1,$2,$3,$4,$5)", [lease.id, owner, propertyId, lease, "manager"]);
    expect((await db.query("select row_data from manager_application_records where id=$1", [row.id])).rows[0].row_data.application).toEqual(row.application);
  });

  it("reserves the renewed dates in the final signature transaction when capacity remains", async () => {
    const { application, propertyId } = await fixture(1); const row = application("renewing-success");
    await insert(db, row);
    const lease = { id: `renewal-success-${propertyId}`, axisId: row.id, residentEmail: "resident@example.test",
      roomChoice: row.assignedRoomChoice, application: { leaseStart: "2030-11-01", leaseEnd: "2030-11-30" },
      pendingRenewal: { leaseStart: "2030-11-01", leaseEnd: "2030-11-30", leaseTerm: "1 month" },
      residentSignature: { name: "Resident", signedAtIso: "2030-09-01T00:00:00Z" }, managerSignature: null };
    await db.query("insert into portal_lease_pipeline_records(id,manager_user_id,property_id,row_data,status) values($1,$2,$3,$4,$5)", [lease.id, owner, propertyId, lease, "manager"]);
    await db.query("update portal_lease_pipeline_records set row_data=$2 where id=$1", [lease.id,
      { ...lease, managerSignature: { name: "Manager", signedAtIso: "2030-09-02T00:00:00Z" } }]);
    const approved = (await db.query("select row_data from manager_application_records where id=$1", [row.id])).rows[0].row_data;
    expect(approved.application).toMatchObject({ leaseStart: "2030-11-01", leaseEnd: "2030-11-30" });
    expect(approved.manualResidentDetails).toMatchObject({ moveInDate: "2030-11-01", moveOutDate: "2030-11-30" });
    expect((await db.query("select row_data from portal_lease_pipeline_records where id=$1", [lease.id])).rows[0].row_data.managerSignature.name).toBe("Manager");
    await expect(insert(db, application("later-arrival", "2030-11-01", "2030-11-30"))).rejects.toMatchObject({ code: "P4001" });
    // Signing next month's renewal cannot vacate the still-committed current stay.
    await expect(insert(db, application("current-stay-arrival", "2030-10-15", "2030-10-20"))).rejects.toMatchObject({ code: "P4001" });
  });

  it("resets the old room's occupancy floor when transferring to a different room", async () => {
    const { application, propertyId } = await fixture(1);
    await db.query("update manager_property_records set property_data=jsonb_set(property_data,'{listingSubmission,rooms}',(property_data#>'{listingSubmission,rooms}') || $2::jsonb) where id=$1",
      [propertyId, JSON.stringify([{ id: "r2", name: "Room 2", occupancyCapacity: 1 }])]);
    const row = application("transferring", "2030-11-01", "2030-11-30");
    await insert(db, row);
    await db.query("update manager_application_records set occupancy_start='2030-10-01' where id=$1", [row.id]);
    await insert(db, { ...application("former-destination-resident"), assignedRoomChoice: `${propertyId}::r2` });
    await db.query("update manager_application_records set row_data=$2 where id=$1", [row.id,
      { ...row, assignedRoomChoice: `${propertyId}::r2` }]);
    expect((await db.query("select occupancy_start from manager_application_records where id=$1", [row.id])).rows[0].occupancy_start).toBeNull();
  });

  it("keeps the occupancy floor when only the room's equivalent alias changes", async () => {
    const { application } = await fixture(1); const row = application("room-alias", "2030-11-01", "2030-11-30");
    await insert(db, row);
    await db.query("update manager_application_records set occupancy_start='2030-10-01' where id=$1", [row.id]);
    await db.query("update manager_application_records set row_data=$2 where id=$1", [row.id, { ...row, assignedRoomChoice: "r" }]);
    expect((await db.query("select occupancy_start::text from manager_application_records where id=$1", [row.id])).rows[0].occupancy_start).toBe("2030-10-01");
    await expect(insert(db, application("overlapping-original-stay", "2030-10-15", "2030-10-20"))).rejects.toMatchObject({ code: "P4001" });
  });

  it("preserves the trusted occupancy floor when normalizing a legacy application ID", async () => {
    const { application } = await fixture(1);
    const row = { ...application("legacy", "2030-11-01", "2030-11-30"), id: "legacyfloor" };
    await insert(db, row);
    await db.query("update manager_application_records set occupancy_start='2030-10-01' where id=$1", [row.id]);
    const newId = "PROPLANE-LEGACYFLOOR";
    await db.query("select normalize_application_record_id($1,$2,$3)", [row.id,
      { row_data: row, manager_user_id: owner, resident_email: null, property_id: null, assigned_property_id: null },
      { id: newId, row_data: { ...row, id: newId }, manager_user_id: owner, resident_email: null, property_id: null, assigned_property_id: null }]);
    expect((await db.query("select occupancy_start::text from manager_application_records where id=$1", [newId])).rows[0].occupancy_start).toBe("2030-10-01");
    expect((await db.query("select id from manager_application_records where id=$1", [row.id])).rowCount).toBe(0);
    await expect(insert(db, application("overlapping-legacy-stay", "2030-10-15", "2030-10-20"))).rejects.toMatchObject({ code: "P4001" });
  });
});
