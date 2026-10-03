import { describe, expect, it } from "vitest";
import {
  clearedInboxThreadRowData,
  mergeInboxThreadRowData,
  storedThreadMessageIds,
  type ThreadAppendRule,
} from "@/lib/communication/shared-thread-merge";

/**
 * Conversation history is append-only. A body is a client's CLAIM about
 * history - it can add a turn, never remove, reorder or rewrite one - and a turn
 * added to a row the caller does not own is attributed by the SERVER, from who
 * the caller is to that conversation.
 */

const stored = () => ({
  id: "t1",
  folder: "inbox",
  unread: true,
  from: "Resident",
  conversationKey: "acct:r1",
  rootMessageId: "m0",
  body: "root",
  time: "Oct 1, 9:00 AM",
  preview: "root",
  propertyId: "H1",
  messages: [
    { id: "m1", body: "about house 1", at: "Oct 2, 9:00 AM", houseId: "H1" },
    { id: "m2", body: "about house 2", at: "Oct 2, 10:00 AM", houseId: "H2" },
  ],
});

const owner: ThreadAppendRule = { kind: "owner" };
const delegate = (houses: string[], conversationHouseIds = ["H1", "H2"]): ThreadAppendRule => ({
  kind: "delegate",
  allowedHouses: new Set(houses),
  conversationHouseIds,
  authorUserId: "co-1",
  authorName: "Dana Co-Manager",
});
const participant = (conversationHouseId = "H1"): ThreadAppendRule => ({
  kind: "participant",
  authorUserId: "res-1",
  authorName: "Rae Resident",
  conversationHouseId,
});

function merge(requested: Record<string, unknown>, rule: ThreadAppendRule = owner, knownElsewhere?: string[]) {
  return mergeInboxThreadRowData({ stored: stored(), requested, rule, knownElsewhere });
}

describe("append-only for every caller", () => {
  it("keeps every stored turn when the body is missing the ones it never saw", () => {
    const filteredCopy = { ...stored(), unread: false, messages: [stored().messages[0]!] };
    const result = merge(filteredCopy, delegate(["H1"]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.rowData.messages as { id: string }[]).map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(result.rowData.unread).toBe(false);
  });

  it("the OWNER cannot delete or rewrite their own stored turns either", () => {
    const rewritten = {
      ...stored(),
      messages: [{ id: "m2", body: "forged", at: "Oct 2, 10:00 AM", houseId: "H1" }],
    };
    const result = merge(rewritten);
    expect(result.ok && result.rowData.messages).toEqual(stored().messages);
  });

  it("accepts a turn the owner is adding, appended after the stored ones", () => {
    const withReply = {
      ...stored(),
      messages: [stored().messages[0]!, { id: "m3", body: "my reply", at: "Oct 3, 8:00 AM", outbound: true }],
    };
    const result = merge(withReply);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.rowData.messages as { id: string }[]).map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(result.rowData.time).toBe("Oct 3, 8:00 AM");
    expect(result.rowData.preview).toBe("my reply");
  });

  it("cannot replay the derived root as a new turn", () => {
    const replay = { ...stored(), messages: [{ id: "t1-root", body: "root", at: "Oct 1, 9:00 AM" }] };
    const result = merge(replay);
    expect(result.ok && (result.rowData.messages as { id: string }[]).map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("does not duplicate a sibling row's turns back into the canonical row", () => {
    const collapsed = {
      ...stored(),
      messages: [...stored().messages, { id: "s1", body: "from the archived row", at: "Sep 1" }],
    };
    const result = merge(collapsed, owner, ["s1"]);
    expect(result.ok && (result.rowData.messages as { id: string }[]).map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("carries the mailbox move the viewer made, and remembers where it came from", () => {
    const result = merge({ ...stored(), folder: "trash" });
    expect(result.ok && result.rowData.folder).toBe("trash");
    expect(result.ok && result.rowData.previousFolder).toBe("inbox");
  });

  it("ignores a folder the client invented", () => {
    const result = merge({ ...stored(), folder: "somewhere-else" });
    expect(result.ok && result.rowData.folder).toBe("inbox");
  });

  it("never loses the stored identity fields to a body that omits them", () => {
    const result = merge({ id: "t1", messages: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rowData.from).toBe("Resident");
    expect(result.rowData.conversationKey).toBe("acct:r1");
    expect((result.rowData.messages as unknown[]).length).toBe(2);
  });
});

describe("what a co-manager may add to another owner's conversation", () => {
  it("refuses an invented INBOUND turn - only the counterparty speaks for themselves", () => {
    const forged = {
      ...stored(),
      messages: [
        ...stored().messages,
        { id: "x", outbound: false, from: "Resident", houseId: "H1", body: "I agreed to this" },
      ],
    };
    expect(merge(forged, delegate(["H1", "H2"]))).toEqual({
      ok: false,
      reason: "inbound_turn_not_authorable",
    });
  });

  it("refuses an outgoing turn about a house they were never granted", () => {
    const wrongHouse = {
      ...stored(),
      messages: [...stored().messages, { id: "x", outbound: true, houseId: "H2", body: "hi" }],
    };
    expect(merge(wrongHouse, delegate(["H1"]))).toEqual({ ok: false, reason: "house_not_granted" });
  });

  it("attributes the turn to the CALLER, whatever the body claims", () => {
    const impersonating = {
      ...stored(),
      messages: [
        ...stored().messages,
        { id: "x", outbound: true, houseId: "H1", from: "The Owner", body: "on my way", at: "Oct 4" },
      ],
    };
    const result = merge(impersonating, delegate(["H1"]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const added = (result.rowData.messages as { from: string; authorUserId?: string }[]).at(-1);
    expect(added).toMatchObject({ from: "Dana Co-Manager", authorUserId: "co-1", outbound: true });
  });

  it("stamps the house when the conversation has exactly one they hold", () => {
    const untagged = {
      ...stored(),
      messages: [...stored().messages, { id: "x", outbound: true, body: "thanks", at: "Oct 4" }],
    };
    const result = merge(untagged, delegate(["H1"]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.rowData.messages as { houseId?: string }[]).at(-1)?.houseId).toBe("H1");
  });

  it("allows an untagged reply when they hold EVERY house the conversation names", () => {
    // The write side of the read rule: an untagged turn is only readable by a
    // viewer who holds every house, so it is only writable by one.
    const untagged = {
      ...stored(),
      messages: [...stored().messages, { id: "x", outbound: true, body: "thanks", at: "Oct 4" }],
    };
    const result = merge(untagged, delegate(["H1", "H2"]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const added = (result.rowData.messages as Record<string, unknown>[]).at(-1)!;
    expect(added.houseId).toBeUndefined();
    expect(added).toMatchObject({ from: "Dana Co-Manager", outbound: true });
  });

  it("allows an untagged reply on a conversation that names no house at all", () => {
    const noHouses = {
      ...stored(),
      messages: [...stored().messages, { id: "x", outbound: true, body: "thanks", at: "Oct 4" }],
    };
    expect(merge(noHouses, delegate(["H1", "H2"], [])).ok).toBe(true);
  });

  it("names their single granted house for them on a partly granted conversation", () => {
    const untagged = {
      ...stored(),
      messages: [...stored().messages, { id: "x", outbound: true, body: "thanks", at: "Oct 4" }],
    };
    const result = merge(untagged, delegate(["H1"], ["H1", "H2", "H3"]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.rowData.messages as { houseId?: string }[]).at(-1)?.houseId).toBe("H1");
  });

  it("refuses an untagged turn when they hold only SOME of the houses and several of them", () => {
    // No single house to name and not every house of the conversation: the
    // reply has to say which one it is about.
    const untagged = {
      ...stored(),
      messages: [...stored().messages, { id: "x", outbound: true, body: "thanks", at: "Oct 4" }],
    };
    expect(merge(untagged, delegate(["H1", "H2"], ["H1", "H2", "H3"]))).toEqual({
      ok: false,
      reason: "house_not_granted",
    });
  });

  it("a mailbox-only save with nothing new is always fine", () => {
    expect(merge({ ...stored(), unread: false }, delegate([])).ok).toBe(true);
  });
});

describe("what the person a conversation is WITH may add to the owner's row", () => {
  it("their reply is stored as the counterparty speaking, attributed to them", () => {
    // The client stamps its own reply `outbound: true`; on the owner's row the
    // owner's side is outbound, so a participant's turn can only be inbound.
    const theirReply = {
      ...stored(),
      messages: [
        ...stored().messages,
        { id: "x", outbound: true, from: "Property manager", body: "when can you come?", at: "Oct 4" },
      ],
    };
    const result = merge(theirReply, participant());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const added = (result.rowData.messages as Record<string, unknown>[]).at(-1);
    expect(added).toMatchObject({
      from: "Rae Resident",
      outbound: false,
      authorUserId: "res-1",
      houseId: "H1",
      body: "when can you come?",
    });
  });

  it("still cannot delete the owner's turns", () => {
    const result = merge({ ...stored(), messages: [] }, participant());
    expect(result.ok && result.rowData.messages).toEqual(stored().messages);
  });
});

describe("a caller who is neither the owner, a granted co-manager, nor the participant", () => {
  it("can change mailbox state but can add nothing", () => {
    const stranger: ThreadAppendRule = {
      kind: "delegate",
      allowedHouses: new Set<string>(),
      conversationHouseIds: [],
      authorUserId: "x-1",
      authorName: "Nobody",
    };
    expect(merge({ ...stored(), unread: false }, stranger).ok).toBe(true);
    const withTurn = { ...stored(), messages: [...stored().messages, { id: "x", outbound: true, body: "hi" }] };
    expect(merge(withTurn, stranger)).toEqual({ ok: false, reason: "house_not_granted" });
  });
});

describe("the explicit clear", () => {
  it("empties the turns, keeps the conversation, and tombstones what it removed", () => {
    const cleared = clearedInboxThreadRowData(
      { ...stored(), aiDraft: { text: "draft" }, aiDraftQueue: ["x"] },
      { preview: "Ask me anything", subject: "PropLane Assistant", from: "PropLane Assistant" },
      "2026-10-04T00:00:00.000Z",
    );
    expect(cleared.messages).toEqual([]);
    expect(cleared.body).toBe("");
    expect(cleared.preview).toBe("Ask me anything");
    expect(cleared.subject).toBe("PropLane Assistant");
    expect(cleared.unread).toBe(false);
    expect(cleared.aiDraft).toBeUndefined();
    expect(cleared.aiDraftQueue).toBeUndefined();
    expect(cleared.rootMessageId).toBeUndefined();
    expect(cleared.conversationKey).toBe("acct:r1");
    expect(cleared.clearedAt).toBe("2026-10-04T00:00:00.000Z");
    expect(cleared.clearedMessageIds).toEqual(["m0", "m1", "m2"]);
  });

  it("a stale tab cannot put the cleared turns back", () => {
    const cleared = clearedInboxThreadRowData(stored(), { preview: "" });
    // The second tab still holds the pre-clear copy and marks the row read.
    const result = mergeInboxThreadRowData({
      stored: cleared,
      requested: { ...stored(), unread: false },
      rule: owner,
    });
    expect(result.ok && result.rowData.messages).toEqual([]);
    expect(result.ok && result.rowData.unread).toBe(false);
  });

  it("a second clear keeps the ids it is removing, dropping the oldest tombstones instead", () => {
    const alreadyCleared = clearedInboxThreadRowData(stored(), { preview: "" });
    const withNewTurns = {
      ...alreadyCleared,
      messages: [{ id: "later-1", body: "new", at: "Oct 5" }],
    };
    const cleared = clearedInboxThreadRowData(withNewTurns, { preview: "" });
    expect(cleared.clearedMessageIds).toEqual(["m0", "m1", "m2", "later-1"]);
    const result = mergeInboxThreadRowData({
      stored: cleared,
      requested: { ...withNewTurns, unread: false },
      rule: owner,
    });
    expect(result.ok && result.rowData.messages).toEqual([]);
  });

  it("names every message a row accounts for, tombstones included", () => {
    expect(storedThreadMessageIds(stored())).toEqual(["m0", "m1", "m2"]);
    expect(storedThreadMessageIds({ messages: [], clearedMessageIds: ["gone"] })).toEqual(["gone"]);
    expect(storedThreadMessageIds(null)).toEqual([]);
  });
});
