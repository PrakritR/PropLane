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
