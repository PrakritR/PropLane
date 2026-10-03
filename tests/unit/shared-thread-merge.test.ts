import { describe, expect, it } from "vitest";
import { mergeOtherOwnersThreadRowData } from "@/lib/communication/shared-thread-merge";

/**
 * S9/D2 follow-through: a co-manager is handed a FILTERED copy of another
 * owner's conversation, so their browser's copy is not a complete row. Saving
 * it wholesale - which marking it read does - deleted the owner's turns about
 * houses the co-manager was never granted.
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

describe("mergeOtherOwnersThreadRowData", () => {
  it("keeps every stored turn when the body is missing the ones it never saw", () => {
    const filteredCopy = { ...stored(), unread: false, messages: [stored().messages[0]!] };
    const merged = mergeOtherOwnersThreadRowData(stored(), filteredCopy);
    expect((merged.messages as { id: string }[]).map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(merged.unread).toBe(false);
  });

  it("accepts a turn the viewer is adding, appended after the stored ones", () => {
    const withReply = {
      ...stored(),
      messages: [stored().messages[0]!, { id: "m3", body: "my reply", at: "Oct 3, 8:00 AM", houseId: "H1", outbound: true }],
    };
    const merged = mergeOtherOwnersThreadRowData(stored(), withReply);
    expect((merged.messages as { id: string }[]).map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(merged.time).toBe("Oct 3, 8:00 AM");
    expect(merged.preview).toBe("my reply");
  });

  it("cannot rewrite a stored turn's body or restamp its house", () => {
    const tampered = {
      ...stored(),
      messages: [{ id: "m2", body: "forged", at: "Oct 2, 10:00 AM", houseId: "H1" }],
    };
    const merged = mergeOtherOwnersThreadRowData(stored(), tampered);
    expect(merged.messages).toEqual(stored().messages);
  });

  it("cannot replay the derived root as a new turn", () => {
    const replay = { ...stored(), messages: [{ id: "t1-root", body: "root", at: "Oct 1, 9:00 AM" }] };
    const merged = mergeOtherOwnersThreadRowData(stored(), replay);
    expect((merged.messages as { id: string }[]).map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("carries the mailbox move the viewer made, and remembers where it came from", () => {
    const archived = { ...stored(), folder: "trash" };
    const merged = mergeOtherOwnersThreadRowData(stored(), archived);
    expect(merged.folder).toBe("trash");
    expect(merged.previousFolder).toBe("inbox");
  });

  it("ignores a folder the client invented", () => {
    const merged = mergeOtherOwnersThreadRowData(stored(), { ...stored(), folder: "somewhere-else" });
    expect(merged.folder).toBe("inbox");
  });

  it("never loses the stored identity fields to a body that omits them", () => {
    const merged = mergeOtherOwnersThreadRowData(stored(), { id: "t1", messages: [] });
    expect(merged.from).toBe("Resident");
    expect(merged.conversationKey).toBe("acct:r1");
    expect((merged.messages as unknown[]).length).toBe(2);
  });
});
