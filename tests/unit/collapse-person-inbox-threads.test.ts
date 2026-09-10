import { describe, expect, it } from "vitest";
import {
  collapsePersonInboxThreads,
  inboxThreadMessages,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";

function thread(partial: Partial<PersistedInboxThread> & Pick<PersistedInboxThread, "id" | "email">): PersistedInboxThread {
  return {
    folder: "sent",
    from: "Manager",
    subject: "Hello",
    preview: "Hello",
    body: "Hello",
    time: "Jan 1, 10:00 AM",
    unread: false,
    ...partial,
  };
}

describe("collapsePersonInboxThreads", () => {
  it("merges historical notices for one owner's normalized phone and preserves every turn", () => {
    const rows = collapsePersonInboxThreads([
      thread({ id: "claw_lease_1000_a", email: "", ownerUserId: "manager-a", from: "(206) 555-0100", body: "First", folder: "inbox" }),
      thread({ id: "claw_resident_2000_b", email: "", ownerUserId: "manager-a", from: "+12065550100", body: "Second", folder: "inbox", time: "Jan 2, 10:00 AM", unread: true }),
      thread({ id: "claw_lease_3000_c", email: "", ownerUserId: "manager-b", from: "+12065550100", body: "Other manager", folder: "inbox" }),
    ], { mergeFolders: true });
    expect(rows).toHaveLength(2);
    const merged = rows.find((r) => r.ownerUserId === "manager-a")!;
    expect(inboxThreadMessages(merged).map((m) => m.body)).toEqual(["First", "Second"]);
    expect(merged.sourceThreadIds).toEqual(["claw_lease_1000_a", "claw_resident_2000_b"]);
    expect(merged.unread).toBe(true);
    expect(merged.messages?.every((message) => message.outbound === false)).toBe(true);
  });

  it("never guesses phone identity from a message or a display name", () => {
    const rows = collapsePersonInboxThreads([
      thread({ id: "claw_lease_1", email: "", ownerUserId: "a", from: "Dana", body: "+12065550100" }),
      thread({ id: "claw_lease_2", email: "", ownerUserId: "a", from: "Dana", body: "+12065550100" }),
      thread({ id: "claw_lease_3", email: "", from: "+12065550100" }),
      thread({ id: "claw_lease_4", email: "", from: "+12065550100" }),
    ]);
    expect(rows).toHaveLength(4);
  });

  it("merges multiple sent threads for the same resident email", () => {
    const rows = collapsePersonInboxThreads([
      thread({
        id: "payment_sent_mgr_1000_aaaa",
        email: "resident@test.com",
        body: "First reminder",
        time: "Jan 1, 10:00 AM",
      }),
      thread({
        id: "payment_sent_mgr_2000_bbbb",
        email: "resident@test.com",
        body: "Second reminder",
        time: "Jan 2, 10:00 AM",
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("payment_sent_mgr_2000_bbbb");
    const timeline = inboxThreadMessages(rows[0]!);
    expect(timeline.map((m) => m.body)).toEqual(["First reminder", "Second reminder"]);
    expect(new Set(timeline.map((m) => m.id)).size).toBe(timeline.length);
  });

  it("keeps separate threads for different residents", () => {
    const rows = collapsePersonInboxThreads([
      thread({ id: "t1", email: "a@test.com" }),
      thread({ id: "t2", email: "b@test.com" }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("merges inbox and sent rows for the same resident when mergeFolders is set", () => {
    const rows = collapsePersonInboxThreads(
      [
        thread({
          id: "sent_1",
          folder: "sent",
          email: "resident@test.com",
          body: "Reminder",
        }),
        thread({
          id: "inbox_1",
          folder: "inbox",
          email: "resident@test.com",
          body: "Thanks",
          from: "Resident",
        }),
      ],
      { mergeFolders: true },
    );
    expect(rows).toHaveLength(1);
    const timeline = inboxThreadMessages(rows[0]!);
    expect(timeline.map((m) => m.body)).toEqual(["Reminder", "Thanks"]);
    expect(new Set(timeline.map((m) => m.id)).size).toBe(timeline.length);
  });

  it("re-keys merged tour notification roots so React keys stay unique", () => {
    const rows = collapsePersonInboxThreads(
      [
        thread({
          id: "tour_inbox_1786191721716_46tz",
          folder: "inbox",
          email: "guest@example.com",
          body: "Your tour request was received.",
          from: "PropLane Tours",
        }),
        thread({
          id: "tour_inbox_1786191721717_abcd",
          folder: "inbox",
          email: "guest@example.com",
          body: "Your tour request was removed.",
          from: "PropLane Tours",
        }),
      ],
      { mergeFolders: true },
    );
    expect(rows).toHaveLength(1);
    const timeline = inboxThreadMessages(rows[0]!);
    expect(timeline.map((m) => m.body)).toEqual([
      "Your tour request was received.",
      "Your tour request was removed.",
    ]);
    expect(new Set(timeline.map((m) => m.id)).size).toBe(timeline.length);
  });

  it("deduplicates repeated merged roots from a previously collapsed thread", () => {
    const id = "tour_inbox_1787367693325_nghn";
    const rows = collapsePersonInboxThreads([
      thread({
        id,
        folder: "inbox",
        email: "guest@example.com",
        body: "Your tour request was received.",
        from: "PropLane Tours",
        messages: [
          { id: `merged:${id}-root`, from: "PropLane Tours", body: "Your tour was confirmed.", at: "Jan 2, 10:00 AM" },
          { id: `merged:${id}-root`, from: "PropLane Tours", body: "Your tour was confirmed.", at: "Jan 2, 10:00 AM" },
        ],
      }),
    ]);

    const timeline = inboxThreadMessages(rows[0]!);
    expect(timeline.map((message) => message.body)).toEqual([
      "Your tour request was received.",
      "Your tour was confirmed.",
    ]);
    expect(new Set(timeline.map((message) => message.id)).size).toBe(timeline.length);
  });
});
