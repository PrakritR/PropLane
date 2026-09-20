import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const release = vi.hoisted(() => vi.fn());
vi.mock("@/lib/twilio-provisioning", () => ({ releaseTwilioNumber: release }));
import { reconcileVendorWorkIdentityReleases, releaseQueuedVendorWorkIdentities } from "@/lib/vendor-work-identity-release.server";

beforeEach(() => vi.clearAllMocks());

function db(rows: Array<{ id: string; phone_number_sid: string | null }>) {
  const writes: unknown[] = [];
  const q: Record<string, unknown> = {};
  q.update = (value: unknown) => { writes.push(value); return q; };
  q.eq = () => q;
  return {
    db: {
      rpc: vi.fn().mockResolvedValue({ data: rows, error: null }),
      from: vi.fn(() => q),
    } as unknown as SupabaseClient,
    writes,
  };
}

describe("vendor work identity release worker", () => {
  it("uses the atomic SQL claim and confirms a release once", async () => {
    release.mockResolvedValue(true);
    const x = db([{ id: "release-1", identity_id: "identity-1", phone_number_sid: "PN1" }]);
    await expect(releaseQueuedVendorWorkIdentities(x.db)).resolves.toEqual({ released: 1, failed: 0 });
    expect((x.db.rpc as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("claim_vendor_work_identity_releases", { p_limit: 20 });
    expect(release).toHaveBeenCalledTimes(1);
    expect(x.writes).toContainEqual(expect.objectContaining({ state: "released" }));
    expect(x.writes).toContainEqual(expect.objectContaining({ lifecycle_state: "released" }));
  });

  it("quarantines an ambiguous provider result instead of retrying the SID", async () => {
    release.mockResolvedValue(false);
    const x = db([{ id: "release-1", phone_number_sid: "PN1" }]);
    await expect(releaseQueuedVendorWorkIdentities(x.db)).resolves.toEqual({ released: 0, failed: 1 });
    expect(x.writes).toContainEqual(expect.objectContaining({ state: "reconciling" }));
  });

  it("never marks the queue released when the surviving identity update fails", async () => {
    release.mockResolvedValue(true);
    const writes: Array<{ table: string; value: Record<string, unknown> }> = [];
    const failingDb = {
      rpc: vi.fn().mockResolvedValue({ data: [{ id: "release-1", identity_id: "identity-1", phone_number_sid: "PN1" }], error: null }),
      from: (table: string) => {
        const q: Record<string, unknown> = {};
        q.update = (value: Record<string, unknown>) => { writes.push({ table, value }); return q; };
        q.eq = () => q;
        q.then = (resolve: (value: unknown) => unknown) => resolve({ error: table === "vendor_work_identities" ? { message: "identity unavailable" } : null });
        return q;
      },
    } as unknown as SupabaseClient;
    await expect(releaseQueuedVendorWorkIdentities(failingDb)).resolves.toEqual({ released: 0, failed: 1 });
    expect(writes).not.toContainEqual(expect.objectContaining({ table: "vendor_work_identity_release_queue", value: expect.objectContaining({ state: "released" }) }));
    expect(writes).toContainEqual(expect.objectContaining({ table: "vendor_work_identity_release_queue", value: expect.objectContaining({ state: "reconciling" }) }));
  });

  it("counts a terminal queue update error as failed and keeps it reconciling", async () => {
    release.mockResolvedValue(true);
    const writes: Array<{ table: string; value: Record<string, unknown> }> = [];
    const failingDb = {
      rpc: vi.fn().mockResolvedValue({ data: [{ id: "release-1", identity_id: null, phone_number_sid: "PN1" }], error: null }),
      from: (table: string) => {
        const q: Record<string, unknown> = {};
        q.update = (value: Record<string, unknown>) => { writes.push({ table, value }); return q; };
        q.eq = () => q;
        q.then = (resolve: (value: unknown) => unknown) => resolve({ error: (q as { value?: Record<string, unknown> }).value?.state === "released" ? { message: "queue unavailable" } : null });
        const originalUpdate = q.update as (value: Record<string, unknown>) => unknown;
        q.update = (value: Record<string, unknown>) => { (q as { value?: Record<string, unknown> }).value = value; return originalUpdate(value) as typeof q; };
        return q;
      },
    } as unknown as SupabaseClient;
    await expect(releaseQueuedVendorWorkIdentities(failingDb)).resolves.toEqual({ released: 0, failed: 1 });
    expect(writes).toContainEqual(expect.objectContaining({ value: expect.objectContaining({ state: "reconciling" }) }));
  });
});

function reconcileDb(rows: Array<{ id: string; identity_id: string | null; phone_number_sid: string | null }>) {
  const writes: Array<{ table: string; value: unknown }> = [];
  const from = vi.fn((table: string) => {
    const q: Record<string, unknown> = {};
    q.select = () => q; q.eq = () => q; q.order = () => q; q.limit = () => Promise.resolve({ data: rows, error: null });
    q.update = (value: unknown) => { writes.push({ table, value }); return q; };
    return q;
  });
  return { db: { from } as unknown as SupabaseClient, writes };
}

describe("vendor work identity release reconciliation", () => {
  it.each([
    ["absent", { released: 1, quarantined: 0, unavailable: 0 }, "released"],
    ["owned", { released: 0, quarantined: 1, unavailable: 0 }, "failed"],
    ["unavailable", { released: 0, quarantined: 0, unavailable: 1 }, undefined],
  ] as const)("handles %s provider inspection without another remove", async (state, expected, queueState) => {
    const x = reconcileDb([{ id: "release-1", identity_id: "identity-1", phone_number_sid: "PN1" }]);
    await expect(reconcileVendorWorkIdentityReleases(x.db, 20, async () => state)).resolves.toEqual(expected);
    if (queueState) expect(x.writes).toContainEqual(expect.objectContaining({ table: "vendor_work_identity_release_queue", value: expect.objectContaining({ state: queueState }) }));
    expect(release).not.toHaveBeenCalled();
  });

  it("fails before a terminal queue write when the surviving identity update errors", async () => {
    const writes: Array<{ table: string; value: Record<string, unknown> }> = [];
    const failingDb = {
      from: (table: string) => {
        const q: Record<string, unknown> = {};
        q.select = () => q; q.eq = () => q; q.order = () => q;
        q.limit = () => Promise.resolve({ data: [{ id: "release-1", identity_id: "identity-1", phone_number_sid: "PN1" }], error: null });
        q.update = (value: Record<string, unknown>) => { writes.push({ table, value }); return q; };
        q.then = (resolve: (value: unknown) => unknown) => resolve({ error: table === "vendor_work_identities" ? { message: "identity unavailable" } : null });
        return q;
      },
    } as unknown as SupabaseClient;
    await expect(reconcileVendorWorkIdentityReleases(failingDb, 20, async () => "absent")).rejects.toThrow("identity unavailable");
    expect(writes).not.toContainEqual(expect.objectContaining({ table: "vendor_work_identity_release_queue", value: expect.objectContaining({ state: "released" }) }));
  });

  it("throws when reconciliation cannot persist a terminal queue release", async () => {
    const failingDb = {
      from: (table: string) => {
        const q: Record<string, unknown> = {};
        q.select = () => q; q.eq = () => q; q.order = () => q;
        q.limit = () => Promise.resolve({ data: [{ id: "release-1", identity_id: null, phone_number_sid: "PN1" }], error: null });
        q.update = () => q;
        q.then = (resolve: (value: unknown) => unknown) => resolve({ error: table === "vendor_work_identity_release_queue" ? { message: "queue unavailable" } : null });
        return q;
      },
    } as unknown as SupabaseClient;
    await expect(reconcileVendorWorkIdentityReleases(failingDb, 20, async () => "absent")).rejects.toThrow("queue unavailable");
  });
});
