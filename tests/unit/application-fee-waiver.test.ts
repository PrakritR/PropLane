import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createApplicationFeeWaiverCode,
  isValidWaiverCodeFormat,
  listApplicationFeeWaiverCodes,
  listApplicationFeeWaiverRedemptions,
  normalizeWaiverCode,
  pickPrimaryApplicationFeeWaiverCode,
  redeemApplicationFeeWaiverCode,
  revokeApplicationFeeWaiverCode,
  setPrimaryApplicationFeeWaiverCode,
} from "@/lib/application-fee-waiver";

/**
 * In-memory fake covering exactly the two tables + one RPC the waiver lib
 * touches. `redeem_application_fee_waiver_code` is reimplemented here with
 * the SAME guard clauses as the real Postgres function
 * (`supabase/migrations/20260726190000_application_fee_waiver_codes.sql`) so
 * this test proves the application-level scoping AND the atomic redeem
 * contract, without a real database.
 */
function makeFakeDb() {
  let nextId = 0;
  const codes: Record<string, unknown>[] = [];
  const redemptions: Record<string, unknown>[] = [];

  function selectBuilder(rows: () => Record<string, unknown>[]) {
    const filters: ((r: Record<string, unknown>) => boolean)[] = [];
    const applied = () => rows().filter((r) => filters.every((f) => f(r)));
    const builder = {
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      async maybeSingle() {
        return { data: applied()[0] ?? null, error: null };
      },
      async single() {
        const found = applied()[0];
        return found ? { data: found, error: null } : { data: null, error: { message: "No rows found" } };
      },
      then(resolve: (v: { data: unknown; error: null }) => void) {
        resolve({ data: applied(), error: null });
      },
    };
    return builder;
  }

  const codesTable = {
    insert(payload: Record<string, unknown>) {
      return {
        select() {
          return {
            async single() {
              const dup = codes.find(
                (c) => c.manager_user_id === payload.manager_user_id && c.code_normalized === payload.code_normalized,
              );
              if (dup) return { data: null, error: { code: "23505", message: "duplicate key" } };
              const row = {
                id: `code_${++nextId}`,
                status: "active",
                used_count: 0,
                max_uses: null,
                expires_at: null,
                revoked_at: null,
                label: null,
                created_at: new Date().toISOString(),
                ...payload,
              };
              codes.push(row);
              return { data: row, error: null };
            },
          };
        },
      };
    },
    select() {
      return selectBuilder(() => codes);
    },
    update(payload: Record<string, unknown>) {
      const filters: ((r: Record<string, unknown>) => boolean)[] = [];
      const builder = {
        eq(col: string, val: unknown) {
          filters.push((r) => r[col] === val);
          return builder;
        },
        select() {
          return {
            async maybeSingle() {
              const row = codes.find((r) => filters.every((f) => f(r)));
              if (!row) return { data: null, error: null };
              Object.assign(row, payload);
              return { data: { id: row.id }, error: null };
            },
          };
        },
      };
      return builder;
    },
  };

  const redemptionsTable = {
    insert(payload: Record<string, unknown>) {
      redemptions.push({ id: `red_${++nextId}`, redeemed_at: new Date().toISOString(), ...payload });
      return Promise.resolve({ data: null, error: null });
    },
    select() {
      return selectBuilder(() => redemptions);
    },
  };

  async function rpc(name: string, args: Record<string, unknown>) {
    if (name !== "redeem_application_fee_waiver_code") throw new Error(`Unexpected rpc ${name}`);
    const row = codes.find((c) => c.id === args.p_code_id && c.manager_user_id === args.p_manager_user_id);
    const now = Date.now();
    const active = row && row.status === "active";
    const notExpired = !row?.expires_at || Date.parse(String(row.expires_at)) > now;
    const underCap = !row?.max_uses || Number(row.used_count) < Number(row.max_uses);
    if (!row || !active || !notExpired || !underCap) {
      return { data: [], error: null };
    }
    row.used_count = Number(row.used_count) + 1;
    redemptions.push({
      id: `red_${++nextId}`,
      code_id: row.id,
      manager_user_id: args.p_manager_user_id,
      property_id: args.p_property_id,
      resident_email: args.p_resident_email,
      application_id: args.p_application_id,
      redeemed_at: new Date().toISOString(),
    });
    return { data: [{ id: row.id }], error: null };
  }

  const from = (table: string) => (table === "manager_application_fee_waiver_codes" ? codesTable : redemptionsTable);
  return { db: { from, rpc } as unknown as SupabaseClient, codes, redemptions };
}

describe("normalizeWaiverCode / isValidWaiverCodeFormat", () => {
  it("uppercases and strips whitespace", () => {
    expect(normalizeWaiverCode(" free100 ")).toBe("FREE100");
    expect(normalizeWaiverCode("free 100")).toBe("FREE100");
  });

  it("rejects codes outside the allowed shape", () => {
    expect(isValidWaiverCodeFormat("ab")).toBe(false); // too short
    expect(isValidWaiverCodeFormat("FREE$100")).toBe(false); // bad char
    expect(isValidWaiverCodeFormat("FREE-100")).toBe(true);
  });
});

describe("createApplicationFeeWaiverCode", () => {
  it("creates a reusable, unlimited code by default", async () => {
    const { db } = makeFakeDb();
    const result = await createApplicationFeeWaiverCode(db, "mgr_A", { label: "Promo" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code.maxUses).toBeNull();
      expect(result.code.status).toBe("active");
      expect(result.code.managerUserId).toBe("mgr_A");
    }
  });

  it("rejects a duplicate code for the SAME manager", async () => {
    const { db } = makeFakeDb();
    await createApplicationFeeWaiverCode(db, "mgr_A", { code: "FREE100" });
    const dup = await createApplicationFeeWaiverCode(db, "mgr_A", { code: "FREE100" });
    expect(dup.ok).toBe(false);
  });

  it("allows two DIFFERENT managers to use the same code text", async () => {
    const { db } = makeFakeDb();
    const a = await createApplicationFeeWaiverCode(db, "mgr_A", { code: "FREE100" });
    const b = await createApplicationFeeWaiverCode(db, "mgr_B", { code: "FREE100" });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it("rejects a non-positive maxUses", async () => {
    const { db } = makeFakeDb();
    const result = await createApplicationFeeWaiverCode(db, "mgr_A", { maxUses: 0 });
    expect(result.ok).toBe(false);
  });

  it("rejects an expiry in the past", async () => {
    const { db } = makeFakeDb();
    const result = await createApplicationFeeWaiverCode(db, "mgr_A", { expiresAt: "2020-01-01T00:00:00.000Z" });
    expect(result.ok).toBe(false);
  });
});

describe("listApplicationFeeWaiverCodes / revokeApplicationFeeWaiverCode — manager scoping", () => {
  it("only lists the calling manager's own codes", async () => {
    const { db } = makeFakeDb();
    await createApplicationFeeWaiverCode(db, "mgr_A", { code: "AAA111" });
    await createApplicationFeeWaiverCode(db, "mgr_B", { code: "BBB222" });
    const listA = await listApplicationFeeWaiverCodes(db, "mgr_A");
    expect(listA.map((c) => c.code)).toEqual(["AAA111"]);
  });

  it("a manager cannot revoke ANOTHER manager's code", async () => {
    const { db } = makeFakeDb();
    const created = await createApplicationFeeWaiverCode(db, "mgr_A", { code: "AAA111" });
    if (!created.ok) throw new Error("setup failed");
    const result = await revokeApplicationFeeWaiverCode(db, "mgr_B", created.code.id);
    expect(result.ok).toBe(false);
    const stillActive = await listApplicationFeeWaiverCodes(db, "mgr_A");
    expect(stillActive[0]?.status).toBe("active");
  });

  it("a manager can revoke their OWN code", async () => {
    const { db } = makeFakeDb();
    const created = await createApplicationFeeWaiverCode(db, "mgr_A", { code: "AAA111" });
    if (!created.ok) throw new Error("setup failed");
    const result = await revokeApplicationFeeWaiverCode(db, "mgr_A", created.code.id);
    expect(result.ok).toBe(true);
    const list = await listApplicationFeeWaiverCodes(db, "mgr_A");
    expect(list[0]?.status).toBe("revoked");
  });
});

describe("redeemApplicationFeeWaiverCode — the security-critical path", () => {
  let db: SupabaseClient;

  beforeEach(() => {
    db = makeFakeDb().db;
  });

  it("redeems a valid code and records the redemption for that application", async () => {
    const created = await createApplicationFeeWaiverCode(db, "mgr_A", { code: "FREE100" });
    if (!created.ok) throw new Error("setup failed");

    const result = await redeemApplicationFeeWaiverCode(db, {
      managerUserId: "mgr_A",
      propertyId: "prop_1",
      residentEmail: "applicant@example.com",
      applicationId: "app_1",
      code: "free100",
    });
    expect(result.ok).toBe(true);

    const redemptions = await listApplicationFeeWaiverRedemptions(db, "mgr_A");
    expect(redemptions).toHaveLength(1);
    expect(redemptions[0]).toMatchObject({
      propertyId: "prop_1",
      residentEmail: "applicant@example.com",
      applicationId: "app_1",
    });
  });

  it("does not spend a lease-only code on an application's fee", async () => {
    const created = await createApplicationFeeWaiverCode(db, "mgr_A", {
      code: "LEASEONLY", appliesTo: "lease",
    });
    if (!created.ok) throw new Error("setup failed");
    const result = await redeemApplicationFeeWaiverCode(db, {
      managerUserId: "mgr_A", propertyId: "prop_1",
      residentEmail: "applicant@example.com", applicationId: "app_1", code: "LEASEONLY",
    });
    expect(result.ok).toBe(false);
    const rows = await listApplicationFeeWaiverRedemptions(db, "mgr_A");
    expect(rows).toHaveLength(0);
  });

  it("REJECTS one manager's code when redeemed against a DIFFERENT manager (cross-manager isolation)", async () => {
    // mgr_A owns FREE100. An applicant applying to mgr_B's property tries the
    // same code text — this must never waive mgr_B's fee.
    const created = await createApplicationFeeWaiverCode(db, "mgr_A", { code: "FREE100" });
    if (!created.ok) throw new Error("setup failed");

    const result = await redeemApplicationFeeWaiverCode(db, {
      managerUserId: "mgr_B",
      propertyId: "prop_other_manager",
      residentEmail: "applicant@example.com",
      code: "FREE100",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("NOT_FOUND");

    // And mgr_A's own usage count must be untouched by the failed cross-tenant attempt.
    const codesForA = await listApplicationFeeWaiverCodes(db, "mgr_A");
    expect(codesForA[0]?.usedCount).toBe(0);
    const redemptionsForB = await listApplicationFeeWaiverRedemptions(db, "mgr_B");
    expect(redemptionsForB).toHaveLength(0);
  });

  it("rejects a revoked code", async () => {
    const created = await createApplicationFeeWaiverCode(db, "mgr_A", { code: "FREE100" });
    if (!created.ok) throw new Error("setup failed");
    await revokeApplicationFeeWaiverCode(db, "mgr_A", created.code.id);

    const result = await redeemApplicationFeeWaiverCode(db, {
      managerUserId: "mgr_A",
      propertyId: "prop_1",
      residentEmail: "applicant@example.com",
      code: "FREE100",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("REVOKED");
  });

  it("rejects an expired code", async () => {
    // createApplicationFeeWaiverCode refuses a past expiry, so create one that
    // expires almost immediately and let it lapse before redeeming.
    const created = await createApplicationFeeWaiverCode(db, "mgr_A", {
      code: "FREE100",
      expiresAt: new Date(Date.now() + 20).toISOString(),
    });
    if (!created.ok) throw new Error("setup failed");

    await new Promise((resolve) => setTimeout(resolve, 40));

    const result = await redeemApplicationFeeWaiverCode(db, {
      managerUserId: "mgr_A",
      propertyId: "prop_1",
      residentEmail: "applicant@example.com",
      code: "FREE100",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("EXPIRED");
  });

  it("rejects once a usage cap is reached and never partially applies", async () => {
    const created = await createApplicationFeeWaiverCode(db, "mgr_A", { code: "ONEUSE", maxUses: 1 });
    if (!created.ok) throw new Error("setup failed");

    const first = await redeemApplicationFeeWaiverCode(db, {
      managerUserId: "mgr_A",
      propertyId: "prop_1",
      residentEmail: "first@example.com",
      code: "ONEUSE",
    });
    expect(first.ok).toBe(true);

    const second = await redeemApplicationFeeWaiverCode(db, {
      managerUserId: "mgr_A",
      propertyId: "prop_1",
      residentEmail: "second@example.com",
      code: "ONEUSE",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("EXHAUSTED");

    const redemptions = await listApplicationFeeWaiverRedemptions(db, "mgr_A");
    expect(redemptions).toHaveLength(1);
  });

  it("rejects an unknown code", async () => {
    const result = await redeemApplicationFeeWaiverCode(db, {
      managerUserId: "mgr_A",
      propertyId: "prop_1",
      residentEmail: "applicant@example.com",
      code: "NOPE",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("NOT_FOUND");
  });
});

describe("pickPrimaryApplicationFeeWaiverCode / setPrimaryApplicationFeeWaiverCode", () => {
  it("picks the oldest active code as primary", () => {
    const older = {
      id: "1",
      managerUserId: "mgr_A",
      code: "OLD",
      label: null,
      status: "active" as const,
      maxUses: null,
      usedCount: 0,
      expiresAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      revokedAt: null,
    };
    const newer = { ...older, id: "2", code: "NEW", createdAt: "2026-06-01T00:00:00.000Z" };
    expect(pickPrimaryApplicationFeeWaiverCode([newer, older])?.code).toBe("OLD");
    expect(pickPrimaryApplicationFeeWaiverCode([{ ...older, status: "revoked" }])).toBeNull();
  });

  it("creates one unlimited primary code and revokes extras when the text changes", async () => {
    const { db } = makeFakeDb();
    await createApplicationFeeWaiverCode(db, "mgr_A", { code: "ALPHA" });
    await createApplicationFeeWaiverCode(db, "mgr_A", { code: "BETA" });

    const set = await setPrimaryApplicationFeeWaiverCode(db, "mgr_A", "GAMMA");
    expect(set.ok).toBe(true);
    if (set.ok) expect(set.code?.code).toBe("GAMMA");

    const codes = await listApplicationFeeWaiverCodes(db, "mgr_A");
    const active = codes.filter((c) => c.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0]?.code).toBe("GAMMA");
  });

  it("clears all active codes when primary is empty", async () => {
    const { db } = makeFakeDb();
    await createApplicationFeeWaiverCode(db, "mgr_A", { code: "KEEPME" });
    const cleared = await setPrimaryApplicationFeeWaiverCode(db, "mgr_A", "");
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.code).toBeNull();
    const codes = await listApplicationFeeWaiverCodes(db, "mgr_A");
    expect(codes.every((c) => c.status === "revoked")).toBe(true);
  });
});
