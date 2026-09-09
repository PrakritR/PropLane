import { describe, it, expect, afterEach, vi } from "vitest";
import {
  filterOverdueCharges,
  findOwnedOverdueCharge,
  buildRentReminderPreview,
} from "@/lib/tools/domains/payments-logic";
import { executeSendRentReminder, getOverdueChargesTool } from "@/lib/tools/domains/payments";
import type { AgentContext } from "@/lib/tools/context";
import type { HouseholdCharge } from "@/lib/household-charges";

/**
 * These tests pin the security-critical guarantee from the review: the agent's
 * gated send must re-resolve the charge from the manager's own data by id and
 * never honor a client- or model-supplied target. They run as pure logic with
 * no database, SDK, or network.
 */

function charge(overrides: Partial<HouseholdCharge> = {}): HouseholdCharge {
  return {
    id: "hc_test_1",
    createdAt: "2024-01-01T00:00:00.000Z",
    residentEmail: "Resident@Example.com",
    residentName: "Pat Resident",
    residentUserId: null,
    propertyId: "prop_1",
    propertyLabel: "12 Main St",
    managerUserId: "manager_a",
    kind: "rent",
    title: "Monthly rent",
    amountLabel: "$1,500.00",
    balanceLabel: "$1,500.00",
    status: "pending",
    blocksLeaseUntilPaid: false,
    // Past, non-recurring due date so isHouseholdChargeOverdue resolves overdue.
    dueDateLabel: "Jan 1, 2020",
    ...overrides,
  };
}

describe("filterOverdueCharges", () => {
  it("keeps only overdue, unpaid charges", () => {
    const overdue = charge({ id: "overdue" });
    const paid = charge({ id: "paid", status: "paid" });
    const future = charge({ id: "future", dueDateLabel: "Jan 1, 2999" });
    const result = filterOverdueCharges([overdue, paid, future]);
    expect(result.map((c) => c.id)).toEqual(["overdue"]);
  });
});

describe("findOwnedOverdueCharge (write-gating)", () => {
  const managerCharges = [
    charge({ id: "mine_overdue" }),
    charge({ id: "mine_paid", status: "paid" }),
  ];

  it("returns the charge when it is in the manager's own overdue set", () => {
    expect(findOwnedOverdueCharge(managerCharges, "mine_overdue")?.id).toBe("mine_overdue");
  });

  it("rejects a chargeId that belongs to another landlord (cross-tenant)", () => {
    // The other landlord's charge is simply not present in this manager's set.
    expect(findOwnedOverdueCharge(managerCharges, "landlord_b_charge")).toBeNull();
  });

  it("rejects a charge the manager owns but that is not overdue", () => {
    expect(findOwnedOverdueCharge(managerCharges, "mine_paid")).toBeNull();
  });

  it("rejects empty or whitespace ids", () => {
    expect(findOwnedOverdueCharge(managerCharges, "")).toBeNull();
    expect(findOwnedOverdueCharge(managerCharges, "   ")).toBeNull();
  });
});

/**
 * In-memory stand-in for the service-role Supabase client used by
 * executeSendRentReminder. It models only what the executor touches, including
 * the partial UNIQUE behavior of dedupe_key (NULLs never collide), so the
 * same-day idempotency and failed-send retry paths are exercised end to end.
 */
type AuditRow = Record<string, unknown> & { dedupe_key: string | null };

function makeFakeDb(charges: HouseholdCharge[]) {
  const auditLog: AuditRow[] = [];
  const inboxThreads: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      return {
        select() {
          // Self-chaining thenable builder: the charge loader ends in
          // `.range()`, while the inbox thread lookup chains several `.eq()`s
          // and awaits `.limit()` directly — both must resolve.
          type Chain = {
            eq: (col: string, val: unknown) => Chain;
            order: (col: string, opts?: unknown) => Chain;
            limit: (n: number) => Promise<{ data: unknown[]; error: null }> | Chain;
            maybeSingle: () => Promise<{ data: unknown | null; error: null }>;
            range: (from: number, to: number) => Promise<{ data: unknown[]; error: null }>;
            then: (onFulfilled: (v: { data: unknown[]; error: null }) => unknown) => unknown;
          };
          const inboxData = () =>
            table === "portal_inbox_thread_records" ? inboxThreads.map((r) => ({ ...r })) : [];
          const builder: Chain = {
            eq: () => builder,
            order: () => builder,
            limit: async () => ({ data: inboxData(), error: null }),
            maybeSingle: async () => ({ data: null, error: null }),
            range: async (from: number, to: number) => {
              if (table === "portal_household_charge_records") {
                const page = charges.slice(from, to + 1).map((c) => ({ row_data: c }));
                return { data: page, error: null };
              }
              return { data: [], error: null };
            },
            then: (onFulfilled) => onFulfilled({ data: inboxData(), error: null }),
          };
          return builder;
        },
        insert: async (row: AuditRow) => {
          if (table === "audit_log") {
            if (row.dedupe_key != null && auditLog.some((r) => r.dedupe_key === row.dedupe_key)) {
              return { error: { code: "23505", message: "duplicate key value" } };
            }
            auditLog.push({ ...row });
          }
          return { error: null };
        },
        upsert: async (row: Record<string, unknown>) => {
          if (table === "portal_inbox_thread_records") {
            const existing = inboxThreads.find((r) => r.id === row.id);
            if (existing) Object.assign(existing, row);
            else inboxThreads.push({ ...row });
          }
          return { error: null };
        },
        update(vals: Partial<AuditRow>) {
          return {
            eq: async (col: string, val: unknown) => {
              for (const r of auditLog) {
                if (r[col] === val) Object.assign(r, vals);
              }
              return { error: null };
            },
          };
        },
      };
    },
  };
  return { db, auditLog, inboxThreads };
}

function makeCtx(charges: HouseholdCharge[]) {
  const { db, auditLog, inboxThreads } = makeFakeDb(charges);
  const ctx = {
    landlordId: "manager_a",
    userId: "manager_a",
    email: "manager@axis.test",
    roles: ["manager"],
    isAdmin: false,
    db,
  } as unknown as AgentContext;
  return { ctx, auditLog, inboxThreads };
}

describe("executeSendRentReminder (same-day dedupe)", () => {
  const ORIGINAL_RESEND_KEY = process.env.RESEND_API_KEY;

  afterEach(() => {
    vi.restoreAllMocks();
    if (ORIGINAL_RESEND_KEY === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = ORIGINAL_RESEND_KEY;
  });

  it("does not block a same-day retry after an email_failed send", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const { ctx, auditLog } = makeCtx([
      charge({ id: "hc_fail", residentEmail: "tenant@external.com" }),
    ]);

    const first = await executeSendRentReminder(ctx, "hc_fail");
    expect(first).toMatchObject({ ok: true, delivery: { email: "failed", portal: "skipped", sms: "skipped" } });
    // The failed attempt's dedupe key is cleared so it cannot block a retry.
    expect(auditLog).toHaveLength(1);
    expect(auditLog[0].dedupe_key).toBeNull();

    const second = await executeSendRentReminder(ctx, "hc_fail");
    expect(second).toMatchObject({ ok: true, delivery: { email: "failed", portal: "skipped", sms: "skipped" } });
    expect(second).not.toMatchObject({ alreadySent: true });
    expect(auditLog).toHaveLength(2);
  });

  it("does not record a 'sent' inbox thread when delivery fails", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const { ctx, auditLog, inboxThreads } = makeCtx([
      charge({ id: "hc_fail", residentEmail: "tenant@external.com" }),
    ]);

    // Two same-day failed attempts must leave the Sent folder empty and never
    // accumulate duplicate "sent" threads.
    await executeSendRentReminder(ctx, "hc_fail");
    await executeSendRentReminder(ctx, "hc_fail");
    expect(inboxThreads).toHaveLength(0);
    expect(auditLog).toHaveLength(2);
    for (const row of auditLog) {
      expect((row.result_summary as { delivery: { portal: string } }).delivery.portal).toBe("skipped");
    }
  });

  it("blocks a duplicate same-day send after a successful email (emailed)", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    const { ctx, auditLog, inboxThreads } = makeCtx([
      charge({ id: "hc_ok", residentEmail: "tenant@external.com" }),
    ]);

    const first = await executeSendRentReminder(ctx, "hc_ok");
    expect(first).toMatchObject({ ok: true, delivery: { email: "sent", portal: "skipped", sms: "skipped" } });
    // A portal inbox requires a resident account; an email-only external address
    // never becomes a manager-side pseudo-Sent thread.
    expect(inboxThreads).toHaveLength(0);

    const second = await executeSendRentReminder(ctx, "hc_ok");
    expect(second).toMatchObject({ ok: true, alreadySent: true });
    expect(auditLog).toHaveLength(1);
    expect(inboxThreads).toHaveLength(0);
  });

  it("blocks a duplicate same-day send for portal_only delivery", async () => {
    delete process.env.RESEND_API_KEY;
    const { ctx, auditLog, inboxThreads } = makeCtx([
      charge({ id: "hc_portal", residentEmail: "tenant@axis.local" }),
    ]);

    const first = await executeSendRentReminder(ctx, "hc_portal");
    expect(first).toMatchObject({ ok: true, delivery: { email: "skipped", portal: "skipped", sms: "skipped" } });
    // No address or account can receive a default channel, so a same-day retry remains possible.
    expect(inboxThreads).toHaveLength(0);

    const second = await executeSendRentReminder(ctx, "hc_portal");
    expect(second).not.toMatchObject({ alreadySent: true });
    expect(auditLog).toHaveLength(2);
    expect(inboxThreads).toHaveLength(0);
  });
});

describe("get_overdue_charges (no truncation)", () => {
  it("loads every overdue charge across multiple pages, not just the first 1000", async () => {
    // More than one page (page size is 1000) of overdue charges. A capped,
    // single-page read would silently drop the overflow and hide late tenants.
    const charges = Array.from({ length: 2300 }, (_, i) =>
      charge({ id: `hc_${i}`, residentEmail: `t${i}@external.com` }),
    );
    const { ctx } = makeCtx(charges);

    const result = (await getOverdueChargesTool.handler(ctx, {})) as {
      count: number;
      charges: { chargeId: string }[];
    };

    expect(result.count).toBe(2300);
    expect(new Set(result.charges.map((c) => c.chargeId)).size).toBe(2300);
  });
});

describe("buildRentReminderPreview", () => {
  it("derives every outbound field from the charge record, normalizing email", () => {
    const preview = buildRentReminderPreview(charge({ id: "c1" }));
    expect(preview).toMatchObject({
      chargeId: "c1",
      residentName: "Pat Resident",
      residentEmail: "resident@example.com",
      chargeTitle: "Monthly rent",
      balanceDue: "$1,500.00",
      propertyLabel: "12 Main St",
    });
  });

  it("degrades gracefully when residentEmail is missing or non-string (untrusted row_data)", () => {
    expect(() => buildRentReminderPreview(charge({ residentEmail: null as unknown as string }))).not.toThrow();
    expect(buildRentReminderPreview(charge({ residentEmail: null as unknown as string })).residentEmail).toBe("");
    expect(buildRentReminderPreview(charge({ residentEmail: 12345 as unknown as string })).residentEmail).toBe("");
  });
});
