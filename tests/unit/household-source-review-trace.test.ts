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
  creditOrFileHouseholdSourceReview,
  householdChargeIdsFromMetadata,
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

  it("keys a release-stage review apart from a credit-stage one for the same source", async () => {
    // A credited hold that cannot pay out is not missing money, so it must not be
    // suppressed by — nor suppress — a credit refusal row for the same source.
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
    for (const stage of ["credit", "release", "release"] as const) {
      await recordHouseholdSourceReviewNeeded(db as never, {
        ownerManagerUserId: MANAGER,
        sourceId: "cs_both",
        surface: stage === "credit" ? "checkout_verify" : "hold_release",
        stage,
        error: new Error(stage === "credit" ? "no allocation" : "payout refused"),
      });
    }
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.dedupe_key)).toEqual([
      householdSourceReviewDedupeKey("cs_both"),
      householdSourceReviewDedupeKey("cs_both", "release"),
    ]);
    expect(rows[1]).toMatchObject({ input_summary: { stage: "release" } });
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

  it("reads the charge ids a source's metadata names, in order", () => {
    expect(householdChargeIdsFromMetadata({ charge_ids: "hc_b, hc_a", charge_id: "hc_b" })).toEqual([
      "hc_b",
      "hc_a",
    ]);
    expect(householdChargeIdsFromMetadata({ charge_id: "hc_only" })).toEqual(["hc_only"]);
    expect(householdChargeIdsFromMetadata(null)).toEqual([]);
  });

  it("stores the reason as one bounded line", async () => {
    expect(householdSourceReviewReason(new Error("a\n  b\tc"))).toBe("a b c");
    expect(householdSourceReviewReason(new Error(""))).toBe("The payment source could not be credited.");
    expect(householdSourceReviewReason(new Error("x".repeat(400))).length).toBe(300);
  });
});

describe("creditOrFileHouseholdSourceReview", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("files the refusal and rethrows, so Stripe still retries", async () => {
    const rows: Insert[] = [];
    const boom = new Error("Autopay source could not be atomically credited.");
    await expect(
      creditOrFileHouseholdSourceReview(
        dbThatAccepts(rows) as never,
        {
          ownerManagerUserId: MANAGER,
          sourceId: "pi_autopay_1",
          paymentIntentId: "pi_autopay_1",
          chargeIds: ["hc_rent"],
          surface: "webhook_autopay",
        },
        async () => {
          throw boom;
        },
      ),
    ).rejects.toBe(boom);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dedupe_key: householdSourceReviewDedupeKey("pi_autopay_1"),
      input_summary: { surface: "webhook_autopay", chargeIds: ["hc_rent"] },
      result_summary: { reason: "Autopay source could not be atomically credited." },
    });
  });

  it("files nothing when the credit succeeds, and passes its value through", async () => {
    const rows: Insert[] = [];
    const result = await creditOrFileHouseholdSourceReview(
      dbThatAccepts(rows) as never,
      { ownerManagerUserId: MANAGER, sourceId: "pi_ok", surface: "webhook_manual_ach" },
      async () => "credited" as const,
    );
    expect(result).toBe("credited");
    expect(rows).toHaveLength(0);
  });
});

describe("every non-interactive credit path files its refusal", () => {
  it("the webhook's Checkout, manual-ACH replay and manual-ACH capture all go through the wrapper", async () => {
    const { readFileSync } = await import("node:fs");
    const route = readFileSync("src/app/api/stripe/webhook/route.ts", "utf8");
    expect(route.match(/creditOrFileHouseholdSourceReview\(/g)).toHaveLength(3);
    for (const surface of ['surface: "webhook"', 'surface: "webhook_manual_ach"']) {
      expect(route).toContain(surface);
    }
    // No credit is reached without the wrapper around it.
    for (const call of [
      "creditVerifiedHouseholdCheckoutSource(db, stripe, session)",
      "creditVerifiedHouseholdManualSource(db, stripe, current)",
      "creditVerifiedHouseholdManualSource(db, stripe, paymentIntent)",
    ]) {
      expect(route).toContain(`() => ${call}`);
      expect(route).not.toContain(`await ${call}`);
    }
  });

  it("off-session autopay files at its own call site", async () => {
    const { readFileSync } = await import("node:fs");
    const financials = readFileSync("src/lib/stripe-webhook-financials.ts", "utf8");
    expect(financials).toContain('surface: "webhook_autopay"');
    expect(financials).toContain("() => creditVerifiedHouseholdAutopaySource(");
    expect(financials).not.toContain("await creditVerifiedHouseholdAutopaySource(");
  });

  it("the autopay RUNNER files too — the off-session driver nobody is watching", async () => {
    const { readFileSync } = await import("node:fs");
    const runner = readFileSync("src/lib/resident-autopay.server.ts", "utf8");
    expect(runner).toContain('from "@/lib/household-source-review.server"');
    expect(runner).toContain('surface: "autopay_runner"');
    expect(runner).toContain("() => creditVerifiedHouseholdAutopaySource(");
    expect(runner).not.toContain("await creditVerifiedHouseholdAutopaySource(");
  });

  it("no post-credit payout release anywhere is left un-isolated", async () => {
    // A release that runs AFTER a committed credit must never throw back to the caller:
    // that was the browser-proof 409, and in the application-fee flow it also skipped the
    // promotion, orphan report and setup email that follow the fulfil call. The ONLY
    // direct callers allowed are the modules that define the two primitives, the shared
    // post-credit helper, and the paths where the payout IS the operation being requested
    // (a vendor invoice payout, a work-order payout) or the retry driver itself.
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry)) files.push(full);
      }
    };
    walk("src");
    const allowed = new Set([
      join("src", "lib", "platform-hold-release.server.ts"),
      join("src", "lib", "platform-owner-recovery.server.ts"),
      join("src", "lib", "platform-post-credit-release.server.ts"),
      // The payout is the requested operation here, so a refusal belongs to the caller.
      join("src", "lib", "vendor-invoice-pay.server.ts"),
      join("src", "lib", "work-order-approve-pay.server.ts"),
      // `account.updated` IS the retry pass: throwing makes Stripe redeliver it.
      join("src", "lib", "stripe-webhook-financials.ts"),
    ]);
    const offenders = files.filter((file) => {
      if (allowed.has(file)) return false;
      const source = readFileSync(file, "utf8");
      return /(releaseVerifiedPlatformHoldsForOwner|settleClearedPlatformOwnerRecovery)\(/.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it("every post-credit release goes through the one isolated helper", async () => {
    const { readFileSync } = await import("node:fs");
    const helper = readFileSync("src/lib/platform-post-credit-release.server.ts", "utf8");
    // It files the refusal as a RELEASE-stage review and swallows it: the credit stands.
    expect(helper).toContain('stage: "release"');
    expect(helper).toContain('surface: "hold_release"');
    expect(helper).toContain("recordHouseholdSourceReviewNeeded");
    for (const caller of [
      "src/lib/household-captured-source.server.ts",
      "src/lib/application-fee-fulfillment.server.ts",
    ]) {
      const source = readFileSync(caller, "utf8");
      expect(source).toContain("releaseCreditedHoldAfterCommit(");
      expect(source).not.toContain("releaseVerifiedPlatformHoldsForOwner(");
    }
  });

  it("no credit anywhere in the codebase is reached without the traced helper", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry)) files.push(full);
      }
    };
    walk("src");
    const offenders = files.filter((file) => {
      if (file.endsWith("household-captured-source.server.ts")) return false;
      const source = readFileSync(file, "utf8");
      // The two verify routes answer the resident themselves and file without rethrowing.
      if (/household-charge-verify|resident-ach-payment/.test(file)) return false;
      return /await credit(Verified)?Household\w*Source\(/.test(source);
    });
    expect(offenders).toEqual([]);
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
    const sinceFilters: string[] = [];
    const db = {
      from(table: string) {
        const query: Record<string, unknown> = {};
        for (const method of ["select", "in", "lt", "eq", "is", "not", "order", "limit"]) {
          query[method] = () => query;
        }
        query.gte = (column: string, value: string) => {
          if (table === "audit_log") sinceFilters.push(`${column}>=${value}`);
          return query;
        };
        query.then = (resolve: (value: unknown) => unknown) =>
          resolve({ data: table === "audit_log" ? auditRows : [], error: null });
        return query;
      },
    };
    const health = await loadAdminHealth(db as never);
    const payments = health.groups.find((group) => group.id === "payments");
    // Windowed like its siblings, so a handled review stops being "broken right now".
    expect(sinceFilters.length).toBeGreaterThan(0);
    expect(payments?.label).toBe("Payments needing review");
    expect(payments?.rows).toHaveLength(1);
    expect(payments?.rows[0]).toMatchObject({
      accountId: MANAGER,
      fact: "Household captured source has an unverified prior allocation.",
    });
    expect(payments?.rows[0]!.title).toContain("cs_test_1");
    expect(payments?.rows[0]!.title).toContain("no manager hold");
  });

  it("names a credited hold that could not pay out as a payout problem, not missing money", async () => {
    const { loadAdminHealth } = await import("@/lib/admin/admin-health.server");
    const auditRows = [
      {
        id: "audit-2",
        landlord_id: MANAGER,
        input_summary: { sourceId: "cs_release_1", surface: "hold_release", stage: "release" },
        result_summary: { reason: "Saved payout account does not match its owner." },
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
    const row = health.groups.find((group) => group.id === "payments")?.rows[0];
    expect(row?.title).toBe("Credited hold could not pay out (cs_release_1)");
    expect(row?.fact).toBe("Saved payout account does not match its owner.");
  });
});
