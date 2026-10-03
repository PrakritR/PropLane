import { describe, expect, it } from "vitest";
import {
  foldTextRowIntoSoleWorkspace,
  mergeUnifiedInboxItems,
  type UnifiedInboxListItem,
} from "@/lib/unified-inbox-merge";
import { collapsePersonInboxThreads, type PersistedInboxThread } from "@/lib/portal-inbox-storage";
import { buildInboxMessageTimeline } from "@/lib/inbox-message-timeline";
import { conversationAddressLabel, conversationHouseLabels } from "@/lib/communication-row-meta";
import { conversationJoinKey } from "@/lib/communication/conversation-key";
import type { InboxBubbleMessage } from "@/components/portal/portal-inbox-ui";

/**
 * The list side of "one conversation per person": rows that share a
 * conversation key are ONE row, whatever channel or thread type each started
 * as; different workspaces and ambiguous identities never fold.
 */

const W1 = "w1";
const W2 = "w2";

function item(over: Partial<UnifiedInboxListItem> & Pick<UnifiedInboxListItem, "key" | "channel">): UnifiedInboxListItem {
  return { threadId: over.key, name: "Resident", preview: "", time: "", unread: false, sortMs: 1, ...over };
}

describe("mergeUnifiedInboxItems joins on the conversation key", () => {
  it("an in-app thread and a text conversation with the same key are one row, even with no shared email", () => {
    const key = conversationJoinKey(W1, "acct:r1")!;
    const rows = mergeUnifiedInboxItems([
      item({ key: "email:a", channel: "email", sortMs: 5, joinKeys: [key] }),
      item({ key: "sms:b", channel: "sms", sortMs: 9, joinKeys: [key] }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channels).toEqual(["sms", "email"]);
    expect(rows[0]!.memberKeys).toEqual(expect.arrayContaining(["email:a", "sms:b"]));
  });

  it("still joins on the email person key (the older join keeps working)", () => {
    const rows = mergeUnifiedInboxItems([
      item({ key: "email:a", channel: "email", personKey: "r@x.co", joinKeys: [conversationJoinKey(W1, "mail:r@x.co")!] }),
      item({ key: "sms:b", channel: "sms", personKey: "r@x.co" }),
    ]);
    expect(rows).toHaveLength(1);
  });

  it("the same person in two workspaces is two rows", () => {
    const rows = mergeUnifiedInboxItems([
      item({ key: "email:a", channel: "email", joinKeys: [conversationJoinKey(W1, "acct:r1")!] }),
      item({ key: "email:b", channel: "email", joinKeys: [conversationJoinKey(W2, "acct:r1")!] }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("a flagged (ambiguous) row never joins on an email it merely shares", () => {
    const rows = mergeUnifiedInboxItems([
      item({ key: "email:a", channel: "email", personKey: "r@x.co", identityFlag: true, joinKeys: [conversationJoinKey(W1, "tel:+15105551234")!] }),
      item({ key: "email:b", channel: "email", personKey: "r@x.co", joinKeys: [conversationJoinKey(W1, "acct:r1")!] }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("a flagged row still joins another row that carries its OWN key", () => {
    const own = conversationJoinKey(W1, "tel:+15105551234")!;
    const rows = mergeUnifiedInboxItems([
      item({ key: "email:a", channel: "email", identityFlag: true, joinKeys: [own] }),
      item({ key: "sms:b", channel: "sms", joinKeys: [own] }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.identityFlag).toBe(true);
  });

  it("carries every house and every old thread id of the folded rows", () => {
    const key = conversationJoinKey(W1, "acct:r1")!;
    const rows = mergeUnifiedInboxItems([
      item({ key: "email:a", channel: "email", joinKeys: [key], houseLabels: ["4709A 8th Ave"], aliasThreadIds: ["old-1"] }),
      item({ key: "email:b", channel: "email", joinKeys: [key], houseLabels: ["12 Cedar St"], aliasThreadIds: ["old-2"] }),
    ]);
    expect(rows[0]!.houseLabels).toEqual(["4709A 8th Ave", "12 Cedar St"]);
    expect(rows[0]!.aliasThreadIds).toEqual(["old-1", "old-2"]);
  });
});

describe("foldTextRowIntoSoleWorkspace", () => {
  const email = (workspace: string) =>
    item({ key: `email:${workspace}`, channel: "email", joinKeys: [conversationJoinKey(workspace, `ws:${workspace}`)!] });
  const sms = item({ key: "sms:text", channel: "sms" });

  it("'Text messages' stops being a separate row when there is exactly one workspace", () => {
    const rows = mergeUnifiedInboxItems([email(W1), ...foldTextRowIntoSoleWorkspace([email(W1)], [sms])]);
    expect(rows).toHaveLength(1);
  });

  it("with several workspaces the text stream stays separate rather than be guessed onto one", () => {
    const folded = foldTextRowIntoSoleWorkspace([email(W1), email(W2)], [sms]);
    expect(folded[0]!.joinKeys).toBeUndefined();
  });
});

function thread(over: Partial<PersistedInboxThread> & Pick<PersistedInboxThread, "id">): PersistedInboxThread {
  return {
    folder: "inbox",
    from: "Resident",
    email: "r@x.co",
    subject: "s",
    preview: "p",
    body: "b",
    time: "Jan 1, 10:00 AM",
    unread: false,
    ...over,
  };
}

describe("collapsePersonInboxThreads groups by conversation key", () => {
  it("folds rows with one key even when their stored emails differ", () => {
    const rows = collapsePersonInboxThreads(
      [
        thread({ id: "a", email: "r@x.co", conversationKey: "acct:r1", workspaceId: W1, body: "first", time: "Jan 1, 10:00 AM" }),
        thread({ id: "b", email: "alt@x.co", conversationKey: "acct:r1", workspaceId: W1, body: "second", time: "Jan 2, 10:00 AM" }),
      ],
      { mergeFolders: true },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceThreadIds).toEqual(["a", "b"]);
  });

  it("never folds the same key across workspaces", () => {
    const rows = collapsePersonInboxThreads(
      [
        thread({ id: "a", conversationKey: "acct:r1", workspaceId: W1 }),
        thread({ id: "b", conversationKey: "acct:r1", workspaceId: W2 }),
      ],
      { mergeFolders: true },
    );
    expect(rows).toHaveLength(2);
  });

  it("an unkeyed legacy row with a keyed row's address joins it", () => {
    const rows = collapsePersonInboxThreads(
      [
        thread({ id: "keyed", conversationKey: "acct:r1", workspaceId: W1, time: "Jan 2, 10:00 AM" }),
        thread({ id: "legacy", time: "Jan 1, 10:00 AM" }),
      ],
      { mergeFolders: true },
    );
    expect(rows).toHaveLength(1);
  });

  it("keyedOnly (resident / vendor side) leaves unkeyed rows exactly as they were", () => {
    const rows = collapsePersonInboxThreads(
      [thread({ id: "u1" }), thread({ id: "u2" }), thread({ id: "k1", conversationKey: "ws:w1", workspaceId: W1 }), thread({ id: "k2", conversationKey: "ws:w1", workspaceId: W1 })],
      { mergeFolders: true, keyedOnly: true },
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining(["u1", "u2"]));
  });

  it("every turn keeps its house through the fold, and the merged row spans both houses", () => {
    const rows = collapsePersonInboxThreads(
      [
        thread({ id: "a", conversationKey: "acct:r1", workspaceId: W1, body: "one", rootAt: "Jan 1, 9:00 AM", rootHouseId: "H1", rootHouseLabel: "4709A 8th Ave", time: "Jan 1, 9:00 AM", houses: [{ propertyId: "H1", label: "4709A 8th Ave" }] }),
        thread({ id: "b", conversationKey: "acct:r1", workspaceId: W1, body: "two", rootAt: "Jan 2, 9:00 AM", rootHouseId: "H2", rootHouseLabel: "12 Cedar St", time: "Jan 2, 9:00 AM", houses: [{ propertyId: "H2", label: "12 Cedar St" }] }),
      ],
      { mergeFolders: true },
    );
    expect(rows[0]!.houses?.map((h) => h.propertyId)).toEqual(["H1", "H2"]);
    expect(rows[0]!.rootHouseId).toBe("H1");
    expect((rows[0]!.messages ?? [])[0]?.houseId).toBe("H2");
  });
});

describe("a turn names its house only when the conversation spans houses", () => {
  const bubble = (id: string, houseLabel?: string): InboxBubbleMessage => ({
    id,
    author: "x",
    body: id,
    at: "Jan 1, 9:00 AM",
    direction: "inbound",
    ...(houseLabel ? { houseLabel } : {}),
  });

  it("one house: no house tags", () => {
    const items = buildInboxMessageTimeline([bubble("a", "H1"), bubble("b", "H1")]);
    expect(items.filter((i) => i.type === "message").every((i) => i.type === "message" && !i.showHouse)).toBe(true);
  });

  it("two houses: each turn names its own", () => {
    const items = buildInboxMessageTimeline([bubble("a", "H1"), bubble("b", "H2")]);
    const flags = items.flatMap((i) => (i.type === "message" ? [i.showHouse] : []));
    expect(flags).toEqual([true, true]);
  });

  it("a turn with no house never invents one", () => {
    const items = buildInboxMessageTimeline([bubble("a", "H1"), bubble("b"), bubble("c", "H2")]);
    const flags = items.flatMap((i) => (i.type === "message" ? [i.showHouse] : []));
    expect(flags).toEqual([true, false, true]);
  });
});

describe("row house label", () => {
  const houses = [
    { propertyId: "H1", label: "4709A 8th Ave NE, Seattle" },
    { propertyId: "H2", label: "12 Cedar St, Seattle" },
  ];
  it("names the first house and counts the rest", () => {
    expect(conversationHouseLabels(houses)).toEqual(["4709A 8th Ave NE", "12 Cedar St"]);
    expect(conversationAddressLabel("4709A 8th Ave NE", houses)).toBe("4709A 8th Ave NE +1");
  });
  it("one house keeps the label it always had", () => {
    expect(conversationAddressLabel("Fir Lofts", [houses[0]!])).toBe("Fir Lofts");
    expect(conversationAddressLabel(undefined, undefined)).toBeUndefined();
  });
});
