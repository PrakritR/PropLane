/**
 * Real PostgreSQL evidence that a failing prospect burst is backed off and then
 * left terminal instead of retrying forever. Opt in only against a disposable
 * LOCAL cluster: PROSPECT_BURST_TEST_PORT=55441 npx vitest run
 * tests/integration/database/prospect-sms-burst-failure-cap.test.ts
 *
 * The test creates and drops one uniquely named database. It never reads or
 * writes DATABASE_URL, Supabase, staging, or production.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const configuredPort = process.env.PROSPECT_BURST_TEST_PORT;
const owner = "11111111-1111-4111-8111-111111111111";
const database = `prospect_burst_cap_${randomUUID().replaceAll("-", "")}`;

describe.skipIf(!configuredPort)("prospect burst failure cap", () => {
  let admin: Client;
  let db: Client;
  let created = false;
  const createdRoles: string[] = [];

  const connect = async (name: string) => {
    if (!configuredPort || !/^\d+$/.test(configuredPort) || Number(configuredPort) < 1024 || Number(configuredPort) > 65535) {
      throw new Error("PROSPECT_BURST_TEST_PORT must explicitly name a local test cluster port (1024..65535).");
    }
    const client = new Client({
      host: "127.0.0.1",
      port: Number(configuredPort),
      database: name,
      user: process.env.PROSPECT_BURST_TEST_USER || userInfo().username,
      password: process.env.PROSPECT_BURST_TEST_PASSWORD || "",
      connectionTimeoutMillis: 3_000,
    });
    await client.connect();
    return client;
  };

  beforeAll(async () => {
    admin = await connect("postgres");
    await admin.query(`create database "${database}"`);
    created = true;
    db = await connect(database);
    const roles = await db.query<{ rolname: string }>(
      "select rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role')",
    );
    const existing = new Set(roles.rows.map((row) => row.rolname));
    for (const role of ["anon", "authenticated", "service_role"]) {
      if (existing.has(role)) continue;
      await db.query(`create role ${role} noinherit`);
      createdRoles.push(role);
    }
    await db.query(`
      create extension if not exists pgcrypto;
      create schema auth;
      create table auth.users(id uuid primary key);
      insert into auth.users(id) values ('${owner}');
      create table public.sms_outbox(id uuid primary key default gen_random_uuid());
    `);
    for (const file of [
      "supabase/migrations/20260912143000_prospect_sms_bursts.sql",
      "supabase/migrations/20260924160000_prospect_sms_burst_failure_cap.sql",
    ]) {
      await db.query(await readFile(file, "utf8"));
    }
  });

  afterAll(async () => {
    await db?.end();
    if (created) await admin.query(`drop database if exists "${database}" with (force)`);
    for (const role of createdRoles) await admin.query(`drop role if exists ${role}`);
    await admin?.end();
  });

  const ingest = async (sid: string) => {
    const { rows } = await db.query(
      "select * from public.record_prospect_sms_ingress($1,$2,'+15550001111','twilio','Is it available?',null,1)",
      [sid, owner],
    );
    return rows[0] as { burst_id: string; revision: number };
  };
  const claimAndFail = async (burstId: string, revision: number) => {
    await db.query("update public.prospect_sms_bursts set due_at = now() - interval '1 second' where id = $1", [burstId]);
    const worker = `w-${randomUUID()}`;
    const claim = await db.query("select * from public.claim_prospect_sms_burst($1,$2,$3,120)", [burstId, revision, worker]);
    expect(claim.rows[0]?.claimed).toBe(true);
    const done = await db.query("select public.complete_prospect_sms_burst($1,$2,$3,'failed') as ok", [burstId, revision, worker]);
    expect(done.rows[0].ok).toBe(true);
    const { rows } = await db.query(
      "select status, failed_attempts, failed_revision, published_at, due_at = 'infinity' as terminal_due, extract(epoch from due_at - now()) as wait_s from public.prospect_sms_bursts where id = $1",
      [burstId],
    );
    return rows[0] as { status: string; failed_attempts: number; failed_revision: number; published_at: string | null; terminal_due: boolean; wait_s: number };
  };

  it("backs off 1, 2, 4, 8 minutes and leaves the revision terminal after the fifth failure", async () => {
    const { burst_id, revision } = await ingest(`SM-${randomUUID()}`);
    const states = [];
    for (let i = 0; i < 5; i += 1) states.push(await claimAndFail(burst_id, revision));

    expect(states.map((s) => s.failed_attempts)).toEqual([1, 2, 3, 4, 5]);
    expect(states.slice(0, 4).map((s) => s.status)).toEqual(["queued", "queued", "queued", "queued"]);
    expect(states.slice(0, 4).map((s) => Math.round(Number(s.wait_s) / 60))).toEqual([1, 2, 4, 8]);
    expect(states[4]!.status).toBe("failed");
    // The recovery sweep republishes only rows with no fresh publication.
    expect(states.every((state) => state.published_at === null)).toBe(true);
    // A terminal revision can never be claimed again, even by a late delivery.
    expect(states[4]!.terminal_due).toBe(true);
    const late = await db.query("select * from public.claim_prospect_sms_burst($1,$2,'w-late',120)", [burst_id, revision]);
    expect(late.rows[0]?.claimed ?? null).not.toBe(true);
  });

  it("starts the count over when the prospect texts again", async () => {
    const first = await ingest(`SM-${randomUUID()}`);
    await claimAndFail(first.burst_id, first.revision);
    const next = await ingest(`SM-${randomUUID()}`);

    expect(next.revision).toBe(first.revision + 1);
    const state = await claimAndFail(next.burst_id, next.revision);
    expect(state).toMatchObject({ status: "queued", failed_attempts: 1, failed_revision: next.revision, terminal_due: false });
  });

  it("clears the count when the revision succeeds", async () => {
    const { burst_id, revision } = await ingest(`SM-${randomUUID()}`);
    await claimAndFail(burst_id, revision);
    await db.query("update public.prospect_sms_bursts set due_at = now() - interval '1 second' where id = $1", [burst_id]);
    await db.query("select * from public.claim_prospect_sms_burst($1,$2,'w-ok',120)", [burst_id, revision]);
    await db.query("select public.complete_prospect_sms_burst($1,$2,'w-ok','dispatched')", [burst_id, revision]);

    const { rows } = await db.query("select status, failed_attempts, handled_revision from public.prospect_sms_bursts where id = $1", [burst_id]);
    expect(rows[0]).toMatchObject({ status: "dispatched", failed_attempts: 0, handled_revision: revision });
  });

  it("still refuses a superseded worker without counting a failure", async () => {
    const first = await ingest(`SM-${randomUUID()}`);
    await db.query("update public.prospect_sms_bursts set due_at = now() - interval '1 second' where id = $1", [first.burst_id]);
    await db.query("select * from public.claim_prospect_sms_burst($1,$2,'w-old',120)", [first.burst_id, first.revision]);
    await ingest(`SM-${randomUUID()}`);

    const done = await db.query("select public.complete_prospect_sms_burst($1,$2,'w-old','failed') as ok", [first.burst_id, first.revision]);
    expect(done.rows[0].ok).toBe(false);
    const { rows } = await db.query("select failed_attempts from public.prospect_sms_bursts where id = $1", [first.burst_id]);
    expect(rows[0].failed_attempts).toBe(0);
  });
});
