import { describe, expect, it } from "vitest";
import { mergeInboxRowsWithLocalTrash, type PersistedInboxThread } from "@/lib/portal-inbox-storage";

function thread(overrides: Partial<PersistedInboxThread> & Pick<PersistedInboxThread, "id" | "folder">): PersistedInboxThread {
  return {
    from: "Axis",
    email: "guest@example.com",
    subject: "Test",
    preview: "Preview",
    body: "Body",
    time: "Jan 1",
    unread: false,
    ...overrides,
  };
}

describe("mergeInboxRowsWithLocalTrash", () => {
  it("keeps local trash when server still has sent", () => {
    const server = [thread({ id: "a", folder: "sent" })];
    const local = [thread({ id: "a", folder: "trash", previousFolder: "sent" })];
    const merged = mergeInboxRowsWithLocalTrash(server, local);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.folder).toBe("trash");
    expect(merged[0]?.previousFolder).toBe("sent");
  });

  it("keeps local restore when server still has trash", () => {
    const server = [thread({ id: "a", folder: "trash" })];
    const local = [thread({ id: "a", folder: "sent" })];
    const merged = mergeInboxRowsWithLocalTrash(server, local);
    expect(merged[0]?.folder).toBe("sent");
  });

  it("excludes deleted ids from merge result", () => {
    const server = [
      thread({ id: "a", folder: "trash" }),
      thread({ id: "b", folder: "sent" }),
    ];
    const local = [thread({ id: "a", folder: "trash" })];
    const merged = mergeInboxRowsWithLocalTrash(server, local, { excludeIds: new Set(["a"]) });
    expect(merged.map((row) => row.id)).toEqual(["b"]);
  });

  it("includes local-only rows not yet on server", () => {
    const server = [thread({ id: "a", folder: "inbox" })];
    const local = [
      thread({ id: "a", folder: "inbox" }),
      thread({ id: "b", folder: "trash", previousFolder: "sent" }),
    ];
    const merged = mergeInboxRowsWithLocalTrash(server, local);
    expect(merged.map((row) => row.id).sort()).toEqual(["a", "b"]);
    expect(merged.find((row) => row.id === "b")?.folder).toBe("trash");
  });

  it("preserves previousFolder through trash merge", () => {
    const server = [thread({ id: "msg_1", folder: "inbox" })];
    const local = [thread({ id: "msg_1", folder: "trash", previousFolder: "inbox" })];
    const merged = mergeInboxRowsWithLocalTrash(server, local);
    expect(merged[0]?.previousFolder).toBe("inbox");
  });

  it("drops local-only rows when server is authoritative", () => {
    const server = [thread({ id: "a", folder: "inbox" })];
    const local = [thread({ id: "b", folder: "inbox" })];
    const merged = mergeInboxRowsWithLocalTrash(server, local, { serverAuthoritative: true });
    expect(merged.map((row) => row.id)).toEqual(["a"]);
  });

});
