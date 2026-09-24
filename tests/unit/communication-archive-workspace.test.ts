// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MANAGER_SMS_ARCHIVED_STORAGE_KEY,
  mirrorManagerSmsArchivedFromServer,
} from "@/lib/manager-sms-archive.client";
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

describe("communication archive + workspace inbox sync", () => {
  beforeEach(() => {
    window.localStorage.removeItem(MANAGER_SMS_ARCHIVED_STORAGE_KEY);
  });
  afterEach(() => {
    window.localStorage.removeItem(MANAGER_SMS_ARCHIVED_STORAGE_KEY);
  });

  it("mirrors server SMS archive flags into local storage keys", () => {
    window.localStorage.setItem(MANAGER_SMS_ARCHIVED_STORAGE_KEY, JSON.stringify([]));
    mirrorManagerSmsArchivedFromServer([
      { conversationKey: "sms:2065550100", memberKeys: ["sms:2065550100:resident"], archived: true },
      { conversationKey: "sms:2065550200", archived: false },
    ]);
    const raw = window.localStorage.getItem(MANAGER_SMS_ARCHIVED_STORAGE_KEY);
    expect(raw).toBeTruthy();
    const ids = JSON.parse(raw ?? "[]") as string[];
    expect(ids).toContain("sms:2065550100");
    expect(ids).toContain("sms:2065550100:resident");
    expect(ids).not.toContain("sms:2065550200");
  });

  it("does not resurrect email threads omitted from a server-authoritative sync", () => {
    const server = [thread({ id: "kept", folder: "inbox" })];
    const local = [
      thread({ id: "kept", folder: "inbox" }),
      thread({ id: "stale-local", folder: "inbox" }),
    ];
    const merged = mergeInboxRowsWithLocalTrash(server, local, { serverAuthoritative: true });
    expect(merged.map((row) => row.id)).toEqual(["kept"]);
  });
});
