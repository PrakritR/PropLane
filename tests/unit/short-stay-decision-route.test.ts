import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
let manager: { db: unknown; userId: string } | null = null;
vi.mock("@/lib/channel-calendar/require-manager.server", () => ({ requireBookingsManager: async () => manager }));
const canWrite = vi.fn(async (..._args: unknown[]) => false);
vi.mock("@/lib/auth/manager-lease-scope", () => ({ managerCanWriteCalendarForProperty: (...args: unknown[]) => canWrite(...args) }));
const decide = vi.fn();
vi.mock("@/lib/short-stay/hold-decisions.server", () => ({ decideShortStayHold: (...args: unknown[]) => decide(...args) }));

import { POST } from "@/app/api/portal/bookings/short-stay-decision/route";

function dbWith(record: { manager_user_id: string; property_id: string } | null) {
  return { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: record }) }) }) }) };
}
const post = (body: unknown) => POST(new Request("http://localhost/api/portal/bookings/short-stay-decision", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  canWrite.mockResolvedValue(false);
  manager = { db: dbWith({ manager_user_id: "owner-1", property_id: "p1" }), userId: "owner-1" };
});

describe("POST /api/portal/bookings/short-stay-decision", () => {
  it("refuses a visitor", async () => {
    manager = null;
    expect((await post({ blockId: "b1", decision: "approve" })).status).toBe(401);
  });

  it("the owner approves or declines", async () => {
    decide.mockResolvedValue({ ok: true, outcome: "confirmed", decision: "approve", chargeCreated: true });
    const res = await post({ blockId: "b1", decision: "approve" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, outcome: "confirmed", chargeCreated: true });
    expect(decide).toHaveBeenCalledWith(expect.anything(), { blockId: "b1", decision: "approve" });
  });

  it("another manager is refused unless they hold Calendar edit on the house", async () => {
    manager = { db: dbWith({ manager_user_id: "owner-1", property_id: "p1" }), userId: "someone-else" };
    expect((await post({ blockId: "b1", decision: "approve" })).status).toBe(403);
    expect(decide).not.toHaveBeenCalled();
    canWrite.mockResolvedValue(true);
    decide.mockResolvedValue({ ok: true, outcome: "cancelled", decision: "decline", chargeCreated: false });
    expect((await post({ blockId: "b1", decision: "decline" })).status).toBe(200);
    expect(canWrite).toHaveBeenCalledWith(expect.anything(), "someone-else", "p1");
  });

  it("rejects an unknown booking, a missing id and an answer that is not approve or decline", async () => {
    manager = { db: dbWith(null), userId: "owner-1" };
    expect((await post({ blockId: "gone", decision: "approve" })).status).toBe(404);
    expect((await post({ decision: "approve" })).status).toBe(400);
    expect((await post({ blockId: "b1", decision: "expire" })).status).toBe(400);
  });

  it("passes the writer's refusal through (an answered request is a 409)", async () => {
    decide.mockResolvedValue({ ok: false, status: 409, error: "That request was already answered." });
    const res = await post({ blockId: "b1", decision: "approve" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("That request was already answered.");
  });
});
