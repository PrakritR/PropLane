/**
 * A captured resident payment whose manager hold refused leaves a DURABLE trace.
 *
 * The verify routes answer `paid: true` (the charge rows are already paid) and the webhook
 * keeps rethrowing so Stripe retries — but the retries call the same fail-closed function
 * with the same frozen inputs, so a deliberate refusal outlives them. Without a row, the
 * only record was a `console.error` and the manager's missing hold was unfindable.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  HOUSEHOLD_SOURCE_REVIEW_ACTION,
  householdSourceReviewDedupeKey,
  householdSourceReviewReason,
  recordHouseholdSourceReviewNeeded,
} = await import("@/lib/household-source-review.server");

const MANAGER = "11111111-1111-4111-8111-111111111111";

type Insert = Record<string, unknown>;

function dbThatAccepts(rows: Insert[], error: { code?: string; message?: string } | null = null) {
  return {
    from(table: string) {
      expect(table).toBe("audit_log");
      return {
        async insert(row: Insert) {
          if (!error) rows.push(row);
          return { error };
        },
      };
    },
  };
}

describe("recordHouseholdSourceReviewNeeded", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("files the real refusal against the manager, keyed on the source id", async () => {
    const rows: Insert[] = [];
    const result = await recordHouseholdSourceReviewNeeded(dbThatAccepts(rows) as never, {
      ownerManagerUserId: MANAGER,
      sourceId: "cs_test_1",
      paymentIntentId: "pi_test_1",
      chargeIds: ["hc_a", "hc_b"],
      surface: "checkout_verify",
      error: new Error("Household captured source has an unverified prior allocation."),
    });

    expect(result).toEqual({
      recorded: true,
      reason: "Household captured source has an unverified prior allocation.",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: HOUSEHOLD_SOURCE_REVIEW_ACTION,
      actor_user_id: MANAGER,
      landlord_id: MANAGER,
      dedupe_key: householdSourceReviewDedupeKey("cs_test_1"),
      input_summary: {
        sourceId: "cs_test_1",
        paymentIntentId: "pi_test_1",
        chargeIds: ["hc_a", "hc_b"],
        surface: "checkout_verify",
      },
      result_summary: { reason: "Household captured source has an unverified prior allocation." },
    });
  });

  it("treats the duplicate key a retry hits as already filed", async () => {
    const rows: Insert[] = [];
    const duplicate = { code: "23505", message: 'duplicate key value violates unique constraint "audit_log_dedupe_key_key"' };
    const result = await recordHouseholdSourceReviewNeeded(dbThatAccepts(rows, duplicate) as never, {
      ownerManagerUserId: MANAGER,
      sourceId: "cs_test_1",
      surface: "webhook",
      error: new Error("boom"),
    });
    expect(result.recorded).toBe(true);
    expect(rows).toHaveLength(0);
  });

  it("one row per source however many surfaces and retries see it", async () => {
    const rows: Insert[] = [];
    const db = {
      from() {
        return {
          async insert(row: Insert) {
            if (rows.some((existing) => existing.dedupe_key === row.dedupe_key)) {
              return { error: { code: "23505", message: "duplicate key" } };
            }
            rows.push(row);
            return { error: null };
          },
        };
      },
    };
    for (const surface of ["checkout_verify", "webhook", "webhook"] as const) {
      await recordHouseholdSourceReviewNeeded(db as never, {
        ownerManagerUserId: MANAGER,
        sourceId: "cs_test_2",
        surface,
        error: new Error("Household source could not be atomically credited."),
      });
    }
    expect(rows).toHaveLength(1);
  });

  it("never files without an owner to file it under", async () => {
    const rows: Insert[] = [];
    const result = await recordHouseholdSourceReviewNeeded(dbThatAccepts(rows) as never, {
      ownerManagerUserId: "  ",
      sourceId: "cs_test_3",
      surface: "manual_ach_verify",
      error: new Error("nope"),
    });
    expect(result.recorded).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it("stores the reason as one bounded line", async () => {
    expect(householdSourceReviewReason(new Error("a\n  b\tc"))).toBe("a b c");
    expect(householdSourceReviewReason(new Error(""))).toBe("The payment source could not be credited.");
    expect(householdSourceReviewReason(new Error("x".repeat(400))).length).toBe(300);
  });
});

describe("the admin Health page", () => {
  it("lists a paid charge with no manager hold, naming the account and the reason", async () => {
    const { loadAdminHealth } = await import("@/lib/admin/admin-health.server");
    const auditRows = [
      {
        id: "audit-1",
        landlord_id: MANAGER,
        input_summary: { sourceId: "cs_test_1", surface: "checkout_verify" },
        result_summary: { reason: "Household captured source has an unverified prior allocation." },
        created_at: "2026-10-17T00:00:00.000Z",
      },
    ];
    const db = {
      from(table: string) {
        const query: Record<string, unknown> = {};
        for (const method of ["select", "in", "gte", "lt", "eq", "is", "not", "order", "limit"]) {
          query[method] = () => query;
        }
        query.then = (resolve: (value: unknown) => unknown) =>
          resolve({ data: table === "audit_log" ? auditRows : [], error: null });
        return query;
      },
    };
    const health = await loadAdminHealth(db as never);
    const payments = health.groups.find((group) => group.id === "payments");
    expect(payments?.label).toBe("Payments needing review");
    expect(payments?.rows).toHaveLength(1);
    expect(payments?.rows[0]).toMatchObject({
      accountId: MANAGER,
      fact: "Household captured source has an unverified prior allocation.",
    });
    expect(payments?.rows[0]!.title).toContain("cs_test_1");
  });
});
