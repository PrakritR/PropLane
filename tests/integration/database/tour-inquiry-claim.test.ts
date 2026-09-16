/**
 * Real PostgreSQL evidence for the WS4(shared-avail) atomic claim guard.
 * Opt in against a disposable LOCAL cluster:
 *
 *   TOUR_CLAIM_TEST_PORT=55439 npx vitest run tests/integration/database/tour-inquiry-claim.test.ts
 *
 * `confirmTourInquiry` reads the pending-inquiry / planned-event singletons,
 * decides, then writes them back — a non-atomic read-modify-write. Two
 * co-managers approving the SAME pending request concurrently could both pass
 * their (stale) double-book check and both upsert, silently clobbering one
 * booking with the other even though both callers were told `ok: true`.
 * `tour_inquiry_claims` closes that: a primary-key INSERT can only ever leave
 * one row behind, so exactly one of two concurrent claims on the same
 * `inquiry_id` wins. This is the mechanism proof; the code-path mapping onto
 * `confirmTourInquiry`'s 409 result (including stale-claim recovery and
 * always releasing on exit) is covered by
 * `tests/unit/tour-inquiry-confirm-claim.test.ts`.
 *
 * The host is always 127.0.0.1; DATABASE_URL and PGHOST are never read. Creates
 * and drops only its own randomly named database, never the connection's
 * database or an existing schema. The local cluster must already contain the
 * Supabase roles anon/authenticated/service_role, and the connecting user must
 * have CREATEDB — same posture as the sibling shared-room-capacity test.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const configuredPort = process.env.TOUR_CLAIM_TEST_PORT;
const database = `tour_claim_test_${randomUUID().replaceAll("-", "")}`;
const claimant = "11111111-1111-4111-8111-111111111111";

describe.skipIf(!configuredPort)("tour_inquiry_claims PostgreSQL atomic guard", () => {
  let admin: Client;
  let db: Client;
  let created = false;
  const connections = new Set<Client>();
  const connect = async (name = database) => {
    const client = new Client({
      host: "127.0.0.1",
      port: Number(configuredPort),
      database: name,
      user: process.env.TOUR_CLAIM_TEST_USER || userInfo().username,
      password: process.env.TOUR_CLAIM_TEST_PASSWORD || "",
      connectionTimeoutMillis: 3_000,
      options: "-c statement_timeout=10000 -c lock_timeout=5000",
    });
    await client.connect();
    connections.add(client);
    return client;
  };

  beforeAll(async () => {
    if (
      !configuredPort ||
      !/^\d+$/.test(configuredPort) ||
      Number(configuredPort) < 1024 ||
      Number(configuredPort) > 65535
    ) {
      throw new Error("TOUR_CLAIM_TEST_PORT must explicitly name a local test cluster port (1024..65535).");
    }
    admin = await connect("postgres");
    const roles = await admin.query(
      "select rolname from pg_roles where rolname in ('anon','authenticated','service_role')",
    );
    if (roles.rowCount !== 3) {
      throw new Error("The local test cluster needs the existing Supabase roles anon/authenticated/service_role.");
    }
    await admin.query(`create database "${database}"`);
    created = true;
    db = await connect();
    await db.query(await readFile("supabase/migrations/20260916120000_tour_inquiry_claim_guard.sql", "utf8"));
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

  const claim = (client: Client, inquiryId: string) =>
    client
      .query("insert into public.tour_inquiry_claims (inquiry_id, claimed_by) values ($1, $2)", [inquiryId, claimant])
      .then(
        () => "won" as const,
        (error: { code?: string }) => (error.code === "23505" ? ("conflict" as const) : `error:${error.code}`),
      );

  it("lets exactly one of two concurrent claims on the SAME pending request win", async () => {
    const inquiryId = `inq-${randomUUID()}`;
    const a = await connect();
    const b = await connect();

    const [resultA, resultB] = await Promise.all([claim(a, inquiryId), claim(b, inquiryId)]);
    const outcomes = [resultA, resultB].sort();
    // One winner, one conflict — never two winners, never two conflicts.
    expect(outcomes).toEqual(["conflict", "won"]);

    const rows = await db.query("select count(*)::int n from public.tour_inquiry_claims where inquiry_id = $1", [
      inquiryId,
    ]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("does not block a concurrent claim on a DIFFERENT pending request", async () => {
    const inquiryA = `inq-${randomUUID()}`;
    const inquiryB = `inq-${randomUUID()}`;
    const a = await connect();
    const b = await connect();

    const [resultA, resultB] = await Promise.all([claim(a, inquiryA), claim(b, inquiryB)]);
    expect(resultA).toBe("won");
    expect(resultB).toBe("won");
  });

  it("allows re-claiming once the mutex row is released (confirmTourInquiry's finally)", async () => {
    const inquiryId = `inq-${randomUUID()}`;
    await db.query("insert into public.tour_inquiry_claims (inquiry_id, claimed_by) values ($1, $2)", [
      inquiryId,
      claimant,
    ]);
    const blocked = await claim(await connect(), inquiryId);
    expect(blocked).toBe("conflict");

    await db.query("delete from public.tour_inquiry_claims where inquiry_id = $1", [inquiryId]);
    const retried = await claim(await connect(), inquiryId);
    expect(retried).toBe("won");
  });
});
