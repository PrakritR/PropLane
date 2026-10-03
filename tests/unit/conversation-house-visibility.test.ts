import { describe, expect, it } from "vitest";
import {
  restrictThreadToHouses,
  threadHouseIds,
  viewerHoldsEveryHouse,
} from "@/lib/communication/conversation-house-filter";
import {
  conversationVisible,
  filterVisibleInboxThreadRecords,
  type CommunicationScope,
} from "@/lib/communication/conversation-visibility.server";
import { createConversationFakeDb } from "../helpers/conversation-fake-db";

/**
 * D2 (captain-approved, comms-safety-0929): a co-manager granted only some
 * houses sees only the messages about their houses; a message with no house
 * shows only to someone who holds every house of that person. Closes S9.
 */

const OWNER = "owner-1";
const CO = "co-1";

function view(allowed: string[], person: string[]) {
  return { allowed: new Set(allowed), personHouses: new Set(person) };
}

const merged = (): Record<string, unknown> => ({
  id: "t1",
  folder: "inbox",
  from: "Resident",
  email: "r@x.co",
  conversationKey: "acct:r1",
  body: "root about house 1",
  rootAt: "Oct 1, 9:00 AM",
  rootHouseId: "H1",
  rootMessageId: "m0",
  time: "Oct 3, 9:00 AM",
  preview: "latest",
  messages: [
    { id: "m1", from: "Manager", body: "about house 2", at: "Oct 2, 9:00 AM", houseId: "H2", outbound: true },
    { id: "m2", from: "Resident", body: "about house 1 again", at: "Oct 2, 10:00 AM", houseId: "H1" },
    { id: "m3", from: "Resident", body: "no house at all", at: "Oct 3, 9:00 AM" },
  ],
});

describe("restrictThreadToHouses - only the turns about the viewer's houses", () => {
  it("a co-manager on house 1 does not see house 2's turn, nor the turn with no house", () => {
    const restricted = restrictThreadToHouses(merged(), view(["H1"], ["H1", "H2"]))!;
    expect(restricted.body).toBe("root about house 1");
    expect((restricted.messages as { id: string }[]).map((m) => m.id)).toEqual(["m2"]);
    expect(restricted.housesRestricted).toBe(true);
    expect(restricted.preview).toBe("about house 1 again");
  });

  it("a co-manager holding every house of the person sees the turn with no house", () => {
    const restricted = restrictThreadToHouses(merged(), view(["H1", "H2"], ["H1", "H2"]));
    // Nothing hidden: the very same object comes back.
    expect(restricted).toEqual(merged());
    expect(viewerHoldsEveryHouse(view(["H1", "H2"], ["H1", "H2"]))).toBe(true);
  });

  it("when the root turn is about a house they lack, the first visible turn becomes the root", () => {
    const restricted = restrictThreadToHouses(merged(), view(["H2"], ["H1", "H2"]))!;
    expect(restricted.body).toBe("about house 2");
    expect(restricted.rootMessageId).toBe("m1");
    expect(restricted.rootOutbound).toBe(true);
    expect(restricted.messages).toEqual([]);
  });

  it("a conversation with nothing about their houses is not theirs at all", () => {
    expect(restrictThreadToHouses(merged(), view(["H9"], ["H1", "H2"]))).toBeNull();
  });

  it("a person with no known houses shows no untagged turn to anyone", () => {
    expect(viewerHoldsEveryHouse(view(["H1"], []))).toBe(false);
  });

  it("a legacy property thread is one house: its row-level propertyId stands in for every unstamped turn", () => {
    const legacy = {
      id: "p1",
      email: "r@x.co",
      propertyId: "H2",
      body: "old",
      messages: [{ id: "a", body: "older reply", at: "Oct 1" }],
    };
    expect(restrictThreadToHouses(legacy, view(["H1"], ["H1", "H2"]))).toBeNull();
    expect(restrictThreadToHouses(legacy, view(["H2"], ["H1", "H2"]))).toBe(legacy);
  });

  it("names every house a thread's turns mention", () => {
    expect(threadHouseIds(merged()).sort()).toEqual(["H1", "H2"]);
    expect(threadHouseIds({ propertyId: "H7", messages: [] })).toEqual(["H7"]);
    expect(threadHouseIds(null)).toEqual([]);
  });
});

function coScope(granted: string[]): CommunicationScope {
  return {
    viewerId: CO,
    level: "read",
    ownerIds: [CO, OWNER],
    grantedHousesByOwner: new Map([[OWNER, new Set(granted)]]),
    workspaceHouseIds: null,
    untaggedOwnedVisible: true,
    activeWorkspaceId: null,
    workspaceByLine: new Map(),
  };
}

function record(id: string, rowData: Record<string, unknown>, owner = OWNER) {
  return { id, owner_user_id: owner, participant_email: null, thread_type: "portal_message", row_data: rowData };
}

describe("filterVisibleInboxThreadRecords applies D2 to another owner's thread", () => {
  it("narrows the merged conversation to the granted house and its house label", async () => {
    const db = createConversationFakeDb({});
    const [only] = await filterVisibleInboxThreadRecords(db, coScope(["H1"]), [record("t1", merged())]);
    expect(only).toBeDefined();
    expect((only!.row_data as { messages: { id: string }[] }).messages.map((m) => m.id)).toEqual(["m2"]);
    expect(only!.houses.map((h) => h.propertyId)).toEqual(["H1"]);
  });

  it("shows everything to a viewer granted every house of the person", async () => {
    const db = createConversationFakeDb({});
    const [full] = await filterVisibleInboxThreadRecords(db, coScope(["H1", "H2"]), [record("t1", merged())]);
    expect((full!.row_data as { messages: unknown[] }).messages).toHaveLength(3);
  });

  it("drops a conversation that is only about a house they do not hold", async () => {
    const db = createConversationFakeDb({});
    const house2 = { ...merged(), rootHouseId: "H2", messages: [{ id: "x", body: "h2", at: "Oct 2", houseId: "H2" }] };
    const result = await filterVisibleInboxThreadRecords(db, coScope(["H1"]), [record("t2", house2)]);
    expect(result).toEqual([]);
  });

  it("never filters the owner's own conversation", async () => {
    const db = createConversationFakeDb({});
    const ownerScope: CommunicationScope = { ...coScope(["H1"]), viewerId: OWNER, ownerIds: [OWNER], grantedHousesByOwner: new Map() };
    const [mine] = await filterVisibleInboxThreadRecords(db, ownerScope, [record("t1", merged())]);
    expect((mine!.row_data as { messages: unknown[] }).messages).toHaveLength(3);
  });
});

describe("conversationVisible - an SMS conversation's turns carry no house", () => {
  const scope = coScope(["H1"]);
  it("a partial grant does not read texts about a house it was never granted", () => {
    expect(conversationVisible(scope, { ownerId: OWNER, houseIds: ["H1", "H2"], untaggedTurns: true })).toBe(false);
  });
  it("a grant on every house of the conversation reads it", () => {
    expect(conversationVisible(coScope(["H1", "H2"]), { ownerId: OWNER, houseIds: ["H1", "H2"], untaggedTurns: true })).toBe(true);
    expect(conversationVisible(scope, { ownerId: OWNER, houseIds: ["H1"], untaggedTurns: true })).toBe(true);
  });
  it("tagged turns (email / in-app) keep the any-house gate and are filtered per turn", () => {
    expect(conversationVisible(scope, { ownerId: OWNER, houseIds: ["H1", "H2"] })).toBe(true);
  });
});
