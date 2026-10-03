import { describe, expect, it } from "vitest";
import {
  clearedInboxThreadRowData,
  mergeInboxThreadRowData,
  storedThreadMessageIds,
  type ThreadAppendRule,
} from "@/lib/communication/shared-thread-merge";

/**
 * Conversation history is append-only. A body is a client's CLAIM about
 * history - it can add a turn, never remove, reorder or rewrite one - and on
 * another owner's conversation a delegate may only add their own outgoing turns
 * about houses they hold.
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
  messages: [
    { id: "m1", body: "about house 1", at: "Oct 2, 9:00 AM", houseId: "H1" },
    { id: "m2", body: "about house 2", at: "Oct 2, 10:00 AM", houseId: "H2" },
  ],
});

const owner: ThreadAppendRule = { kind: "owner" };
const delegate = (houses: string[]): ThreadAppendRule => ({
  kind: "delegate",
  allowedHouses: new Set(houses),
  authorUserId: "co-1",
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

  it("accepts a turn the viewer is adding, appended after the stored ones", () => {
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
    // The list GET folds several rows into one conversation, so the body
    // legitimately carries the siblings' turns.
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

describe("what a delegate may add to another owner's conversation", () => {
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

  it("accepts their own outgoing turn about a house they hold, stamped with who typed it", () => {
    const own = {
      ...stored(),
      messages: [...stored().messages, { id: "x", outbound: true, houseId: "H1", body: "on my way", at: "Oct 4" }],
    };
    const result = merge(own, delegate(["H1"]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const added = (result.rowData.messages as { id: string; authorUserId?: string }[]).at(-1);
    expect(added).toMatchObject({ id: "x", authorUserId: "co-1" });
  });

  it("accepts an untagged outgoing reply - the thread's own house covers it", () => {
    const untagged = {
      ...stored(),
      messages: [...stored().messages, { id: "x", outbound: true, body: "thanks", at: "Oct 4" }],
    };
    expect(merge(untagged, delegate(["H1"])).ok).toBe(true);
  });

  it("a mailbox-only save with nothing new is always fine", () => {
    expect(merge({ ...stored(), unread: false }, delegate([])).ok).toBe(true);
  });
});

describe("the explicit clear", () => {
  it("empties the turns and keeps the conversation", () => {
    const cleared = clearedInboxThreadRowData(
      { ...stored(), aiDraft: { text: "draft" }, aiDraftQueue: ["x"] },
      { preview: "Ask me anything", subject: "PropLane Assistant", from: "PropLane Assistant" },
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
  });

  it("names every message a row accounts for, its derived root included", () => {
    expect(storedThreadMessageIds(stored())).toEqual(["m0", "m1", "m2"]);
    expect(storedThreadMessageIds(null)).toEqual([]);
  });
});
