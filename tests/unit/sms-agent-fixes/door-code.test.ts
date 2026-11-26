import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeHouseInfo } from "@/lib/house-info";
import { matchResidentFastPath, type FastPathFacts } from "@/lib/one-number/resident-fast-path";

const houseInfo = normalizeHouseInfo({ access: { doorCode: "5257#" } });
const own = { houseLabel: "5257 Brooklyn Ave NE", roomLabel: "Room 4", roomDoorCode: "4444", roomCodesExist: true };
const facts = (over: Partial<FastPathFacts> = {}): FastPathFacts => ({ houseInfo, knowledge: [], own, ...over });

describe("door code fast path: the resident's own room code goes with the front door", () => {
  it("answers with the front door AND the resident's own room code", () => {
    expect(matchResidentFastPath("What's my door code?", facts())?.reply).toBe("Door code 5257#, your room (Room 4) code 4444.");
  });

  it("never answers with the front door alone when the house has room codes but this resident's is unknown", () => {
    expect(matchResidentFastPath("What's my door code?", facts({ own: { ...own, roomDoorCode: null } }))).toBeNull();
  });

  it("a house with no room codes still answers with the front door", () => {
    expect(matchResidentFastPath("door code?", facts({ own: { ...own, roomDoorCode: null, roomCodesExist: false } }))?.reply).toBe("Door code 5257#.");
  });

  it("another room's code is never given: a question naming a different room goes to the agent", () => {
    expect(matchResidentFastPath("door code for Room 6", facts())).toBeNull();
    expect(matchResidentFastPath("door code for room 4", facts())?.reply).toContain("4444");
  });

  it("a question about another house is not answered with this house's codes", () => {
    expect(matchResidentFastPath("front door code for the 4709A house?", facts())).toBeNull();
    expect(matchResidentFastPath("front door code for the other house?", facts())).toBeNull();
  });

  it("before the reveal there are no secrets in the facts, so nothing is answered", () => {
    expect(matchResidentFastPath("door code?", facts({ houseInfo: null, own: undefined }))).toBeNull();
  });
});

const scope = vi.hoisted(() => ({ resolve: vi.fn(), owned: vi.fn(), entries: vi.fn(), moveIn: vi.fn() }));
vi.mock("@/lib/one-number/knowledge/scope.server", () => ({ resolveResidentKnowledgeScope: scope.resolve, loadOwnedProperty: scope.owned }));
vi.mock("@/lib/one-number/knowledge/store.server", () => ({ loadAnswerableEntries: scope.entries }));
vi.mock("@/lib/tools/domains/resident/lease", () => ({ loadOwnResolvedMoveIn: scope.moveIn }));

import { tryResidentFastPath } from "@/lib/one-number/resident-fast-path.server";

const resident = (over: Record<string, unknown> = {}) => ({
  ok: true,
  scope: { viewer: "resident", workspaceId: "ws1", ownerUserId: "o1", allowedPropertyIds: ["h1"], focusPropertyId: "h1", audiences: ["all"], includeHouseInfo: true, includeHouseSecrets: true, ...over },
});

describe("tryResidentFastPath reads the resident's own room code under the same reveal as the portal", () => {
  beforeEach(() => {
    scope.resolve.mockReset().mockResolvedValue(resident());
    scope.owned.mockReset().mockResolvedValue({ id: "h1", workspaceId: "ws1", label: "5257 Brooklyn Ave NE", houseInfo, roomSecrets: ["4444", "6666"] });
    scope.entries.mockReset().mockResolvedValue([]);
    scope.moveIn.mockReset().mockResolvedValue({ roomLabel: "Room 4", roomDoorCode: "4444" });
  });

  it("after the reveal: front door + own room, never another room's", async () => {
    const out = await tryResidentFastPath({} as never, {} as never, "What's my door code?");
    expect(out?.reply).toBe("Door code 5257#, your room (Room 4) code 4444.");
    expect(out?.reply).not.toContain("6666");
  });

  it("before the reveal the resident's own room is not even read", async () => {
    scope.resolve.mockResolvedValue(resident({ includeHouseSecrets: false }));
    await expect(tryResidentFastPath({} as never, {} as never, "What's my door code?")).resolves.toBeNull();
    expect(scope.moveIn).not.toHaveBeenCalled();
  });

  it("a failed room read falls back to the agent, never to the front door alone", async () => {
    scope.moveIn.mockRejectedValue(new Error("db down"));
    await expect(tryResidentFastPath({} as never, {} as never, "What's my door code?")).resolves.toBeNull();
  });

  it("a non-door question does not pay for the room read", async () => {
    await tryResidentFastPath({} as never, {} as never, "what day is trash");
    expect(scope.moveIn).not.toHaveBeenCalled();
  });
});
