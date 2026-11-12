import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({ manager: vi.fn(), workspace: vi.fn(), perm: vi.fn(), record: vi.fn(), candidates: vi.fn() }));
vi.mock("@/lib/channel-calendar/require-manager.server", () => ({ requireBookingsManager: m.manager }));
vi.mock("@/lib/workspaces/active.server", () => ({ resolveActiveWorkspaceFromRequest: m.workspace }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({ managerHasCoManagerPermissionForProperty: m.perm, managerCanWriteCalendarForProperty: vi.fn() }));
vi.mock("@/lib/channel-finance/store.server", () => ({ recordFinanceFacts: m.record, loadFinanceCandidates: m.candidates }));

import { requireChannelFinanceContext } from "@/lib/channel-finance/access.server";
import { POST } from "@/app/api/portal/channel-finance/import/route";

const ws = { id: "ws-1", ownerUserId: "owner-1", owned: false, isDefault: true, propertyIds: ["p1", "p2"], name: "W" };
const csv = "Date,Type,Confirmation Code,Start date,End date,Guest,Listing,Currency,Amount,Paid out,Service fee,Gross earnings\n10/08/2026,Reservation,HMABC12345,10/07/2026,10/11/2026,Juan,Room 6,USD,465.60,465.60,14.40,480.00\n";
const req = () => new Request("http://x/api", { method: "POST", body: JSON.stringify({ platform: "airbnb", csv, commit: true }) });

beforeEach(() => {
  vi.clearAllMocks();
  m.manager.mockResolvedValue({ db: {}, userId: "co-1" });
  m.workspace.mockResolvedValue(ws);
  m.candidates.mockResolvedValue([]);
  m.record.mockResolvedValue({ id: "r", reviewStatus: "needs_room", created: true, unchanged: false });
});

describe("channel finance access", () => {
  it("a co-manager with Payments edit imports under the workspace OWNER and workspace id, never their own id", async () => {
    m.perm.mockResolvedValue(true);
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(m.perm).toHaveBeenCalledWith({}, "co-1", "p1", "payments", "edit");
    expect(m.record).toHaveBeenCalledTimes(1);
    expect(m.record.mock.calls[0]![1]).toMatchObject({ ownerUserId: "owner-1", workspaceId: "ws-1", source: "csv" });
    expect(m.candidates).toHaveBeenCalledWith({}, { ownerUserId: "owner-1", workspaceId: "ws-1" });
  });
  it("a viewer without Payments edit on the workspace is refused and nothing is written", async () => {
    m.perm.mockResolvedValue(false);
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(m.record).not.toHaveBeenCalled();
  });
  it("the owner needs no per-house grant; the scope names the owner's workspace", async () => {
    m.manager.mockResolvedValue({ db: {}, userId: "owner-1" });
    const ctx = await requireChannelFinanceContext("edit");
    expect(ctx?.scope).toEqual({ ownerUserId: "owner-1", workspaceId: "ws-1", includeUnplaced: true });
    expect(m.perm).not.toHaveBeenCalled();
  });
  it("read-only access is enough to read but not to edit", async () => {
    m.perm.mockImplementation(async (_d, _u, _p, _m, level) => level === "read");
    expect(await requireChannelFinanceContext("read")).not.toBeNull();
    expect(await requireChannelFinanceContext("edit")).toBeNull();
  });
});
