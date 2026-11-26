import { describe, expect, it, vi } from "vitest";

const props = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/lib/tools/domains/bookings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tools/domains/bookings")>()),
  calendarReadableProperties: props.list,
}));

import { getRoomDoorCodeTool, roomDoorCodeFromSubmission } from "@/lib/tools/domains/room-access";

const submission = { rooms: [{ id: "r6", name: "Room 6", doorCode: "6666" }, { id: "r4", name: "Room 4", doorCode: "4444" }, { id: "r2", name: "Room 2" }] };
const house = (id: string, title: string) => ({ id, ownerId: "m", title, rooms: new Map([["r6", "Room 6"], ["r4", "Room 4"], ["r2", "Room 2"]]), hasRooms: true, submission });
const owner = { managerSmsAccess: undefined } as never;

describe("get_room_door_code (manager)", () => {
  it("the owner gets any room's code by house + room display name", async () => {
    props.list.mockResolvedValue([house("p1", "5257 Brooklyn Ave NE"), house("p2", "5259 Brooklyn Ave NE")]);
    const out = await getRoomDoorCodeTool.handler(owner, { house: "5257", room: "Room 6" });
    expect(out).toMatchObject({ house: "5257 Brooklyn Ave NE", room: "Room 6", doorCode: "6666" });
    expect(await getRoomDoorCodeTool.handler(owner, { house: "5257", room: "4" })).toMatchObject({ doorCode: "4444" });
  });

  it("says so when the room has no code, and asks when the house is ambiguous", async () => {
    props.list.mockResolvedValue([house("p1", "5257 Brooklyn Ave NE"), house("p2", "5259 Brooklyn Ave NE")]);
    expect(await getRoomDoorCodeTool.handler(owner, { house: "5257", room: "Room 2" })).toMatchObject({ doorCode: null });
    await expect(getRoomDoorCodeTool.handler(owner, { house: "Brooklyn", room: "Room 6" })).rejects.toThrow(/More than one house/);
    await expect(getRoomDoorCodeTool.handler(owner, { house: "9999", room: "Room 6" })).rejects.toThrow(/No house matches/);
  });

  it("a delegated seat is refused", async () => {
    await expect(getRoomDoorCodeTool.handler({ managerSmsAccess: { mode: "delegated" } } as never, { house: "5257", room: "6" })).rejects.toThrow(/not available/);
  });

  it("reads the code off the listing submission only", () => {
    expect(roomDoorCodeFromSubmission(submission, "r6")).toBe("6666");
    expect(roomDoorCodeFromSubmission(submission, "nope")).toBe("");
    expect(roomDoorCodeFromSubmission(null, "r6")).toBe("");
  });
});
