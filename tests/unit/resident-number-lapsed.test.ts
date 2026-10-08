// PropLane Number, resident side: a number whose subscription has been lapsed (canceled / incomplete) for
// more than 30 days is queued for release on the existing release queue, the resident agent is silent while lapsed,
// and a later re-subscription can provision afresh.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDb, type Row } from "../helpers/fake-table-db";

vi.mock("server-only", () => ({}));

import { releaseLapsedResidentAgentNumbers } from "@/lib/resident-agent-number/release.server";

const NOW = new Date("2026-10-08T18:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

const number = (owner: string, extra: Row = {}): Row => ({
  id: `num-${owner}`, resident_user_id: owner, state: "ready", phone_number: "+12065550177", phone_number_sid: `PN-${owner}`, updated_at: ago(100), ...extra,
});
const sub = (owner: string, status: string, updatedDaysAgo: number, extra: Row = {}): Row => ({
  owner_user_id: owner, owner_role: "resident", status, updated_at: ago(updatedDaysAgo), stripe_subscription_id: `sub_${owner}`, ...extra,
});

/** The fake db plus the queue RPC: it mirrors queue_resident_agent_number_release (queue row + number disabled). */
function makeDb(seed: Record<string, Row[]>) {
  const db = createFakeDb({ vendor_work_identity_release_queue: [], ...seed });
  const rpc = vi.fn(async (name: string, args: { p_user_id: string }) => {
    if (name !== "queue_resident_agent_number_release") return { data: null, error: { message: "unknown rpc" } };
    const rows = db.tables.resident_agent_numbers!.filter((r) => r.resident_user_id === args.p_user_id && r.state !== "released" && r.phone_number_sid);
    for (const r of rows) {
      const key = `release-resident:${r.id}`;
      if (!db.tables.vendor_work_identity_release_queue!.some((q) => q.idempotency_key === key)) {
        db.tables.vendor_work_identity_release_queue!.push({ vendor_user_id: r.resident_user_id, identity_id: r.id, phone_number_sid: r.phone_number_sid, idempotency_key: key, state: "queued" });
      }
      if (r.state !== "disabled") Object.assign(r, { state: "disabled", sms_send_ready: false, sms_receive_ready: false });
    }
    return { data: rows.length, error: null };
  });
  return Object.assign(db, { rpc });
}
const asDb = (db: unknown) => db as SupabaseClient;

beforeEach(() => vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "1"));
afterEach(() => vi.unstubAllEnvs());

describe("releaseLapsedResidentAgentNumbers", () => {
  it("queues the release of a number lapsed more than 30 days, and only that one", async () => {
    const db = makeDb({
      resident_agent_numbers: [number("r-old"), number("r-recent"), number("r-active"), number("r-incomplete")],
      number_subscriptions: [sub("r-old", "canceled", 31), sub("r-recent", "canceled", 5), sub("r-active", "active", 90), sub("r-incomplete", "incomplete", 45)],
    });
    expect(await releaseLapsedResidentAgentNumbers(asDb(db), { now: NOW })).toEqual({ released: 2, failed: 0, kept: 0 });
    const queued = db.tables.vendor_work_identity_release_queue!.map((q) => q.phone_number_sid).sort();
    expect(queued).toEqual(["PN-r-incomplete", "PN-r-old"]);
    // The row is freed so a later subscription provisions afresh; the others are untouched.
    expect(db.tables.resident_agent_numbers!.map((r) => r.resident_user_id).sort()).toEqual(["r-active", "r-recent"]);
    expect(db.tables.resident_agent_numbers!.every((r) => r.state === "ready")).toBe(true);
  });

  it("is role-agnostic: a lapsed subscription recorded as a vendor's also releases that login's resident number", async () => {
    const db = makeDb({
      resident_agent_numbers: [number("both")],
      number_subscriptions: [sub("both", "canceled", 60, { owner_role: "vendor" })],
    });
    expect((await releaseLapsedResidentAgentNumbers(asDb(db), { now: NOW })).released).toBe(1);
  });

  it("past_due is still entitled and is never released, even with an old row", async () => {
    const db = makeDb({ resident_agent_numbers: [number("r-1")], number_subscriptions: [sub("r-1", "past_due", 90)] });
    expect(await releaseLapsedResidentAgentNumbers(asDb(db), { now: NOW })).toEqual({ released: 0, failed: 0, kept: 0 });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("a resident with no subscription row, or a number with no provider id, is left alone", async () => {
    const db = makeDb({
      resident_agent_numbers: [number("r-free"), number("r-nosid", { phone_number_sid: null })],
      number_subscriptions: [sub("r-nosid", "canceled", 90)],
    });
    expect(await releaseLapsedResidentAgentNumbers(asDb(db), { now: NOW })).toEqual({ released: 0, failed: 0, kept: 0 });
    expect(db.tables.vendor_work_identity_release_queue).toHaveLength(0);
  });

  it("a pile of old lapsed subscriptions that own no number cannot crowd a real one out", async () => {
    const lapsed = Array.from({ length: 60 }, (_, i) => sub(`ghost-${i}`, "canceled", 200 + i));
    const db = makeDb({ resident_agent_numbers: [number("r-real")], number_subscriptions: [...lapsed, sub("r-real", "canceled", 31)] });
    expect((await releaseLapsedResidentAgentNumbers(asDb(db), { now: NOW })).released).toBe(1);
  });

  it("running twice queues once (idempotent) and a failed queue write keeps the row for the next run", async () => {
    const db = makeDb({ resident_agent_numbers: [number("r-1")], number_subscriptions: [sub("r-1", "canceled", 40)] });
    await releaseLapsedResidentAgentNumbers(asDb(db), { now: NOW });
    await releaseLapsedResidentAgentNumbers(asDb(db), { now: NOW });
    expect(db.tables.vendor_work_identity_release_queue).toHaveLength(1);

    const failing = makeDb({ resident_agent_numbers: [number("r-2")], number_subscriptions: [sub("r-2", "canceled", 40)] });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    failing.rpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } } as never);
    expect(await releaseLapsedResidentAgentNumbers(asDb(failing), { now: NOW })).toEqual({ released: 0, failed: 1, kept: 0 });
    expect(failing.tables.resident_agent_numbers).toHaveLength(1);
    expect((await releaseLapsedResidentAgentNumbers(asDb(failing), { now: NOW })).released).toBe(1);
  });

  it("does nothing with the flag off", async () => {
    vi.stubEnv("NUMBER_SUBSCRIPTION_ENABLED", "");
    const db = makeDb({ resident_agent_numbers: [number("r-1")], number_subscriptions: [sub("r-1", "canceled", 90)] });
    expect(await releaseLapsedResidentAgentNumbers(asDb(db), { now: NOW })).toEqual({ released: 0, failed: 0, kept: 0 });
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
