import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const listGuestStays = vi.fn();
const loadStayCheckIn = vi.fn();
vi.mock("@/lib/short-stay/guest-stays.server", () => ({ listGuestStays: (...a: unknown[]) => listGuestStays(...a) }));
vi.mock("@/lib/check-in.server", () => ({ loadStayCheckIn: (...a: unknown[]) => loadStayCheckIn(...a) }));
vi.mock("@/lib/room-availability-range", () => ({ pacificTodayKey: () => "2026-12-01" }));

const { getMyStayCheckInTool } = await import("@/lib/tools/domains/resident/stay-check-in");

const ctx = { kind: "resident", userId: "guest-1", email: "g@example.com", db: {} } as never;
const guide = (revealed: boolean) => ({
  revealed,
  reason: revealed ? "revealed" : "before_window",
  unlockLabel: revealed ? null : "Wed 10:00 AM",
  steps: [
    { id: "room", title: "Your room: Room 4", lines: [], secrets: [{ label: "Room code", value: revealed ? "4444" : null }], photoUrl: null, mapsUrl: null, missingCode: false },
  ],
  checkedInAt: null,
  checkInKey: "stay:b1",
});

describe("get_my_stay_check_in", () => {
  beforeEach(() => {
    listGuestStays.mockReset();
    loadStayCheckIn.mockReset();
  });

  it("is read-only and takes no input, so the model can never name another guest or stay", () => {
    expect(getMyStayCheckInTool.kind).toBe("read");
    expect(getMyStayCheckInTool.inputSchema.safeParse({}).success).toBe(true);
    expect(getMyStayCheckInTool.inputSchema.safeParse({ userId: "someone-else" }).success).toBe(false);
  });

  it("reads the signed-in login's own stays and passes a masked guide through untouched before the reveal", async () => {
    listGuestStays.mockResolvedValue([{ id: "b1", status: "confirmed", checkIn: "2026-12-10", checkOut: "2026-12-12" }]);
    loadStayCheckIn.mockResolvedValue({ guide: guide(false), propertyLabel: "5259 Brooklyn", roomLabel: "Room 4" });
    const out = (await getMyStayCheckInTool.handler(ctx, {})) as { stays: Array<{ codesUnlocked: boolean; unlocksAt: string | null; steps: Array<{ details: Array<{ value: string | null }> }> }> };
    expect(listGuestStays).toHaveBeenCalledWith({}, { userId: "guest-1" });
    expect(loadStayCheckIn).toHaveBeenCalledWith({}, "guest-1", "b1");
    expect(out.stays[0]!.codesUnlocked).toBe(false);
    expect(out.stays[0]!.unlocksAt).toBe("Wed 10:00 AM");
    expect(out.stays[0]!.steps[0]!.details[0]!.value).toBeNull();
    expect(JSON.stringify(out)).not.toContain("4444");
  });

  it("returns the code only when the guide itself is revealed", async () => {
    listGuestStays.mockResolvedValue([{ id: "b1", status: "confirmed", checkIn: "2026-12-10", checkOut: "2026-12-12" }]);
    loadStayCheckIn.mockResolvedValue({ guide: guide(true), propertyLabel: "5259 Brooklyn", roomLabel: "Room 4" });
    const out = await getMyStayCheckInTool.handler(ctx, {});
    expect(JSON.stringify(out)).toContain("4444");
  });

  it("skips a stay the loader refuses (another login's, a hold, a cancelled one) and past or unconfirmed stays", async () => {
    listGuestStays.mockResolvedValue([
      { id: "b1", status: "confirmed", checkIn: "2026-12-10", checkOut: "2026-12-12" },
      { id: "b2", status: "pending", checkIn: "2026-12-10", checkOut: "2026-12-12" },
      { id: "b3", status: "confirmed", checkIn: "2026-11-01", checkOut: "2026-11-03" },
    ]);
    loadStayCheckIn.mockResolvedValue(null);
    expect(await getMyStayCheckInTool.handler(ctx, {})).toEqual({ stays: [] });
    expect(loadStayCheckIn).toHaveBeenCalledTimes(1);
  });
});
