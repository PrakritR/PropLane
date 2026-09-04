import { beforeEach, describe, expect, it, vi } from "vitest";

// Analytics is the only outbound side effect not exercised here — the shared
// work-order-bids.server functions call track() on every write.
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));

import { auditDayBucket } from "@/lib/tools/audit";
import type { VendorAgentContext } from "@/lib/tools/vendor-context";
import { vendorAgentRegistry } from "@/lib/tools/vendor-index";
import { getMyAvailabilityTool, updateMyAvailabilityTool } from "@/lib/tools/domains/vendor/availability";
import { markJobDoneTool, setMyPriceTool, submitBidTool } from "@/lib/tools/domains/vendor/job-actions";
import { getJobDetailsTool, listMyBidsTool, listMyJobsTool, listMyOffersTool } from "@/lib/tools/domains/vendor/jobs";
import { contentHash } from "@/lib/tools/domains/vendor/load-vendor-rows";
import { listMyInboxThreadsTool, sendMessageToManagerTool } from "@/lib/tools/domains/vendor/messaging";
import { getMyProfileTool, listMyPayoutsTool } from "@/lib/tools/domains/vendor/profile";
import { executeWrite, previewWrite } from "./fake-agent-ctx";

/**
 * Fake supabase surface for VENDOR tool tests. Extends the FakeQuery idea from
 * fake-agent-ctx.ts (deliberately not edited — manager tests own it) with:
 *
 *  - `.or(...)` parsing including JSON-path clauses (`row_data->>email`), so
 *    managerIdsOwningVendor and the inbox scope filter run for real;
 *  - upsert onConflict handling for the work_order_bids
 *    `(work_order_id, vendor_user_id)` unique key;
 *  - mutation recording (insert/upsert/update) including audit_log dedupe-key
 *    uniqueness (a duplicate insert returns Postgres code 23505).
 *
 * `.eq` on a column the seeded row does not carry does NOT match (fail closed):
 * a mis-scoped filter can never accidentally pass.
 */
type FakeRow = Record<string, unknown>;

type FakeMutation = { table: string; kind: "insert" | "upsert" | "update" | "delete"; values: FakeRow };

type Predicate = (row: FakeRow) => boolean;

function resolveColumn(row: FakeRow, col: string): unknown {
  const jsonPath = col.split("->>");
  if (jsonPath.length === 2) {
    const nested = row[jsonPath[0]!.trim()];
    if (!nested || typeof nested !== "object") return undefined;
    return (nested as Record<string, unknown>)[jsonPath[1]!.trim()];
  }
  return row[col];
}

function eqPredicate(col: string, val: unknown): Predicate {
  return (row) => {
    const resolved = resolveColumn(row, col);
    if (resolved === undefined || resolved === null) return false;
    return String(resolved) === String(val);
  };
}

/** Parse a PostgREST `.or()` expression of `col.eq.value` clauses. */
function orPredicate(expr: string): Predicate {
  const clauses = expr.split(",").map((clause) => {
    const idx = clause.indexOf(".eq.");
    if (idx < 0) return () => false;
    return eqPredicate(clause.slice(0, idx), clause.slice(idx + 4));
  });
  return (row) => clauses.some((match) => match(row));
}

class FakeVendorQuery {
  private predicates: Predicate[] = [];
  private ordering: { col: string; ascending: boolean } | null = null;
  private conflictCols: string[] = ["id"];
  private ignoreDuplicates = false;
  private pending:
    | { kind: "insert"; values: FakeRow[] }
    | { kind: "upsert"; values: FakeRow[] }
    | { kind: "update"; values: FakeRow }
    | null = null;

  constructor(
    private table: string,
    private rows: FakeRow[],
    private mutations: FakeMutation[],
  ) {}

  select() {
    return this;
  }
  limit() {
    return this;
  }
  not() {
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.ordering = { col, ascending: opts?.ascending !== false };
    return this;
  }
  eq(col: string, val: unknown) {
    this.predicates.push(eqPredicate(col, val));
    return this;
  }
  neq(col: string, val: unknown) {
    const match = eqPredicate(col, val);
    this.predicates.push((row) => !match(row));
    return this;
  }
  gte(col: string, val: unknown) {
    this.predicates.push((row) => {
      const resolved = resolveColumn(row, col);
      if (resolved === undefined || resolved === null) return false;
      return String(resolved) >= String(val);
    });
    return this;
  }
  lte(col: string, val: unknown) {
    this.predicates.push((row) => {
      const resolved = resolveColumn(row, col);
      if (resolved === undefined || resolved === null) return false;
      return String(resolved) <= String(val);
    });
    return this;
  }
  in(col: string, vals: unknown[]) {
    const set = new Set((vals ?? []).map((v) => String(v)));
    this.predicates.push((row) => {
      const resolved = resolveColumn(row, col);
      if (resolved === undefined || resolved === null) return false;
      return set.has(String(resolved));
    });
    return this;
  }
  or(expr: string) {
    this.predicates.push(orPredicate(expr));
    return this;
  }

  insert(values: FakeRow | FakeRow[]) {
    this.pending = { kind: "insert", values: Array.isArray(values) ? values : [values] };
    return this;
  }
  upsert(values: FakeRow | FakeRow[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.pending = { kind: "upsert", values: Array.isArray(values) ? values : [values] };
    this.conflictCols = (opts?.onConflict ?? "id").split(",").map((s) => s.trim());
    this.ignoreDuplicates = opts?.ignoreDuplicates === true;
    return this;
  }
  update(values: FakeRow) {
    this.pending = { kind: "update", values };
    return this;
  }

  private apply(): FakeRow[] {
    const matched = this.rows.filter((row) => this.predicates.every((match) => match(row)));
    if (this.ordering) {
      const { col, ascending } = this.ordering;
      matched.sort((a, b) => {
        const cmp = String(resolveColumn(a, col) ?? "").localeCompare(String(resolveColumn(b, col) ?? ""));
        return ascending ? cmp : -cmp;
      });
    }
    return matched;
  }

  private run(): { data: FakeRow[] | null; error: { code?: string; message: string } | null; count?: number } {
    if (!this.pending) {
      const rows = this.apply();
      return { data: rows, error: null, count: rows.length };
    }

    if (this.pending.kind === "insert" || this.pending.kind === "upsert") {
      const written: FakeRow[] = [];
      for (const values of this.pending.values) {
        // audit_log dedupe: a second insert with the same non-null dedupe_key
        // violates the unique index, exactly like production.
        if (this.pending.kind === "insert" && this.table === "audit_log" && values.dedupe_key != null) {
          const clash = this.rows.some((row) => row.dedupe_key != null && row.dedupe_key === values.dedupe_key);
          if (clash) return { data: null, error: { code: "23505", message: "duplicate key value" } };
        }
        const existingIdx =
          this.pending.kind === "upsert"
            ? this.rows.findIndex((row) =>
                this.conflictCols.every((c) => values[c] !== undefined && String(row[c]) === String(values[c])),
              )
            : -1;
        if (existingIdx >= 0) {
          // ON CONFLICT DO NOTHING: no write, and Postgrest returns no row for it.
          if (this.ignoreDuplicates) continue;
          this.rows[existingIdx] = { ...this.rows[existingIdx], ...values };
          written.push(this.rows[existingIdx]);
        } else {
          const row = { ...values };
          this.rows.push(row);
          written.push(row);
        }
        this.mutations.push({ table: this.table, kind: this.pending.kind, values: { ...values } });
      }
      return { data: written, error: null };
    }

    const patch = this.pending.values;
    const updated = this.apply();
    for (const row of updated) Object.assign(row, patch);
    this.mutations.push({ table: this.table, kind: "update", values: { ...patch } });
    return { data: updated, error: null };
  }

  maybeSingle() {
    const { data, error } = this.run();
    return Promise.resolve({ data: data?.[0] ?? null, error });
  }

  range(from: number, to: number) {
    return Promise.resolve({ data: this.apply().slice(from, to + 1), error: null });
  }

  // Thenable: `await query` resolves selects and pending mutations alike.
  then<T>(resolve: (v: { data: FakeRow[] | null; error: { code?: string; message: string } | null; count?: number }) => T) {
    return Promise.resolve(this.run()).then(resolve);
  }
}

type FakeVendorSetup = {
  ctx: VendorAgentContext;
  mutations: FakeMutation[];
  tables: Record<string, FakeRow[]>;
};

/**
 * Build a VendorAgentContext whose service-role db serves the given per-table
 * rows. Defaults to vendor A ("vendor_a" / venda@axis.test) linked to
 * "manager_1".
 */
function makeVendorToolCtx(tables: Record<string, FakeRow[]>, overrides: Partial<VendorAgentContext> = {}): FakeVendorSetup {
  const mutations: FakeMutation[] = [];
  const db = {
    from(table: string) {
      return new FakeVendorQuery(table, (tables[table] ??= []), mutations);
    },
  };
  const ctx = {
    kind: "vendor",
    userId: "vendor_a",
    email: "venda@axis.test",
    managerIds: ["manager_1"],
    landlordId: "vendor_a",
    db,
    ...overrides,
  } as unknown as VendorAgentContext;
  return { ctx, mutations, tables };
}

const VENDOR_A = { id: "vendor_a", email: "venda@axis.test" };
const VENDOR_B = { id: "vendor_b", email: "vendb@axis.test" };
const MANAGER = "manager_1";
const FOREIGN_MANAGER = "manager_x";

function workOrder(
  id: string,
  vendorUserId: string | null,
  rowData: Record<string, unknown> = {},
): FakeRow {
  return {
    id,
    manager_user_id: MANAGER,
    vendor_user_id: vendorUserId,
    updated_at: "2026-07-01T00:00:00.000Z",
    row_data: {
      id,
      title: `Job ${id}`,
      propertyName: "Maple House",
      unit: "3",
      status: "Open",
      bucket: "open",
      priority: "High",
      description: `Sink leaks (${id})`,
      ...rowData,
    },
  };
}

/** Fresh seed per test — write executors mutate rows in place. */
function seed() {
  return makeVendorToolCtx({
    profiles: [
      { id: VENDOR_A.id, email: VENDOR_A.email, full_name: "Vendor A", role: "vendor" },
      { id: VENDOR_B.id, email: VENDOR_B.email, full_name: "Vendor B", role: "vendor" },
      { id: MANAGER, email: "mgr@axis.test", full_name: "Mgr One", role: "manager" },
      { id: FOREIGN_MANAGER, email: "foreign@axis.test", full_name: "Foreign Mgr", role: "manager" },
    ],
    manager_vendor_records: [
      {
        id: "dir_a",
        manager_user_id: MANAGER,
        vendor_user_id: VENDOR_A.id,
        row_data: {
          id: "dir_a",
          name: "Vendor A Plumbing",
          email: VENDOR_A.email,
          phone: "206-555-0000",
          trade: "plumbing",
          trades: ["plumbing"],
          active: true,
          zelleContact: "zelle-secret-profile",
        },
      },
      {
        id: "dir_b",
        manager_user_id: MANAGER,
        vendor_user_id: VENDOR_B.id,
        row_data: { id: "dir_b", name: "Vendor B", email: VENDOR_B.email },
      },
    ],
    portal_work_order_records: [
      // Assigned to vendor A, bidding open — submit_bid happy path.
      workOrder("WO-A", VENDOR_A.id, {
        biddingOpen: true,
        photoDataUrls: ["data:image/png;base64,WOBLOB"],
        vendorZelleContactSnapshot: "zelle-secret-wo",
      }),
      // Vendor B's job — must never be visible or biddable for vendor A.
      workOrder("WO-B", VENDOR_B.id, { biddingOpen: true, description: "B SECRET JOB" }),
      // Assigned + scheduled, no bid — set_my_price / mark_job_done happy paths.
      workOrder("WO-C", VENDOR_A.id, { bucket: "scheduled", status: "Scheduled", scheduledAtIso: "2026-07-20T17:00:00.000Z" }),
      // Assigned + scheduled with an ACCEPTED bid — the locked-price invariant.
      workOrder("WO-D", VENDOR_A.id, { bucket: "scheduled", status: "Scheduled", vendorCostCents: 40000 }),
      // Assigned but bidding closed — submit_bid must refuse.
      workOrder("WO-E", VENDOR_A.id, { biddingOpen: false }),
      // Not assigned to anyone; visible to vendor A only through a sent offer.
      workOrder("WO-F", null, { biddingOpen: true }),
    ],
    work_order_vendor_offers: [
      { id: "OFF-A", work_order_id: "WO-F", vendor_user_id: VENDOR_A.id, vendor_directory_id: "dir_a", manager_user_id: MANAGER, status: "sent", created_at: "2026-07-01T00:00:00.000Z" },
      { id: "OFF-B", work_order_id: "WO-B", vendor_user_id: VENDOR_B.id, vendor_directory_id: "dir_b", manager_user_id: MANAGER, status: "sent", created_at: "2026-07-01T00:00:00.000Z" },
    ],
    work_order_bids: [
      {
        id: "BID-D",
        work_order_id: "WO-D",
        vendor_user_id: VENDOR_A.id,
        vendor_directory_id: "dir_a",
        manager_user_id: MANAGER,
        quote_mode: "upfront",
        consultation_visit_at: null,
        amount_cents: 40000,
        materials_cents: 0,
        proposed_time: "2026-07-20T17:00:00.000Z",
        note: null,
        status: "accepted",
        updated_at: "2026-07-02T00:00:00.000Z",
      },
      {
        id: "BID-B",
        work_order_id: "WO-B",
        vendor_user_id: VENDOR_B.id,
        vendor_directory_id: "dir_b",
        manager_user_id: MANAGER,
        quote_mode: "upfront",
        consultation_visit_at: null,
        amount_cents: 12300,
        materials_cents: 0,
        proposed_time: null,
        note: "B SECRET BID",
        status: "submitted",
        updated_at: "2026-07-02T00:00:00.000Z",
      },
    ],
    vendor_payouts: [
      { id: "PAY-A", vendor_user_id: VENDOR_A.id, work_order_id: "WO-D", amount_cents: 40000, status: "paid", failure_reason: null, created_at: "2026-07-03T00:00:00.000Z" },
      { id: "PAY-B", vendor_user_id: VENDOR_B.id, work_order_id: "WO-B", amount_cents: 100, status: "failed", failure_reason: "B SECRET FAILURE", created_at: "2026-07-03T00:00:00.000Z" },
    ],
    portal_inbox_thread_records: [
      {
        id: "T-A",
        scope: "axis_portal_inbox_vendor_v1",
        owner_user_id: VENDOR_A.id,
        participant_email: null,
        row_data: { id: "T-A", folder: "inbox", from: "Mgr One", email: "mgr@axis.test", subject: "Hi A", preview: "hello", body: "SECRET BODY A", unread: true },
      },
      {
        id: "T-B",
        scope: "axis_portal_inbox_vendor_v1",
        owner_user_id: VENDOR_B.id,
        participant_email: VENDOR_B.email,
        row_data: { id: "T-B", folder: "inbox", subject: "B SECRET THREAD", body: "b" },
      },
      {
        id: "T-MGR",
        scope: "axis_portal_inbox_manager_v1",
        owner_user_id: VENDOR_A.id,
        participant_email: null,
        row_data: { id: "T-MGR", folder: "inbox", subject: "MGR SCOPE THREAD", body: "m" },
      },
    ],
    portal_schedule_records: [
      {
        id: `axis_vendor_avail_slots_v2_${VENDOR_A.id}`,
        manager_user_id: VENDOR_A.id,
        record_type: "vendor_availability",
        row_data: {
          id: `axis_vendor_avail_slots_v2_${VENDOR_A.id}`,
          recordType: "vendor_availability",
          managerUserId: VENDOR_A.id,
          payload: ["2026-07-20:16", "2026-07-20:17"],
        },
      },
      {
        id: `axis_vendor_avail_slots_v2_${VENDOR_B.id}`,
        manager_user_id: VENDOR_B.id,
        record_type: "vendor_availability",
        row_data: {
          id: `axis_vendor_avail_slots_v2_${VENDOR_B.id}`,
          recordType: "vendor_availability",
          managerUserId: VENDOR_B.id,
          payload: ["2099-01-01:10"],
        },
      },
    ],
    vendor_tax_profiles: [
      {
        vendor_id: "dir_a",
        manager_user_id: MANAGER,
        vendor_user_id: VENDOR_A.id,
        legal_name: "Vendor A LLC",
        tin_last4: "7788",
        tin_encrypted: "TIN-CIPHER-SECRET",
        w9_received_at: "2026-06-01T00:00:00.000Z",
      },
    ],
  });
}

const auditRows = (mutations: FakeMutation[]) => mutations.filter((m) => m.table === "audit_log" && m.kind === "insert");

beforeEach(() => {
  vi.clearAllMocks();
  // Keep every outbound channel offline: inbox-only delivery in tests.
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("STRIPE_SECRET_KEY", "");
});

describe("vendor registry acceptance", () => {
  it("registers all 17 tools without a banned identity input field", () => {
    // vendor-index.ts calls buildRegistry at module load, which throws if any
    // write tool declares landlordId/vendorUserId/managerId/etc — importing it
    // is itself the assertion; verify the expected surface is present.
    expect(vendorAgentRegistry.size).toBe(17);
    expect(vendorAgentRegistry.get("submit_bid")?.kind).toBe("write");
    expect(vendorAgentRegistry.get("list_my_jobs")?.kind).toBe("read");
  });
});

describe("vendor read tools: cross-vendor isolation", () => {
  it("list_my_jobs returns assigned + offered jobs only, wraps descriptions, drops blobs and payment snapshots", async () => {
    const { ctx } = seed();
    const res = (await listMyJobsTool.handler(ctx, {})) as {
      count: number;
      jobs: { id: string; assignment: string; description: { untrustedContent: string } | null }[];
    };
    const ids = res.jobs.map((j) => j.id).sort();
    expect(ids).toEqual(["WO-A", "WO-C", "WO-D", "WO-E", "WO-F"]);
    expect(res.jobs.find((j) => j.id === "WO-F")!.assignment).toBe("offered");
    const woA = res.jobs.find((j) => j.id === "WO-A")!;
    expect(woA.description!.untrustedContent).toContain("<<<EXTERNAL_MESSAGE from the work order requester>>>");
    const json = JSON.stringify(res);
    expect(json).not.toContain("B SECRET JOB");
    expect(json).not.toContain("WOBLOB");
    expect(json).not.toContain("zelle-secret-wo");
  });

  it("get_job_details refuses another vendor's work order and resolves an offered one", async () => {
    const { ctx } = seed();
    await expect(getJobDetailsTool.handler(ctx, { workOrderId: "WO-B" })).rejects.toThrow(/list_my_jobs/);
    const res = (await getJobDetailsTool.handler(ctx, { workOrderId: "WO-F" })) as {
      workOrder: { id: string; assignment: string };
    };
    expect(res.workOrder).toMatchObject({ id: "WO-F", assignment: "offered" });
  });

  it("list_my_bids returns only the vendor's own bids", async () => {
    const { ctx } = seed();
    const res = (await listMyBidsTool.handler(ctx, {})) as { bids: { id: string }[] };
    expect(res.bids.map((b) => b.id)).toEqual(["BID-D"]);
    expect(JSON.stringify(res)).not.toContain("B SECRET BID");
  });

  it("list_my_offers returns only the vendor's own offers", async () => {
    const { ctx } = seed();
    const res = (await listMyOffersTool.handler(ctx, {})) as { offers: { id: string; workOrderId: string }[] };
    expect(res.offers.map((o) => o.id)).toEqual(["OFF-A"]);
  });

  it("list_my_payouts returns only the vendor's own payouts", async () => {
    const { ctx } = seed();
    const res = (await listMyPayoutsTool.handler(ctx, {})) as { payouts: { id: string; amount: string }[] };
    expect(res.payouts.map((p) => p.id)).toEqual(["PAY-A"]);
    expect(res.payouts[0]!.amount).toBe("$400.00");
    expect(JSON.stringify(res)).not.toContain("B SECRET FAILURE");
  });

  it("list_my_inbox_threads applies the vendor scope + ownership filter, headers only", async () => {
    const { ctx } = seed();
    const res = (await listMyInboxThreadsTool.handler(ctx, {})) as { threads: { id: string }[] };
    expect(res.threads.map((t) => t.id)).toEqual(["T-A"]);
    const json = JSON.stringify(res);
    expect(json).not.toContain("SECRET BODY A");
    expect(json).not.toContain("B SECRET THREAD");
    expect(json).not.toContain("MGR SCOPE THREAD");
  });

  it("get_my_availability reads only the vendor's own slot record", async () => {
    const { ctx } = seed();
    const res = (await getMyAvailabilityTool.handler(ctx, {})) as {
      slotCount: number;
      dates: { date: string; windows: { start: string; end: string }[] }[];
    };
    expect(res.slotCount).toBe(2);
    expect(res.dates).toEqual([{ date: "2026-07-20", windows: [{ start: "08:00", end: "09:00" }] }]);
    expect(JSON.stringify(res)).not.toContain("2099-01-01");
  });

  it("get_my_profile returns readiness booleans only — never TIN or payment contact data", async () => {
    const { ctx } = seed();
    const res = (await getMyProfileTool.handler(ctx, {})) as {
      name: string | null;
      taxProfileComplete: boolean;
      stripeConnect: { connected: boolean };
    };
    expect(res).toMatchObject({
      name: "Vendor A Plumbing",
      email: VENDOR_A.email,
      linkedManagerCount: 1,
      taxProfileComplete: true,
      stripeConnect: { connected: false, payoutsReady: false },
    });
    const json = JSON.stringify(res);
    expect(json).not.toContain("7788");
    expect(json).not.toContain("TIN-CIPHER-SECRET");
    expect(json).not.toContain("Vendor A LLC");
    expect(json).not.toContain("zelle-secret-profile");
  });
});

describe("vendor write tools: previews reject foreign/invalid targets", () => {
  it("submit_bid refuses a work order assigned to another vendor, in preview and execute", async () => {
    const { ctx, mutations } = seed();
    const input = { workOrderId: "WO-B", amountUsd: 100 };
    const preview = await previewWrite(submitBidTool, ctx, input);
    expect(preview.ok).toBe(false);
    const exec = await executeWrite(submitBidTool, ctx, input);
    expect(exec.ok).toBe(false);
    expect(mutations.filter((m) => m.table === "work_order_bids")).toEqual([]);
    expect(auditRows(mutations)).toEqual([]);
  });

  it("submit_bid refuses when bidding is not open", async () => {
    const { ctx } = seed();
    const preview = await previewWrite(submitBidTool, ctx, { workOrderId: "WO-E", amountUsd: 100 });
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.error).toContain("Bidding is not open");
  });

  it("set_my_price refuses when the vendor's bid is already accepted (the locked payout anchor)", async () => {
    const { ctx, mutations, tables } = seed();
    const input = { workOrderId: "WO-D", amountUsd: 999 };
    const preview = await previewWrite(setMyPriceTool, ctx, input);
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.error).toContain("accepted bid amount is locked");
    const exec = await executeWrite(setMyPriceTool, ctx, input);
    expect(exec.ok).toBe(false);
    // Neither the accepted bid nor the work order price moved.
    expect(tables.work_order_bids!.find((b) => b.id === "BID-D")!.amount_cents).toBe(40000);
    const wo = tables.portal_work_order_records!.find((r) => r.id === "WO-D")!;
    expect((wo.row_data as { vendorCostCents?: number }).vendorCostCents).toBe(40000);
    expect(mutations.filter((m) => m.table === "work_order_bids")).toEqual([]);
  });

  it("set_my_price and mark_job_done refuse another vendor's work order", async () => {
    const { ctx } = seed();
    const price = await previewWrite(setMyPriceTool, ctx, { workOrderId: "WO-B", amountUsd: 50 });
    expect(price.ok).toBe(false);
    const done = await previewWrite(markJobDoneTool, ctx, { workOrderId: "WO-B" });
    expect(done.ok).toBe(false);
  });

  it("send_message_to_manager rejects a manager not linked to this vendor", async () => {
    const { ctx, mutations } = seed();
    const input = { subject: "Hello", body: "Hi", recipientManagerId: FOREIGN_MANAGER };
    const preview = await previewWrite(sendMessageToManagerTool, ctx, input);
    expect(preview.ok).toBe(false);
    const exec = await executeWrite(sendMessageToManagerTool, ctx, input);
    expect(exec.ok).toBe(false);
    expect(mutations.filter((m) => m.table === "portal_inbox_thread_records")).toEqual([]);
  });
});

describe("vendor write tools: happy paths write audited, scoped rows", () => {
  it("submit_bid upserts a bid pinned to the vendor + owning manager and audits with the amount/time hash", async () => {
    const { ctx, mutations, tables } = seed();
    const input = { workOrderId: "WO-A", amountUsd: 450, proposedTimeIso: "2026-07-22T17:00:00.000Z", note: "Can start Wednesday" };
    const preview = await previewWrite(submitBidTool, ctx, input);
    expect(preview.ok).toBe(true);
    if (preview.ok) expect(preview.preview.fields.some((l) => l.value === "$450.00")).toBe(true);

    const exec = await executeWrite(submitBidTool, ctx, input);
    expect(exec.ok).toBe(true);

    const audit = auditRows(mutations)[0];
    expect(audit?.values.dedupe_key).toBe(
      `submit_bid:${VENDOR_A.id}:WO-A:${contentHash("45000|2026-07-22T17:00:00.000Z")}`,
    );
    expect(audit?.values.landlord_id).toBe(VENDOR_A.id);

    const bid = tables.work_order_bids!.find((b) => b.work_order_id === "WO-A")!;
    expect(bid).toMatchObject({
      vendor_user_id: VENDOR_A.id,
      vendor_directory_id: "dir_a",
      manager_user_id: MANAGER,
      amount_cents: 45000,
      status: "submitted",
    });

    // Same bid again: idempotent per amount+time.
    const again = await executeWrite(submitBidTool, ctx, input);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.reply).toContain("Already done");
  });

  it("set_my_price updates the work order costs and audits per work order + amount", async () => {
    const { ctx, mutations, tables } = seed();
    const exec = await executeWrite(setMyPriceTool, ctx, { workOrderId: "WO-C", amountUsd: 50, materialsUsd: 10 });
    expect(exec.ok).toBe(true);

    const audit = auditRows(mutations)[0];
    expect(audit?.values.dedupe_key).toBe(`set_my_price:${VENDOR_A.id}:WO-C:5000:1000`);

    const wo = tables.portal_work_order_records!.find((r) => r.id === "WO-C")!;
    expect(wo.row_data as Record<string, unknown>).toMatchObject({
      vendorCostCents: 5000,
      materialsCostCents: 1000,
      cost: "$60.00",
    });
  });

  it("mark_job_done sets the vendor-marked-done flag, notifies the manager, and audits one-shot", async () => {
    const { ctx, mutations, tables } = seed();
    const exec = await executeWrite(markJobDoneTool, ctx, { workOrderId: "WO-C", workDoneSummary: "Replaced trap" });
    expect(exec.ok).toBe(true);

    const audit = auditRows(mutations)[0];
    expect(audit?.values.dedupe_key).toBe(`mark_job_done:${VENDOR_A.id}:WO-C`);

    const wo = tables.portal_work_order_records!.find((r) => r.id === "WO-C")!;
    expect(wo.row_data as Record<string, unknown>).toMatchObject({
      automationStatus: "vendor_marked_done",
      vendorMarkedDoneNote: "Replaced trap",
    });
    // Manager got an inbox notification through the real delivery pipeline.
    expect(mutations.some((m) => m.table === "portal_inbox_thread_records")).toBe(true);
  });

  it("send_message_to_manager delivers through the vendor-scoped inbox pipeline and audits per content per day", async () => {
    const { ctx, mutations } = seed();
    const input = { subject: "Question", body: "Which unit has the leak?" };
    const preview = await previewWrite(sendMessageToManagerTool, ctx, input);
    expect(preview.ok).toBe(true);
    if (preview.ok) expect(preview.preview.fields.some((l) => l.value.includes("mgr@axis.test"))).toBe(true);

    const exec = await executeWrite(sendMessageToManagerTool, ctx, input);
    expect(exec.ok).toBe(true);

    const audit = auditRows(mutations)[0];
    expect(audit?.values.dedupe_key).toBe(
      `send_message_to_manager:${VENDOR_A.id}:${contentHash("Question\nWhich unit has the leak?")}:${auditDayBucket()}`,
    );
    // Sender "sent" + recipient "inbox" thread rows.
    expect(mutations.filter((m) => m.table === "portal_inbox_thread_records").length).toBeGreaterThanOrEqual(2);
  });

  it("update_my_availability read-merge-writes the vendor's own slot record with a windowed dedupe key", async () => {
    const { ctx, mutations, tables } = seed();
    const exec = await executeWrite(updateMyAvailabilityTool, ctx, {
      date: "2026-07-21",
      startTime: "08:00",
      endTime: "10:00",
      mode: "add",
    });
    expect(exec.ok).toBe(true);

    const audit = auditRows(mutations)[0];
    expect(audit?.values.dedupe_key).toBe(`update_my_availability:${VENDOR_A.id}:2026-07-21:add:08:00-10:00`);

    const row = tables.portal_schedule_records!.find((r) => r.id === `axis_vendor_avail_slots_v2_${VENDOR_A.id}`)!;
    const payload = (row.row_data as { payload: string[] }).payload;
    // Existing slots preserved (read-merge-write), 4 new half-hour slots added.
    expect(payload).toEqual(["2026-07-20:16", "2026-07-20:17", "2026-07-21:16", "2026-07-21:17", "2026-07-21:18", "2026-07-21:19"]);
    expect(row.manager_user_id).toBe(VENDOR_A.id);
  });
});
