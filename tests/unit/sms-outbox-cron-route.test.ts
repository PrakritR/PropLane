import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  unknownInventory: vi.fn(),
  reconcile: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({
  dispatchOwnerSmsOutbox: mocks.dispatch,
  loadUnknownSmsInventory: mocks.unknownInventory,
}));

vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  reconcilePendingManagerNumberOperations: mocks.reconcile,
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({ from: mocks.from }),
}));

function request(secret = "cron-secret") {
  return new Request("https://prop-lane.space/api/cron/sms-outbox", {
    headers: { authorization: `Bearer ${secret}` },
  });
}

function inventoryQueries({ due = 0, quarantined = 0 } = {}) {
  mocks.from.mockImplementation((table: string) => {
    if (table === "sms_outbox") {
      return {
        select: () => ({
          in: () => ({
            lte: async () => ({ count: due, error: null }),
          }),
        }),
      };
    }
    if (table === "manager_sms_numbers") {
      return {
        select: () => ({
          not: async () => ({ count: quarantined, error: null }),
        }),
      };
    }
    throw new Error(`Unexpected table ${table}`);
  });
}

describe("managed SMS outbox scheduler health gate", () => {
  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", "cron-secret");
    mocks.dispatch.mockReset().mockResolvedValue({
      ok: true,
      claimed: 0,
      submitted: 0,
      blocked: 0,
      unknown: 0,
      infrastructureErrors: [],
    });
    mocks.unknownInventory.mockReset().mockResolvedValue({ ok: true, count: 0, outboxIds: [] });
    mocks.reconcile.mockReset().mockResolvedValue({
      considered: 0,
      recovered: 0,
      safelyReset: 0,
      needsReview: 0,
      attachmentChecked: 0,
      attachmentDrifted: 0,
    });
    mocks.from.mockReset();
    inventoryQueries();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("rejects callers without the scheduler secret", async () => {
    const { GET } = await import("@/app/api/cron/sms-outbox/route");
    const response = await GET(request("wrong"));

    expect(response.status).toBe(401);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("returns 200 only when dispatch and post-run inventories are healthy", async () => {
    const { GET } = await import("@/app/api/cron/sms-outbox/route");
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, alerts: [], dueBacklogCount: 0, quarantinedNumberCount: 0 });
  });

  it("returns 503 for an unknown submission inventory so a five-minute monitor alerts", async () => {
    mocks.unknownInventory.mockResolvedValue({
      ok: true,
      count: 1,
      outboxIds: ["outbox-1"],
    });
    const { GET } = await import("@/app/api/cron/sms-outbox/route");
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.alerts).toContain("unknown_submission_inventory_nonempty");
  });

  it("returns 503 when the claim RPC is unavailable even if the count is zero", async () => {
    mocks.dispatch.mockResolvedValue({
      ok: false,
      claimed: 0,
      submitted: 0,
      blocked: 0,
      unknown: 0,
      infrastructureErrors: ["outbox_claim_unavailable"],
    });
    const { GET } = await import("@/app/api/cron/sms-outbox/route");
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.alerts).toContain("dispatcher_infrastructure_unavailable");
    expect(body.infrastructureErrors).toEqual(["outbox_claim_unavailable"]);
  });

  it("returns 503 while due messages or quarantined numbers remain after the run", async () => {
    inventoryQueries({ due: 2, quarantined: 1 });
    const { GET } = await import("@/app/api/cron/sms-outbox/route");
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.alerts).toEqual(
      expect.arrayContaining([
        "due_outbox_backlog_nonempty",
        "number_quarantine_inventory_nonempty",
      ]),
    );
  });
});
