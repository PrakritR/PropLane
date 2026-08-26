// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveManagerSmsConversation,
  loadManagerSmsArchivedIds,
  MANAGER_SMS_ARCHIVED_STORAGE_KEY,
  MANAGER_SMS_ARCHIVE_CHANGED_EVENT,
  restoreManagerSmsConversation,
} from "@/lib/manager-sms-archive.client";

describe("manager SMS archive storage", () => {
  afterEach(() => {
    window.localStorage.removeItem(MANAGER_SMS_ARCHIVED_STORAGE_KEY);
  });

  it("archives and restores a conversation id", () => {
    expect(loadManagerSmsArchivedIds().size).toBe(0);
    archiveManagerSmsConversation("owner:resident:abc");
    expect(loadManagerSmsArchivedIds().has("owner:resident:abc")).toBe(true);
    restoreManagerSmsConversation("owner:resident:abc");
    expect(loadManagerSmsArchivedIds().has("owner:resident:abc")).toBe(false);
  });

  it("dispatches a change event when archive state updates", () => {
    let fired = 0;
    const handler = () => {
      fired += 1;
    };
    window.addEventListener(MANAGER_SMS_ARCHIVE_CHANGED_EVENT, handler);
    archiveManagerSmsConversation("thread-1");
    restoreManagerSmsConversation("thread-1");
    window.removeEventListener(MANAGER_SMS_ARCHIVE_CHANGED_EVENT, handler);
    expect(fired).toBe(2);
  });
});
